// Web Push (works on Android/desktop browsers, and on iPhone once the app is added to the Home Screen).
const webpush = require('web-push');
const { db, getSetting, setSetting } = require('./db');

function vapidKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  let stored = getSetting('vapid_keys');
  if (!stored) {
    stored = JSON.stringify(webpush.generateVAPIDKeys());
    setSetting('vapid_keys', stored);
  }
  return JSON.parse(stored);
}

const keys = vapidKeys();
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:conferences@example.com',
  keys.publicKey,
  keys.privateKey,
);

function publicKey() {
  return keys.publicKey;
}

function subscribe(eventId, sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    throw new Error('Invalid subscription');
  }
  if (!/^https:\/\//.test(sub.endpoint)) throw new Error('Invalid endpoint');
  db.prepare(`INSERT INTO push_subscriptions (event_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
    ON CONFLICT(event_id, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`)
    .run(eventId, sub.endpoint, sub.keys.p256dh, sub.keys.auth);
}

function unsubscribe(eventId, endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE event_id = ? AND endpoint = ?').run(eventId, endpoint);
}

function subscriberCount(eventId) {
  return db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE event_id = ?').get(eventId).n;
}

// Sends a notification to everyone subscribed to an event. Returns the number delivered.
async function sendToEvent(eventId, { title, body, url }) {
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE event_id = ?').all(eventId);
  const payload = JSON.stringify({ title, body, url });
  let delivered = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 6 * 3600 });
      delivered += 1;
    } catch (err) {
      // 404/410 mean the browser dropped the subscription; clean it up.
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
      } else {
        console.warn(`Push failed for subscription ${s.id}: ${err.statusCode || ''} ${err.message}`);
      }
    }
  }));
  return delivered;
}

module.exports = { publicKey, subscribe, unsubscribe, subscriberCount, sendToEvent };
