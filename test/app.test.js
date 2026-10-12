// End-to-end checks of the key rules: partners edit only their own conference,
// core program content is locked for partners, and attendees only see published events.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-test-'));
process.env.DB_PATH = path.join(dir, 'test.db');

let server;
let base;
let db;

before(async () => {
  const log = console.log;
  console.log = () => {};
  require('../scripts/seed');
  console.log = log;
  ({ db } = require('../src/db'));
  const app = require('../server');
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

class Client {
  constructor() { this.cookie = ''; }

  async req(method, url, form) {
    const headers = { cookie: this.cookie };
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(base + url, { method, headers, body, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  }

  get(url) { return this.req('GET', url); }

  async post(url, form) {
    const page = await this.get('/manage/account');
    const csrf = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
    return this.req('POST', url, { _csrf: csrf, ...form });
  }

  async login(email, password) {
    const r = await this.req('POST', '/login', { email, password });
    assert.equal(r.status, 302, 'login should redirect');
    return this;
  }
}

const eventId = (slug) => db.prepare('SELECT id FROM events WHERE slug = ?').get(slug).id;

test('attendees see published conferences and their pages', async () => {
  const c = new Client();
  const home = await c.get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Sample South/);
  for (const tab of ['', '/schedule', '/speakers', '/info', '/news']) {
    const r = await c.get(`/e/sample-partner-south${tab}`);
    assert.equal(r.status, 200, `tab ${tab}`);
  }
  const schedule = await c.get('/e/sample-partner-south/schedule');
  assert.match(schedule.text, /Opening Session/);
  assert.match(schedule.text, /Group Check-in/);
});

test('unpublished conferences are hidden from attendees', async () => {
  db.prepare('UPDATE events SET published = 0 WHERE slug = ?').run('sample-partner-midwest');
  const c = new Client();
  assert.equal((await c.get('/e/sample-partner-midwest')).status, 404);
  assert.doesNotMatch((await c.get('/')).text, /Sample Midwest/);
  const admin = await new Client().login('admin@example.com', 'steubenville');
  assert.equal((await admin.get('/e/sample-partner-midwest')).status, 200, 'admins can preview');
  db.prepare('UPDATE events SET published = 1 WHERE slug = ?').run('sample-partner-midwest');
});

test('management requires login', async () => {
  const r = await new Client().get('/manage');
  assert.equal(r.status, 302);
  assert.match(r.location, /^\/login/);
});

test('partner can edit their own conference but not others', async () => {
  const p = await new Client().login('partner@example.com', 'partner123');
  const own = eventId('sample-partner-south');
  const other = eventId('sample-partner-midwest');

  const dash = await p.get('/manage');
  assert.match(dash.text, /Sample South/);
  assert.doesNotMatch(dash.text, /Sample Midwest/);

  assert.equal((await p.get(`/manage/events/${own}`)).status, 200);
  assert.equal((await p.get(`/manage/events/${other}`)).status, 403);
  assert.equal((await p.post(`/manage/events/${other}/info`, { title: 'Hacked' })).status, 403);

  const r = await p.post(`/manage/events/${own}/info`, { category: 'faq', title: 'Is there Wi-Fi?', body: 'Yes', sort: '9' });
  assert.equal(r.status, 302);
  assert.ok(db.prepare('SELECT 1 FROM info_items WHERE event_id = ? AND title = ?').get(own, 'Is there Wi-Fi?'));
});

test('partner cannot change central fields like name or publish status', async () => {
  const p = await new Client().login('partner@example.com', 'partner123');
  const own = eventId('sample-partner-south');
  await p.post(`/manage/events/${own}`, { name: 'Renamed', published: '', venue: 'New Venue' });
  const e = db.prepare('SELECT * FROM events WHERE id = ?').get(own);
  assert.equal(e.name, 'Steubenville Youth — Sample South');
  assert.equal(e.published, 1);
  assert.equal(e.venue, 'New Venue');
});

test('partner admin-only screens are blocked', async () => {
  const p = await new Client().login('partner@example.com', 'partner123');
  for (const url of ['/manage/programs', '/manage/speakers', '/manage/users', '/manage/broadcast', `/manage/events/${eventId('sample-partner-south')}/editors`]) {
    assert.equal((await p.get(url)).status, 403, url);
  }
});

test('core program sessions: partner may move them but not change content or delete', async () => {
  const p = await new Client().login('partner@example.com', 'partner123');
  const own = eventId('sample-partner-south');
  const core = db.prepare("SELECT * FROM schedule_items WHERE event_id = ? AND title = 'Opening Session'").get(own);

  await p.post(`/manage/events/${own}/schedule/${core.id}`, {
    date: core.date, start_time: '19:30', end_time: '21:00', location: 'Hall A', title: 'Changed title', description: 'x',
  });
  const after1 = db.prepare('SELECT * FROM schedule_items WHERE id = ?').get(core.id);
  assert.equal(after1.title, 'Opening Session');
  assert.equal(after1.start_time, '19:30');
  assert.equal(after1.location, 'Hall A');

  assert.equal((await p.post(`/manage/events/${own}/schedule/${core.id}/delete`, {})).status, 403);
  assert.ok(db.prepare('SELECT 1 FROM schedule_items WHERE id = ?').get(core.id));
});

test('re-pushing the core program refreshes content but keeps local time and room', async () => {
  const admin = await new Client().login('admin@example.com', 'steubenville');
  const own = eventId('sample-partner-south');
  const t = db.prepare('SELECT * FROM templates LIMIT 1').get();
  const ti = db.prepare("SELECT * FROM template_items WHERE template_id = ? AND title = 'Opening Session'").get(t.id);
  await admin.post(`/manage/programs/${t.id}/items/${ti.id}`, { ...ti, title: 'Opening Session: Be Not Afraid' });
  await admin.post(`/manage/programs/${t.id}/apply`, { event_ids: String(own) });
  const item = db.prepare('SELECT * FROM schedule_items WHERE event_id = ? AND template_item_id = ?').get(own, ti.id);
  assert.equal(item.title, 'Opening Session: Be Not Afraid');
  assert.equal(item.location, 'Hall A');
  assert.equal(item.start_time, '19:30');
});

test('forms without a CSRF token are rejected', async () => {
  const p = await new Client().login('partner@example.com', 'partner123');
  const r = await p.req('POST', `/manage/events/${eventId('sample-partner-south')}/info`, { title: 'No token' });
  assert.equal(r.status, 403);
});

test('admin can add a partner editor and they get a temporary password', async () => {
  const admin = await new Client().login('admin@example.com', 'steubenville');
  const mid = eventId('sample-partner-midwest');
  const r = await admin.post(`/manage/events/${mid}/editors`, { email: 'new.partner@example.com', name: 'New Partner' });
  const pw = /Temporary password<\/dt><dd><code>([^<]+)</.exec(r.text)[1];
  const p = await new Client().login('new.partner@example.com', pw);
  assert.equal((await p.get(`/manage/events/${mid}`)).status, 200);
  assert.equal((await p.get(`/manage/events/${eventId('sample-partner-south')}`)).status, 403);
});

test('announcements post and appear for attendees', async () => {
  const p = await new Client().login('partner@example.com', 'partner123');
  const own = eventId('sample-partner-south');
  await p.post(`/manage/events/${own}/announcements`, { title: 'Lunch moved to 1 PM', body: 'See you there' });
  const news = await new Client().get('/e/sample-partner-south/news');
  assert.match(news.text, /Lunch moved to 1 PM/);
});

test('push subscription endpoint validates input', async () => {
  const bad = await fetch(`${base}/api/push/sample-partner-south/subscribe`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'nope' }),
  });
  assert.equal(bad.status, 400);
  const good = await fetch(`${base}/api/push/sample-partner-south/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'https://push.example.com/abc', keys: { p256dh: 'x', auth: 'y' } }),
  });
  assert.equal(good.status, 200);
});

test('QR code page renders for editors', async () => {
  const p = await new Client().login('partner@example.com', 'partner123');
  const r = await p.get(`/manage/events/${eventId('sample-partner-south')}/qr`);
  assert.equal(r.status, 200);
  assert.match(r.text, /<svg/);
});
