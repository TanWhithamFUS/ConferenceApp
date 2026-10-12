// Logins for central staff (admins) and event editors (partners / site staff).
const crypto = require('node:crypto');
const { db, getSetting, setSetting } = require('./db');

const COOKIE = 'sc_session';
const SESSION_DAYS = 14;

function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  let s = getSetting('session_secret');
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    setSetting('session_secret', s);
  }
  return s;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function generatePassword() {
  // Readable temporary password, e.g. "maple-river-4821".
  const words = ['maple', 'river', 'cedar', 'stone', 'light', 'grace', 'hope', 'peace', 'faith', 'oak',
    'dawn', 'harbor', 'meadow', 'summit', 'brook', 'lantern', 'olive', 'willow', 'pine', 'valley'];
  const pick = () => words[crypto.randomInt(words.length)];
  return `${pick()}-${pick()}-${crypto.randomInt(1000, 10000)}`;
}

function sign(value) {
  return crypto.createHmac('sha256', secret()).update(value).digest('base64url');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSession(res, userId) {
  const expires = Date.now() + SESSION_DAYS * 864e5;
  const payload = `${userId}.${expires}`;
  res.cookie(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_DAYS * 864e5,
  });
}

function clearSession(res) {
  res.clearCookie(COOKIE);
}

function readSession(req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (!raw) return null;
  const [userId, expires, sig] = raw.split('.');
  if (!userId || !expires || !sig) return null;
  const payload = `${userId}.${expires}`;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  if (Number(expires) < Date.now()) return null;
  return { userId: Number(userId), token: raw };
}

// Attaches req.user (or null) and a CSRF token for forms.
function loadUser(req, res, next) {
  const session = readSession(req);
  req.user = session
    ? db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(session.userId) || null
    : null;
  req.csrfToken = session ? sign(`csrf:${session.token}`) : '';
  res.locals.user = req.user;
  res.locals.csrfToken = req.csrfToken;
  next();
}

function requireLogin(req, res, next) {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'admin') return res.status(403).render('error', { title: 'Not allowed', message: 'Only Steubenville Conferences staff can do that.' });
  next();
}

// Rejects state-changing requests from logged-in users without a valid CSRF token.
function checkCsrf(req, res, next) {
  if (req.method !== 'POST' || !req.user) return next();
  const token = (req.body && req.body._csrf) || req.get('x-csrf-token') || '';
  if (token.length !== req.csrfToken.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(req.csrfToken))) {
    return res.status(403).render('error', { title: 'Form expired', message: 'Please go back, reload the page, and try again.' });
  }
  next();
}

function canEditEvent(user, eventId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return !!db.prepare('SELECT 1 FROM event_editors WHERE user_id = ? AND event_id = ?').get(user.id, eventId);
}

// Very small in-memory throttle for login attempts.
const attempts = new Map();
function loginThrottled(key) {
  const now = Date.now();
  const entry = attempts.get(key) || { count: 0, first: now };
  if (now - entry.first > 15 * 60e3) { entry.count = 0; entry.first = now; }
  entry.count += 1;
  attempts.set(key, entry);
  return entry.count > 10;
}

module.exports = {
  hashPassword, verifyPassword, generatePassword,
  setSession, clearSession, loadUser, requireLogin, requireAdmin, checkCsrf,
  canEditEvent, loginThrottled,
};
