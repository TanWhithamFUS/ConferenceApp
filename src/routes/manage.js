// Management screens. Admins (Steubenville Conferences staff) manage everything;
// editors (partners / site staff) manage only the conferences they are assigned to.
const express = require('express');
const QRCode = require('qrcode');
const { db, transaction } = require('../db');
const auth = require('../auth');
const push = require('../push');
const data = require('../data');
const { KINDS, slugify, toArray, isDate, isTime, eventDays, safeUrl, parseIds } = require('../util');

const router = express.Router();
const BASE_URL = () => (process.env.BASE_URL || '').replace(/\/$/, '');

function back(res, path, msg) {
  res.redirect(`${path}${msg ? `${path.includes('?') ? '&' : '?'}ok=${encodeURIComponent(msg)}` : ''}`);
}

function fail(res, status, message) {
  return res.status(status).render('error', { title: 'Something’s not right', message });
}

function str(v, max = 5000) {
  return String(v ?? '').trim().slice(0, max);
}

/* ---------- Login / setup ---------- */

function userCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

router.get('/setup', (req, res) => {
  if (userCount() > 0) return res.redirect('/login');
  res.render('manage/setup', { title: 'Set up', error: null });
});

router.post('/setup', (req, res) => {
  if (userCount() > 0) return res.redirect('/login');
  const name = str(req.body.name, 100);
  const email = str(req.body.email, 200).toLowerCase();
  const password = String(req.body.password || '');
  if (!name || !email.includes('@') || password.length < 8) {
    return res.render('manage/setup', { title: 'Set up', error: 'Enter a name, email, and a password of at least 8 characters.' });
  }
  const r = db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, 'admin')")
    .run(email, name, auth.hashPassword(password));
  auth.setSession(res, Number(r.lastInsertRowid));
  res.redirect('/manage');
});

router.get('/login', (req, res) => {
  if (userCount() === 0) return res.redirect('/setup');
  if (req.user) return res.redirect('/manage');
  res.render('manage/login', { title: 'Sign in', error: null, email: '', next: str(req.query.next, 300) });
});

router.post('/login', (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  const next = str(req.body.next, 300);
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/manage';
  if (auth.loginThrottled(`${req.ip}|${email}`)) {
    return res.status(429).render('manage/login', { title: 'Sign in', error: 'Too many attempts. Try again in 15 minutes.', email, next });
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !auth.verifyPassword(String(req.body.password || ''), user.password_hash)) {
    return res.status(401).render('manage/login', { title: 'Sign in', error: 'That email and password don’t match.', email, next });
  }
  auth.setSession(res, user.id);
  res.redirect(safeNext);
});

router.post('/logout', (req, res) => {
  auth.clearSession(res);
  res.redirect('/login');
});

/* ---------- Everything below requires a login ---------- */

router.use('/manage', auth.requireLogin, (req, res, next) => {
  res.locals.flash = str(req.query.ok, 300);
  res.locals.isAdmin = req.user.role === 'admin';
  res.locals.KINDS = KINDS;
  next();
});

router.get('/manage', (req, res) => {
  const events = data.eventsForUser(req.user).map((e) => ({
    ...e,
    subscribers: push.subscriberCount(e.id),
    sessions: db.prepare('SELECT COUNT(*) AS n FROM schedule_items WHERE event_id = ?').get(e.id).n,
  }));
  res.render('manage/dashboard', { title: 'Dashboard', events });
});

router.get('/manage/account', (req, res) => {
  res.render('manage/account', { title: 'My account', error: null });
});

