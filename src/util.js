// Formatting and small helpers shared by routes and views.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const KINDS = {
  session: 'Session',
  mass: 'Mass',
  adoration: 'Adoration',
  confession: 'Confession',
  worship: 'Praise & Worship',
  small_group: 'Small Group',
  meal: 'Meal',
  break: 'Break',
  logistics: 'Check-in / Logistics',
  other: 'Other',
};

function parseDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

function formatDateRange(start, end) {
  const a = parseDate(start);
  const b = parseDate(end || start);
  const sameYear = a.getUTCFullYear() === b.getUTCFullYear();
  const sameMonth = sameYear && a.getUTCMonth() === b.getUTCMonth();
  if (start === end || !end) return `${MONTHS[a.getUTCMonth()]} ${a.getUTCDate()}, ${a.getUTCFullYear()}`;
  if (sameMonth) return `${MONTHS[a.getUTCMonth()]} ${a.getUTCDate()}–${b.getUTCDate()}, ${a.getUTCFullYear()}`;
  if (sameYear) return `${MONTHS[a.getUTCMonth()]} ${a.getUTCDate()} – ${MONTHS[b.getUTCMonth()]} ${b.getUTCDate()}, ${a.getUTCFullYear()}`;
  return `${MONTHS[a.getUTCMonth()]} ${a.getUTCDate()}, ${a.getUTCFullYear()} – ${MONTHS[b.getUTCMonth()]} ${b.getUTCDate()}, ${b.getUTCFullYear()}`;
}

function formatDay(iso) {
  const d = parseDate(iso);
  return `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function formatTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

function addDays(iso, n) {
  const d = parseDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function eventDays(event) {
  const days = [];
  for (let d = event.start_date; d <= event.end_date && days.length < 14; d = addDays(d, 1)) days.push(d);
  return days;
}

function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '')
    .trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60) || 'event';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Plain text -> safe HTML paragraphs, with links made clickable and **bold** supported.
function richText(s) {
  const escaped = escapeHtml(s).trim();
  if (!escaped) return '';
  const linked = escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  return linked.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}

function safeUrl(u) {
  const s = String(u || '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

function timeAgo(sqlTimestamp) {
  const then = new Date(`${sqlTimestamp.replace(' ', 'T')}Z`).getTime();
  const mins = Math.round((Date.now() - then) / 60e3);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function parseIds(json) {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v.map(Number).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function toArray(v) {
  if (v === undefined || v === null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s));
const isTime = (s) => /^\d{2}:\d{2}$/.test(String(s));

module.exports = {
  KINDS, formatDateRange, formatDay, formatTime, addDays, eventDays, slugify, escapeHtml,
  richText, safeUrl, timeAgo, parseIds, toArray, isDate, isTime,
};
