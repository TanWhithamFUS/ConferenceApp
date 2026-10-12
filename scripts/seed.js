// Loads SAMPLE data so you can click around. Run: npm run seed
// Pass --force to wipe an existing database first.
const fs = require('node:fs');
const path = require('node:path');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
if (process.argv.includes('--force')) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
}

const { db, transaction } = require('../src/db');
const { hashPassword } = require('../src/auth');
const { applyTemplate } = require('../src/data');

if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) {
  console.error('The database already has data. Run `npm run seed -- --force` to wipe it and reload the samples.');
  process.exit(1);
}

const ADMIN = { email: 'admin@example.com', password: 'steubenville' };
const PARTNER = { email: 'partner@example.com', password: 'partner123' };

transaction(() => {
  const user = db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)');
  user.run(ADMIN.email, 'Central Staff (sample)', hashPassword(ADMIN.password), 'admin');
  const partnerId = Number(user.run(PARTNER.email, 'Partner Coordinator (sample)', hashPassword(PARTNER.password), 'editor').lastInsertRowid);

  const ev = db.prepare(`INSERT INTO events (slug, name, audience, operated_by, partner_name, start_date, end_date, city, venue, address,
    registration_url, website_url, welcome, contact_name, contact_email, contact_phone, published)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
  const welcomeYouth = 'Welcome! We are so glad you’re here. Use this app for the schedule, speakers, and live updates all weekend.\n\nTurn on notifications so you don’t miss room changes and announcements.';
  const events = [
    ['main-campus-1', 'Steubenville Youth — Main Campus I', 'youth', 'franciscan', '', '2027-06-18', '2027-06-20', 'Steubenville, OH', 'Finnegan Fieldhouse', '1235 University Blvd, Steubenville, OH 43952'],
    ['main-campus-2', 'Steubenville Youth — Main Campus II', 'youth', 'franciscan', '', '2027-06-25', '2027-06-27', 'Steubenville, OH', 'Finnegan Fieldhouse', '1235 University Blvd, Steubenville, OH 43952'],
    ['sample-partner-south', 'Steubenville Youth — Sample South', 'youth', 'partner', 'Sample Partner Ministry (South)', '2027-07-09', '2027-07-11', 'Atlanta, GA', 'Sample Convention Center', '123 Example St, Atlanta, GA'],
    ['sample-partner-midwest', 'Steubenville Youth — Sample Midwest', 'youth', 'partner', 'Sample Partner Ministry (Midwest)', '2027-07-16', '2027-07-18', 'Kansas City, MO', 'Sample Arena', '456 Example Ave, Kansas City, MO'],
    ['mens-conference', 'Men’s Conference (sample)', 'adult', 'franciscan', '', '2027-07-30', '2027-08-01', 'Steubenville, OH', 'Finnegan Fieldhouse', '1235 University Blvd, Steubenville, OH 43952'],
    ['womens-conference', 'Women’s Conference (sample)', 'adult', 'franciscan', '', '2027-08-06', '2027-08-08', 'Steubenville, OH', 'Finnegan Fieldhouse', '1235 University Blvd, Steubenville, OH 43952'],
  ];
  const ids = {};
  for (const [slug, name, audience, op, partner, start, end, city, venue, address] of events) {
    ids[slug] = Number(ev.run(slug, name, audience, op, partner, start, end, city, venue, address,
      'https://steubenvilleconferences.com', 'https://steubenvilleconferences.com',
      audience === 'youth' ? welcomeYouth : 'Welcome to the conference! Everything you need for the weekend is right here.',
      op === 'partner' ? 'Site Coordinator' : 'Conference Office', 'conferences@example.com', '(555) 555-0100').lastInsertRowid);
  }
  db.prepare('INSERT INTO event_editors (user_id, event_id) VALUES (?, ?)').run(partnerId, ids['sample-partner-south']);

  const sp = db.prepare('INSERT INTO speakers (name, role_title, bio) VALUES (?, ?, ?)');
  const speakers = [
    ['Sample Speaker One', 'Keynote Speaker', 'A sample bio. Replace with the real speaker’s biography.'],
    ['Sample Speaker Two', 'Speaker & Author', 'A sample bio. Replace with the real speaker’s biography.'],
    ['Sample Worship Band', 'Praise & Worship', 'A sample bio for the worship team.'],
    ['Fr. Sample Priest, TOR', 'Chaplain', 'A sample bio. Replace with the real biography.'],
  ].map(([n, r, b]) => Number(sp.run(n, r, b).lastInsertRowid));
  const lineup = db.prepare('INSERT INTO event_speakers (event_id, speaker_id) VALUES (?, ?)');
  for (const id of Object.values(ids)) for (const s of speakers) lineup.run(id, s);

  // Core youth program owned by Steubenville Conferences.
  const t = Number(db.prepare("INSERT INTO templates (name, audience) VALUES ('2027 Youth Core Program', 'youth')").run().lastInsertRowid);
  const ti = db.prepare('INSERT INTO template_items (template_id, day_number, start_time, end_time, title, description, kind) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const program = [
    [1, '19:00', '20:30', 'Opening Session', 'Welcome, praise & worship, and the opening keynote on this year’s theme.', 'session'],
    [1, '20:30', '21:30', 'Praise & Worship', '', 'worship'],
    [2, '09:00', '10:15', 'Morning Session', 'Keynote talk and worship.', 'session'],
    [2, '11:00', '12:15', 'Holy Mass', '', 'mass'],
    [2, '14:00', '15:00', 'Breakout Sessions', 'Separate sessions for young men and young women.', 'session'],
    [2, '19:00', '22:00', 'Eucharistic Adoration', 'The heart of the weekend. Confessions are available throughout.', 'adoration'],
    [3, '09:00', '10:00', 'Sunday Morning Session', '', 'session'],
    [3, '10:30', '12:00', 'Closing Mass & Sending', '', 'mass'],
  ];
  for (const p of program) ti.run(t, ...p);
  applyTemplate(t, ['main-campus-1', 'main-campus-2', 'sample-partner-south', 'sample-partner-midwest'].map((s) => ids[s]));

  // Things a partner adds locally.
  const south = ids['sample-partner-south'];
  const local = db.prepare('INSERT INTO schedule_items (event_id, date, start_time, end_time, title, description, location, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  local.run(south, '2027-07-09', '16:00', '18:30', 'Group Check-in', 'Group leaders: pick up wristbands for your whole group.', 'Hall B Lobby', 'logistics');
  local.run(south, '2027-07-09', '17:30', '18:45', 'Dinner', '', 'Food Court', 'meal');
  local.run(south, '2027-07-10', '12:30', '13:45', 'Lunch', '', 'Food Court', 'meal');
  local.run(south, '2027-07-10', '15:30', '16:30', 'Small Groups', 'Meet with your parish group.', 'Assigned rooms', 'small_group');
  db.prepare("UPDATE schedule_items SET location = 'Main Arena' WHERE event_id = ? AND template_item_id IS NOT NULL").run(south);

  const info = db.prepare('INSERT INTO info_items (event_id, category, title, body, sort) VALUES (?, ?, ?, ?, ?)');
  info.run(south, 'info', 'Parking', 'Bus parking is in **Lot C**. Cars may use the Example St garage ($10/day).', 1);
  info.run(south, 'info', 'Check-in', 'Group leaders check in at the Hall B Lobby Friday 4:00–6:30 PM. Every attendee must wear their wristband all weekend.', 2);
  info.run(south, 'info', 'What to bring', 'Bible, rosary, water bottle, sweatshirt (the arena gets cold!), and any medications.', 3);
  info.run(south, 'faq', 'Where is the first aid station?', 'Next to Section 104 on the main concourse, staffed during all sessions.', 1);
  info.run(south, 'faq', 'Can I bring food into the arena?', 'Sealed water bottles only. Meals are served in the Food Court.', 2);
  info.run(south, 'faq', 'Lost and found?', 'Bring items to (or ask at) the Info Desk by the main entrance.', 3);

  const ann = db.prepare('INSERT INTO announcements (event_id, title, body, from_central, created_by) VALUES (?, ?, ?, ?, NULL)');
  for (const id of Object.values(ids)) {
    ann.run(id, 'Welcome to the new conference app!', 'Add it to your home screen and turn on notifications for live updates.', 1);
  }
  ann.run(south, 'Check-in opens at 4:00 PM', 'Group leaders, please come to the Hall B Lobby to pick up wristbands.', 0);
});

console.log(`Sample data loaded.

  Central staff (admin):  ${ADMIN.email} / ${ADMIN.password}
  Partner editor:         ${PARTNER.email} / ${PARTNER.password}  (can edit “Sample South” only)

Start the app with: npm start`);
