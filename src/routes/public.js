// Attendee-facing app: pick a conference, then schedule / speakers / info / announcements.
const express = require('express');
const { db } = require('../db');
const push = require('../push');
const data = require('../data');
const { canEditEvent } = require('../auth');

const router = express.Router();

router.get('/', (req, res) => {
  const events = db.prepare('SELECT * FROM events WHERE published = 1 ORDER BY start_date, name').all();
  res.render('home', {
    title: 'Steubenville Conferences',
    youth: events.filter((e) => e.audience === 'youth'),
    adult: events.filter((e) => e.audience === 'adult'),
  });
});

// Loads the event for /e/:slug routes. Unpublished events are visible only to their editors (preview).
router.param('slug', (req, res, next, slug) => {
  const event = data.eventBySlug(slug);
  if (!event || (!event.published && !canEditEvent(req.user, event.id))) {
    return res.status(404).render('error', { title: 'Not found', message: 'We couldn’t find that conference.' });
  }
  req.event = event;
  res.locals.event = event;
  res.locals.preview = !event.published;
  next();
});

router.get('/e/:slug', (req, res) => {
  const schedule = data.scheduleForEvent(req.event.id);
  res.render('event/home', {
    title: req.event.name,
    tab: 'home',
    announcements: data.announcementsForEvent(req.event.id, 3),
    schedule,
  });
});

router.get('/e/:slug/schedule', (req, res) => {
  res.render('event/schedule', {
    title: `Schedule · ${req.event.name}`,
    tab: 'schedule',
    days: data.groupByDate(data.scheduleForEvent(req.event.id)),
  });
});

router.get('/e/:slug/speakers', (req, res) => {
  res.render('event/speakers', {
    title: `Speakers · ${req.event.name}`,
    tab: 'speakers',
    speakers: data.speakersForEvent(req.event.id),
  });
});

router.get('/e/:slug/info', (req, res) => {
  const items = data.infoForEvent(req.event.id);
  res.render('event/info', {
    title: `Info · ${req.event.name}`,
    tab: 'info',
    info: items.filter((i) => i.category === 'info'),
    faq: items.filter((i) => i.category === 'faq'),
  });
});

router.get('/e/:slug/news', (req, res) => {
  res.render('event/news', {
    title: `Announcements · ${req.event.name}`,
    tab: 'news',
    announcements: data.announcementsForEvent(req.event.id),
  });
});

// Per-conference manifest so "Add to Home Screen" opens straight into that conference.
router.get('/e/:slug/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').send(JSON.stringify({
    name: req.event.name,
    short_name: req.event.name.length > 14 ? 'Steubenville' : req.event.name,
    start_url: `/e/${req.event.slug}`,
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#1f4d3a',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }));
});

router.get('/api/push/key', (req, res) => {
  res.json({ publicKey: push.publicKey() });
});

router.post('/api/push/:slug/subscribe', express.json({ limit: '10kb' }), (req, res) => {
  try {
    push.subscribe(req.event.id, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/api/push/:slug/unsubscribe', express.json({ limit: '10kb' }), (req, res) => {
  if (req.body && typeof req.body.endpoint === 'string') push.unsubscribe(req.event.id, req.body.endpoint);
  res.json({ ok: true });
});

module.exports = router;