router.post('/manage/account', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const current = String(req.body.current || '');
  const next = String(req.body.password || '');
  if (!auth.verifyPassword(current, user.password_hash)) {
    return res.render('manage/account', { title: 'My account', error: 'Your current password is incorrect.' });
  }
  if (next.length < 8) {
    return res.render('manage/account', { title: 'My account', error: 'New password must be at least 8 characters.' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(next), user.id);
  back(res, '/manage/account', 'Password updated.');
});

/* ---------- Events ---------- */

const ADMIN_EVENT_FIELDS = ['name', 'audience', 'operated_by', 'partner_name', 'start_date', 'end_date'];
const SHARED_EVENT_FIELDS = ['city', 'venue', 'address', 'map_url', 'registration_url', 'website_url',
  'welcome', 'contact_name', 'contact_email', 'contact_phone'];
const URL_FIELDS = new Set(['map_url', 'registration_url', 'website_url']);

function readEventForm(body, fields) {
  const out = {};
  for (const f of fields) {
    out[f] = URL_FIELDS.has(f) ? safeUrl(body[f]) : str(body[f], f === 'welcome' ? 5000 : 200);
  }
  if ('audience' in out && !['youth', 'adult'].includes(out.audience)) out.audience = 'youth';
  if ('operated_by' in out && !['franciscan', 'partner'].includes(out.operated_by)) out.operated_by = 'franciscan';
  return out;
}

function validateEventDates(e) {
  if (!isDate(e.start_date) || !isDate(e.end_date)) return 'Start and end dates are required.';
  if (e.end_date < e.start_date) return 'End date must be on or after the start date.';
  return null;
}

function uniqueSlug(base, excludeId = 0) {
  let slug = slugify(base);
  for (let i = 2; db.prepare('SELECT 1 FROM events WHERE slug = ? AND id != ?').get(slug, excludeId); i++) {
    slug = `${slugify(base)}-${i}`;
  }
  return slug;
}

router.get('/manage/events/new', auth.requireAdmin, (req, res) => {
  res.render('manage/event-new', { title: 'New conference', error: null, form: { audience: req.query.audience || 'youth', operated_by: 'franciscan' } });
});

router.post('/manage/events/new', auth.requireAdmin, (req, res) => {
  const form = readEventForm(req.body, [...ADMIN_EVENT_FIELDS, 'city']);
  const error = !form.name ? 'Name is required.' : validateEventDates(form);
  if (error) return res.render('manage/event-new', { title: 'New conference', error, form });
  const slug = uniqueSlug(str(req.body.slug, 60) || form.name);
  const r = db.prepare(`INSERT INTO events (slug, name, audience, operated_by, partner_name, start_date, end_date, city)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(slug, form.name, form.audience, form.operated_by, form.partner_name, form.start_date, form.end_date, form.city);
  back(res, `/manage/events/${r.lastInsertRowid}`, 'Conference created. Fill in the details, then publish it.');
});

// Loads the event and checks the user may edit it.
router.param('eventId', (req, res, next, id) => {
  const event = data.eventById(Number(id));
  if (!event) return fail(res, 404, 'That conference doesn’t exist.');
  if (!auth.canEditEvent(req.user, event.id)) return fail(res, 403, 'You don’t have access to this conference.');
  req.event = event;
  res.locals.event = event;
  next();
});

function eventPage(res, view, locals) {
  res.render(`manage/${view}`, { title: res.locals.event.name, ...locals });
}

router.get('/manage/events/:eventId', (req, res) => {
  eventPage(res, 'event-details', { tab: 'details', error: null, form: req.event });
});

router.post('/manage/events/:eventId', (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const fields = isAdmin ? [...ADMIN_EVENT_FIELDS, ...SHARED_EVENT_FIELDS] : SHARED_EVENT_FIELDS;
  const form = readEventForm(req.body, fields);
  if (isAdmin) {
    const error = !form.name ? 'Name is required.' : validateEventDates(form);
    if (error) return eventPage(res, 'event-details', { tab: 'details', error, form: { ...req.event, ...form } });
    form.slug = uniqueSlug(str(req.body.slug, 60) || form.name, req.event.id);
    form.published = req.body.published ? 1 : 0;
  }
  const cols = Object.keys(form);
  db.prepare(`UPDATE events SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
    .run(...cols.map((c) => form[c]), req.event.id);
  back(res, `/manage/events/${req.event.id}`, 'Saved.');
});

router.post('/manage/events/:eventId/delete', auth.requireAdmin, (req, res) => {
  if (str(req.body.confirm) !== req.event.slug) {
    return back(res, `/manage/events/${req.event.id}`, 'Not deleted — type the conference’s web address to confirm.');
  }
  db.prepare('DELETE FROM events WHERE id = ?').run(req.event.id);
  back(res, '/manage', `Deleted “${req.event.name}”.`);
});

/* ---------- Schedule ---------- */

// Editors can move core-program sessions (time/room) but not change their content.
function readScheduleForm(body, event, item, isAdmin) {
  const locked = item && item.template_item_id !== null && !isAdmin;
  const f = {
    date: str(body.date, 10),
    start_time: str(body.start_time, 5),
    end_time: str(body.end_time, 5),
    location: str(body.location, 200),
  };
  if (!locked) {
    f.title = str(body.title, 200);
    f.description = str(body.description, 5000);
    f.kind = KINDS[body.kind] ? body.kind : 'session';
    const lineup = new Set(data.speakersForEvent(event.id).map((s) => s.id));
    f.speaker_ids = JSON.stringify(toArray(body.speaker_ids).map(Number).filter((id) => lineup.has(id)));
  }
  let error = null;
  if (!locked && !f.title) error = 'Title is required.';
  else if (!isDate(f.date) || f.date < event.start_date || f.date > event.end_date) error = 'Pick one of the conference days.';
  else if (!isTime(f.start_time)) error = 'Start time is required.';
  else if (f.end_time && (!isTime(f.end_time) || f.end_time < f.start_time)) error = 'End time must be after the start time.';
  return { f, error, locked };
}

function schedulePage(req, res, extra = {}) {
  eventPage(res, 'event-schedule', {
    tab: 'schedule',
    days: data.groupByDate(data.scheduleForEvent(req.event.id)),
    dayOptions: eventDays(req.event),
    lineup: data.speakersForEvent(req.event.id),
    error: null,
    form: { date: req.event.start_date, kind: 'session' },
    ...extra,
  });
}

router.get('/manage/events/:eventId/schedule', (req, res) => schedulePage(req, res));

router.post('/manage/events/:eventId/schedule', (req, res) => {
  const { f, error } = readScheduleForm(req.body, req.event, null, req.user.role === 'admin');
  if (error) return schedulePage(req, res, { error, form: { ...f, speaker_ids: toArray(req.body.speaker_ids).map(Number) } });
  db.prepare(`INSERT INTO schedule_items (event_id, date, start_time, end_time, title, description, location, kind, speaker_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.event.id, f.date, f.start_time, f.end_time, f.title, f.description, f.location, f.kind, f.speaker_ids);
  back(res, `/manage/events/${req.event.id}/schedule`, `Added “${f.title}”.`);
});

function loadItem(req, res, table) {
  const item = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND event_id = ?`).get(Number(req.params.itemId), req.event.id);
  if (!item) fail(res, 404, 'That item no longer exists.');
  return item;
}

router.get('/manage/events/:eventId/schedule/:itemId', (req, res) => {
  const item = loadItem(req, res, 'schedule_items');
  if (!item) return;
  eventPage(res, 'schedule-edit', {
    tab: 'schedule',
    item,
    form: { ...item, speaker_ids: parseIds(item.speaker_ids) },
    locked: item.template_item_id !== null && req.user.role !== 'admin',
    dayOptions: eventDays(req.event),
    lineup: data.speakersForEvent(req.event.id),
    error: null,
  });
});

router.post('/manage/events/:eventId/schedule/:itemId', (req, res) => {
  const item = loadItem(req, res, 'schedule_items');
  if (!item) return;
  const { f, error, locked } = readScheduleForm(req.body, req.event, item, req.user.role === 'admin');
  if (error) {
    return eventPage(res, 'schedule-edit', {
      tab: 'schedule', item, locked, error,
      form: { ...item, ...f, speaker_ids: toArray(req.body.speaker_ids).map(Number) },
      dayOptions: eventDays(req.event), lineup: data.speakersForEvent(req.event.id),
    });
  }
  const cols = Object.keys(f);
  db.prepare(`UPDATE schedule_items SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
    .run(...cols.map((c) => f[c]), item.id);
  back(res, `/manage/events/${req.event.id}/schedule`, 'Schedule updated.');
});

router.post('/manage/events/:eventId/schedule/:itemId/delete', (req, res) => {
  const item = loadItem(req, res, 'schedule_items');
  if (!item) return;
  if (item.template_item_id !== null && req.user.role !== 'admin') {
    return fail(res, 403, 'Core program sessions can only be removed by Steubenville Conferences staff.');
  }
  db.prepare('DELETE FROM schedule_items WHERE id = ?').run(item.id);
  back(res, `/manage/events/${req.event.id}/schedule`, 'Removed.');
});

/* ---------- Info & FAQ ---------- */

function infoPage(req, res, extra = {}) {
  eventPage(res, 'event-info', {
    tab: 'info',
    items: data.infoForEvent(req.event.id),
    error: null,
    form: { category: 'info' },
    ...extra,
  });
}

function readInfoForm(body) {
  return {
    category: body.category === 'faq' ? 'faq' : 'info',
    title: str(body.title, 200),
    body: str(body.body, 10000),
    sort: Number.parseInt(body.sort, 10) || 0,
  };
}

router.get('/manage/events/:eventId/info', (req, res) => infoPage(req, res));

router.post('/manage/events/:eventId/info', (req, res) => {
  const f = readInfoForm(req.body);
  if (!f.title) return infoPage(req, res, { error: 'Title is required.', form: f });
  db.prepare('INSERT INTO info_items (event_id, category, title, body, sort) VALUES (?, ?, ?, ?, ?)')
    .run(req.event.id, f.category, f.title, f.body, f.sort);
  back(res, `/manage/events/${req.event.id}/info`, `Added “${f.title}”.`);
});

router.get('/manage/events/:eventId/info/:itemId', (req, res) => {
  const item = loadItem(req, res, 'info_items');
  if (!item) return;
  eventPage(res, 'info-edit', { tab: 'info', item, form: item, error: null });
});

router.post('/manage/events/:eventId/info/:itemId', (req, res) => {
  const item = loadItem(req, res, 'info_items');
  if (!item) return;
  const f = readInfoForm(req.body);
  if (!f.title) return eventPage(res, 'info-edit', { tab: 'info', item, form: f, error: 'Title is required.' });
  db.prepare('UPDATE info_items SET category = ?, title = ?, body = ?, sort = ? WHERE id = ?')
    .run(f.category, f.title, f.body, f.sort, item.id);
  back(res, `/manage/events/${req.event.id}/info`, 'Saved.');
});

router.post('/manage/events/:eventId/info/:itemId/delete', (req, res) => {
  const item = loadItem(req, res, 'info_items');
  if (!item) return;
  db.prepare('DELETE FROM info_items WHERE id = ?').run(item.id);
  back(res, `/manage/events/${req.event.id}/info`, 'Removed.');
});

/* ---------- Announcements & push ---------- */

router.get('/manage/events/:eventId/announcements', (req, res) => {
  eventPage(res, 'event-announcements', {
    tab: 'announcements',
    announcements: data.announcementsForEvent(req.event.id, 100),
    subscribers: push.subscriberCount(req.event.id),
    error: null,
    form: { send_push: '1' },
  });
});

async function postAnnouncement(event, user, { title, body, sendPush, fromCentral }) {
  const r = db.prepare('INSERT INTO announcements (event_id, title, body, from_central, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(event.id, title, body, fromCentral ? 1 : 0, user.id);
  let delivered = 0;
  if (sendPush && event.published) {
    delivered = await push.sendToEvent(event.id, {
      title: `${title}`,
      body: body.slice(0, 180),
      url: `/e/${event.slug}/news`,
    });
    db.prepare('UPDATE announcements SET pushed_count = ? WHERE id = ?').run(delivered, r.lastInsertRowid);
  }
  return delivered;
}

router.post('/manage/events/:eventId/announcements', async (req, res) => {
  const title = str(req.body.title, 120);
  const body = str(req.body.body, 2000);
  if (!title) {
    return eventPage(res, 'event-announcements', {
      tab: 'announcements', announcements: data.announcementsForEvent(req.event.id, 100),
      subscribers: push.subscriberCount(req.event.id), error: 'Title is required.', form: req.body,
    });
  }
  const delivered = await postAnnouncement(req.event, req.user, {
    title, body, sendPush: !!req.body.send_push, fromCentral: req.user.role === 'admin' && !!req.body.from_central,
  });
  const note = req.body.send_push
    ? (req.event.published ? ` Notification sent to ${delivered} device${delivered === 1 ? '' : 's'}.` : ' (No notification sent — this conference isn’t published yet.)')
    : '';
  back(res, `/manage/events/${req.event.id}/announcements`, `Announcement posted.${note}`);
});

router.post('/manage/events/:eventId/announcements/:itemId/delete', (req, res) => {
  const item = loadItem(req, res, 'announcements');
  if (!item) return;
  if (item.from_central && req.user.role !== 'admin') return fail(res, 403, 'Only central staff can remove their announcements.');
  db.prepare('DELETE FROM announcements WHERE id = ?').run(item.id);
  back(res, `/manage/events/${req.event.id}/announcements`, 'Announcement removed.');
});

/* ---------- Speaker lineup (admin) ---------- */

router.get('/manage/events/:eventId/speakers', auth.requireAdmin, (req, res) => {
  const selected = new Set(data.speakersForEvent(req.event.id).map((s) => s.id));
  eventPage(res, 'event-speakers', {
    tab: 'speakers',
    speakers: db.prepare('SELECT * FROM speakers ORDER BY name').all(),
    selected,
  });
});

router.post('/manage/events/:eventId/speakers', auth.requireAdmin, (req, res) => {
  const ids = toArray(req.body.speaker_ids).map(Number).filter(Boolean);
  transaction(() => {
    db.prepare('DELETE FROM event_speakers WHERE event_id = ?').run(req.event.id);
    for (const id of ids) {
      db.prepare('INSERT OR IGNORE INTO event_speakers (event_id, speaker_id) SELECT ?, id FROM speakers WHERE id = ?').run(req.event.id, id);
    }
  });
  back(res, `/manage/events/${req.event.id}/speakers`, 'Speaker lineup saved.');
});

/* ---------- Editors (admin) ---------- */

router.get('/manage/events/:eventId/editors', auth.requireAdmin, (req, res) => {
  eventPage(res, 'event-editors', { tab: 'editors', editors: data.editorsForEvent(req.event.id), created: null, error: null });
});

router.post('/manage/events/:eventId/editors', auth.requireAdmin, (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  const name = str(req.body.name, 100);
  if (!email.includes('@')) {
    return eventPage(res, 'event-editors', { tab: 'editors', editors: data.editorsForEvent(req.event.id), created: null, error: 'Enter a valid email address.' });
  }
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  let created = null;
  if (!user) {
    const password = auth.generatePassword();
    const r = db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, 'editor')")
      .run(email, name || email, auth.hashPassword(password));
    user = { id: Number(r.lastInsertRowid), email };
    created = { email, password };
  }
  db.prepare('INSERT OR IGNORE INTO event_editors (user_id, event_id) VALUES (?, ?)').run(user.id, req.event.id);
  if (!created) return back(res, `/manage/events/${req.event.id}/editors`, `${email} can now edit this conference.`);
  eventPage(res, 'event-editors', { tab: 'editors', editors: data.editorsForEvent(req.event.id), created, error: null });
});

router.post('/manage/events/:eventId/editors/:userId/remove', auth.requireAdmin, (req, res) => {
  db.prepare('DELETE FROM event_editors WHERE user_id = ? AND event_id = ?').run(Number(req.params.userId), req.event.id);
  back(res, `/manage/events/${req.event.id}/editors`, 'Access removed.');
});

/* ---------- QR code ---------- */

function eventUrl(req, event) {
  return `${BASE_URL() || `${req.protocol}://${req.get('host')}`}/e/${event.slug}`;
}

router.get('/manage/events/:eventId/qr', async (req, res) => {
  const url = eventUrl(req, req.event);
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#1f4d3a', light: '#ffffff' } });
  eventPage(res, 'event-qr', { tab: 'qr', url, svg });
});

router.get('/manage/events/:eventId/qr.svg', async (req, res) => {
  const svg = await QRCode.toString(eventUrl(req, req.event), { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').attachment(`${req.event.slug}-qr.svg`).send(svg);
});

router.get('/manage/events/:eventId/qr.png', async (req, res) => {
  const png = await QRCode.toBuffer(eventUrl(req, req.event), { width: 1200, margin: 2, errorCorrectionLevel: 'M' });
  res.type('image/png').attachment(`${req.event.slug}-qr.png`).send(png);
});

/* ---------- Speakers library (admin) ---------- */

function readSpeakerForm(body) {
  return {
    name: str(body.name, 120),
    role_title: str(body.role_title, 200),
    bio: str(body.bio, 5000),
    photo_url: safeUrl(body.photo_url),
  };
}

router.get('/manage/speakers', auth.requireAdmin, (req, res) => {
  const speakers = db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM event_speakers es WHERE es.speaker_id = s.id) AS events
    FROM speakers s ORDER BY s.name`).all();
  res.render('manage/speakers', { title: 'Speakers', speakers, form: {}, error: null });
});

router.post('/manage/speakers', auth.requireAdmin, (req, res) => {
  const f = readSpeakerForm(req.body);
  if (!f.name) return back(res, '/manage/speakers', 'Name is required.');
  db.prepare('INSERT INTO speakers (name, role_title, bio, photo_url) VALUES (?, ?, ?, ?)').run(f.name, f.role_title, f.bio, f.photo_url);
  back(res, '/manage/speakers', `Added ${f.name}.`);
});

router.get('/manage/speakers/:id', auth.requireAdmin, (req, res) => {
  const speaker = db.prepare('SELECT * FROM speakers WHERE id = ?').get(Number(req.params.id));
  if (!speaker) return fail(res, 404, 'Speaker not found.');
  res.render('manage/speaker-edit', { title: speaker.name, speaker, form: speaker, error: null });
});

router.post('/manage/speakers/:id', auth.requireAdmin, (req, res) => {
  const speaker = db.prepare('SELECT * FROM speakers WHERE id = ?').get(Number(req.params.id));
  if (!speaker) return fail(res, 404, 'Speaker not found.');
  const f = readSpeakerForm(req.body);
  if (!f.name) return res.render('manage/speaker-edit', { title: speaker.name, speaker, form: f, error: 'Name is required.' });
  db.prepare('UPDATE speakers SET name = ?, role_title = ?, bio = ?, photo_url = ? WHERE id = ?')
    .run(f.name, f.role_title, f.bio, f.photo_url, speaker.id);
  back(res, '/manage/speakers', 'Saved.');
});

router.post('/manage/speakers/:id/delete', auth.requireAdmin, (req, res) => {
  db.prepare('DELETE FROM speakers WHERE id = ?').run(Number(req.params.id));
  back(res, '/manage/speakers', 'Speaker removed.');
});

/* ---------- Core programs (admin) ---------- */

router.get('/manage/programs', auth.requireAdmin, (req, res) => {
  const templates = db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM template_items ti WHERE ti.template_id = t.id) AS items
    FROM templates t ORDER BY t.audience DESC, t.name`).all();
  res.render('manage/programs', { title: 'Core programs', templates });
});

router.post('/manage/programs', auth.requireAdmin, (req, res) => {
  const name = str(req.body.name, 120);
  const audience = req.body.audience === 'adult' ? 'adult' : 'youth';
  if (!name) return back(res, '/manage/programs', 'Name is required.');
  const r = db.prepare('INSERT INTO templates (name, audience) VALUES (?, ?)').run(name, audience);
  back(res, `/manage/programs/${r.lastInsertRowid}`, 'Program created. Add its sessions below.');
});

function loadTemplate(req, res) {
  const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(Number(req.params.id));
  if (!t) fail(res, 404, 'Program not found.');
  return t;
}

function programPage(req, res, template, extra = {}) {
  const items = db.prepare('SELECT * FROM template_items WHERE template_id = ? ORDER BY day_number, start_time, id').all(template.id);
  const events = db.prepare('SELECT * FROM events WHERE audience = ? ORDER BY start_date, name').all(template.audience)
    .map((e) => ({
      ...e,
      applied: db.prepare(`SELECT COUNT(*) AS n FROM schedule_items si JOIN template_items ti ON ti.id = si.template_item_id
        WHERE si.event_id = ? AND ti.template_id = ?`).get(e.id, template.id).n,
    }));
  res.render('manage/program-edit', { title: template.name, template, items, events, error: null, form: { day_number: 1, kind: 'session' }, ...extra });
}

router.get('/manage/programs/:id', auth.requireAdmin, (req, res) => {
  const t = loadTemplate(req, res);
  if (t) programPage(req, res, t);
});

function readTemplateItem(body) {
  return {
    day_number: Math.min(14, Math.max(1, Number.parseInt(body.day_number, 10) || 1)),
    start_time: str(body.start_time, 5),
    end_time: str(body.end_time, 5),
    title: str(body.title, 200),
    description: str(body.description, 5000),
    kind: KINDS[body.kind] ? body.kind : 'session',
  };
}

function templateItemError(f) {
  if (!f.title) return 'Title is required.';
  if (!isTime(f.start_time)) return 'Start time is required.';
  if (f.end_time && (!isTime(f.end_time) || f.end_time < f.start_time)) return 'End time must be after the start time.';
  return null;
}

router.post('/manage/programs/:id/items', auth.requireAdmin, (req, res) => {
  const t = loadTemplate(req, res);
  if (!t) return;
  const f = readTemplateItem(req.body);
  const error = templateItemError(f);
  if (error) return programPage(req, res, t, { error, form: f });
  db.prepare(`INSERT INTO template_items (template_id, day_number, start_time, end_time, title, description, kind)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(t.id, f.day_number, f.start_time, f.end_time, f.title, f.description, f.kind);
  back(res, `/manage/programs/${t.id}`, `Added “${f.title}”. Push the program to conferences when you’re ready.`);
});

router.post('/manage/programs/:id/items/:itemId', auth.requireAdmin, (req, res) => {
  const t = loadTemplate(req, res);
  if (!t) return;
  const f = readTemplateItem(req.body);
  const error = templateItemError(f);
  if (error) return programPage(req, res, t, { error });
  db.prepare(`UPDATE template_items SET day_number = ?, start_time = ?, end_time = ?, title = ?, description = ?, kind = ?
    WHERE id = ? AND template_id = ?`).run(f.day_number, f.start_time, f.end_time, f.title, f.description, f.kind, Number(req.params.itemId), t.id);
  back(res, `/manage/programs/${t.id}`, 'Saved. Push the program to conferences to update their schedules.');
});

router.post('/manage/programs/:id/items/:itemId/delete', auth.requireAdmin, (req, res) => {
  const t = loadTemplate(req, res);
  if (!t) return;
  transaction(() => {
    db.prepare('DELETE FROM schedule_items WHERE template_item_id = ?').run(Number(req.params.itemId));
    db.prepare('DELETE FROM template_items WHERE id = ? AND template_id = ?').run(Number(req.params.itemId), t.id);
  });
  back(res, `/manage/programs/${t.id}`, 'Removed from the program and from every conference schedule.');
});

router.post('/manage/programs/:id/apply', auth.requireAdmin, (req, res) => {
  const t = loadTemplate(req, res);
  if (!t) return;
  const eventIds = toArray(req.body.event_ids).map(Number).filter(Boolean);
  if (!eventIds.length) return back(res, `/manage/programs/${t.id}`, 'Select at least one conference.');
  const r = data.applyTemplate(t.id, eventIds);
  back(res, `/manage/programs/${t.id}`, `Pushed to ${eventIds.length} conference${eventIds.length === 1 ? '' : 's'}: ${r.added} added, ${r.updated} updated, ${r.removed} removed.`);
});

router.post('/manage/programs/:id/delete', auth.requireAdmin, (req, res) => {
  const t = loadTemplate(req, res);
  if (!t) return;
  transaction(() => {
    db.prepare('DELETE FROM schedule_items WHERE template_item_id IN (SELECT id FROM template_items WHERE template_id = ?)').run(t.id);
    db.prepare('DELETE FROM templates WHERE id = ?').run(t.id);
  });
  back(res, '/manage/programs', 'Program deleted and removed from conference schedules.');
});

/* ---------- Broadcast (admin) ---------- */

function broadcastTargets(audience) {
  const where = audience === 'youth' ? "AND audience = 'youth'" : audience === 'adult' ? "AND audience = 'adult'" : '';
  return db.prepare(`SELECT * FROM events WHERE published = 1 ${where} ORDER BY start_date`).all();
}

router.get('/manage/broadcast', auth.requireAdmin, (req, res) => {
  res.render('manage/broadcast', {
    title: 'Send to many conferences',
    counts: { all: broadcastTargets('all').length, youth: broadcastTargets('youth').length, adult: broadcastTargets('adult').length },
    error: null,
  });
});

router.post('/manage/broadcast', auth.requireAdmin, async (req, res) => {
  const title = str(req.body.title, 120);
  const body = str(req.body.body, 2000);
  const audience = ['youth', 'adult'].includes(req.body.audience) ? req.body.audience : 'all';
  if (!title) return back(res, '/manage/broadcast', 'Title is required.');
  const events = broadcastTargets(audience);
  let delivered = 0;
  for (const event of events) {
    delivered += await postAnnouncement(event, req.user, { title, body, sendPush: !!req.body.send_push, fromCentral: true });
  }
  back(res, '/manage/broadcast', `Posted to ${events.length} conference${events.length === 1 ? '' : 's'}.${req.body.send_push ? ` ${delivered} notification${delivered === 1 ? '' : 's'} delivered.` : ''}`);
});

/* ---------- Users (admin) ---------- */

function listUsers() {
  return db.prepare(`SELECT u.*, (SELECT GROUP_CONCAT(e.name, ', ') FROM event_editors ee JOIN events e ON e.id = ee.event_id
    WHERE ee.user_id = u.id) AS event_names FROM users u ORDER BY u.role, u.name`).all();
}

function usersPage(res, extra = {}) {
  res.render('manage/users', { title: 'People', users: listUsers(), created: null, error: null, ...extra });
}

router.get('/manage/users', auth.requireAdmin, (req, res) => {
  usersPage(res);
});

router.post('/manage/users', auth.requireAdmin, (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  const name = str(req.body.name, 100);
  const role = req.body.role === 'admin' ? 'admin' : 'editor';
  const render = (extra) => usersPage(res, extra);
  if (!email.includes('@') || !name) return render({ error: 'Enter a name and valid email.' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return render({ error: 'Someone with that email already exists.' });
  const password = auth.generatePassword();
  db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)').run(email, name, auth.hashPassword(password), role);
  render({ created: { email, password } });
});

router.post('/manage/users/:id/reset', auth.requireAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!user) return fail(res, 404, 'User not found.');
  const password = auth.generatePassword();
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(password), user.id);
  usersPage(res, { created: { email: user.email, password, reset: true } });
});

router.post('/manage/users/:id/delete', auth.requireAdmin, (req, res) => {
  if (Number(req.params.id) === req.user.id) return back(res, '/manage/users', 'You can’t remove your own account.');
  db.prepare('DELETE FROM users WHERE id = ?').run(Number(req.params.id));
  back(res, '/manage/users', 'Account removed.');
});

module.exports = router;
