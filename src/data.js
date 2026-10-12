// Queries shared by the attendee app and the management screens.
const { db, transaction } = require('./db');
const { parseIds, addDays } = require('./util');

function eventBySlug(slug) {
  return db.prepare('SELECT * FROM events WHERE slug = ?').get(slug);
}

function eventById(id) {
  return db.prepare('SELECT * FROM events WHERE id = ?').get(id);
}

function eventsForUser(user) {
  if (user.role === 'admin') {
    return db.prepare('SELECT * FROM events ORDER BY audience DESC, start_date, name').all();
  }
  return db.prepare(`SELECT e.* FROM events e JOIN event_editors ee ON ee.event_id = e.id
    WHERE ee.user_id = ? ORDER BY e.start_date, e.name`).all(user.id);
}

function speakersForEvent(eventId) {
  return db.prepare(`SELECT s.* FROM speakers s JOIN event_speakers es ON es.speaker_id = s.id
    WHERE es.event_id = ? ORDER BY s.name`).all(eventId);
}

function scheduleForEvent(eventId) {
  const speakers = new Map(db.prepare('SELECT id, name FROM speakers').all().map((s) => [s.id, s]));
  return db.prepare('SELECT * FROM schedule_items WHERE event_id = ? ORDER BY date, start_time, end_time, id')
    .all(eventId)
    .map((item) => ({
      ...item,
      core: item.template_item_id !== null,
      speakers: parseIds(item.speaker_ids).map((id) => speakers.get(id)).filter(Boolean),
    }));
}

function groupByDate(items) {
  const groups = [];
  for (const item of items) {
    let g = groups[groups.length - 1];
    if (!g || g.date !== item.date) groups.push((g = { date: item.date, items: [] }));
    g.items.push(item);
  }
  return groups;
}

function infoForEvent(eventId) {
  return db.prepare('SELECT * FROM info_items WHERE event_id = ? ORDER BY category, sort, id').all(eventId);
}

function announcementsForEvent(eventId, limit = 50) {
  return db.prepare('SELECT * FROM announcements WHERE event_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(eventId, limit);
}

function editorsForEvent(eventId) {
  return db.prepare(`SELECT u.id, u.name, u.email FROM users u JOIN event_editors ee ON ee.user_id = u.id
    WHERE ee.event_id = ? ORDER BY u.name`).all(eventId);
}

// Copies a core program into events. Existing core items keep their local time/location;
// only the program content (title, description, type) is refreshed. New items are added,
// and items removed from the program are removed from the events.
function applyTemplate(templateId, eventIds) {
  const items = db.prepare('SELECT * FROM template_items WHERE template_id = ?').all(templateId);
  const itemIds = new Set(items.map((i) => i.id));
  let added = 0;
  let updated = 0;
  let removed = 0;
  transaction(() => {
    for (const eventId of eventIds) {
      const event = eventById(eventId);
      if (!event) continue;
      const existing = db.prepare(`SELECT si.id, si.template_item_id FROM schedule_items si
        JOIN template_items ti ON ti.id = si.template_item_id
        WHERE si.event_id = ? AND ti.template_id = ?`).all(eventId, templateId);
      const byItem = new Map(existing.map((r) => [r.template_item_id, r.id]));
      for (const ti of items) {
        if (byItem.has(ti.id)) {
          db.prepare('UPDATE schedule_items SET title = ?, description = ?, kind = ? WHERE id = ?')
            .run(ti.title, ti.description, ti.kind, byItem.get(ti.id));
          updated += 1;
        } else {
          const date = addDays(event.start_date, Math.max(0, ti.day_number - 1));
          if (date > event.end_date) continue;
          db.prepare(`INSERT INTO schedule_items (event_id, date, start_time, end_time, title, description, kind, template_item_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(eventId, date, ti.start_time, ti.end_time, ti.title, ti.description, ti.kind, ti.id);
          added += 1;
        }
      }
      for (const r of existing) {
        if (!itemIds.has(r.template_item_id)) {
          db.prepare('DELETE FROM schedule_items WHERE id = ?').run(r.id);
          removed += 1;
        }
      }
    }
  });
  return { added, updated, removed };
}

module.exports = {
  eventBySlug, eventById, eventsForUser, speakersForEvent, scheduleForEvent, groupByDate,
  infoForEvent, announcementsForEvent, editorsForEvent, applyTemplate,
};
