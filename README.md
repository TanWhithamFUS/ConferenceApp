# Steubenville Conferences App

A mobile-friendly web app for Steubenville Conferences' Youth and Adult conferences. Attendees **scan a QR code** and the app opens in their phone's browser. They can add it to their home screen like a regular app, with no App Store or Google Play listing.

## Who does what

| Role | Who | What they can do |
|---|---|---|
| **Attendee** | Anyone; no account needed | Pick a conference, then see the schedule, speakers, info & FAQ, and announcements. Star sessions to build "My schedule". Turn on push notifications. |
| **Editor** | A partner's staff (or Franciscan site staff) | Edit **only the conferences they're assigned to**: welcome message, registration link, venue/map, on-site contact, local schedule items (meals, check-in, small groups…), info & FAQ, and announcements and push notifications. They can move a core session's time and room, but not change its content. |
| **Administrator** | Steubenville Conferences central staff | Everything: create conferences, set name/dates/partner, publish, manage the **core program**, the speaker library and each event's lineup, give partners access, and **broadcast** an announcement to every conference at once. |

### How the core program works
Central staff build a program once under **Core programs**, for example "2027 Youth Core Program" with Day 1 / Day 2 / Day 3 sessions. **Push program** then copies it into each selected conference's schedule as **Core** sessions. Partners add their local items around those sessions.

When you edit the program and push it again, each site gets the updated titles and descriptions. Each site's own times and rooms are kept.

### Registration
The app does not take registrations or payments. Each conference links to its own registration page, so partners keep using whatever system they already have.

## Push notifications
Push notifications use the open **Web Push** standard, so there's no paid service and no app store involved.
- **Android / desktop Chrome, Edge, Firefox:** tap "Turn on" on the conference home screen.
- **iPhone / iPad (iOS 16.4+):** Apple requires the app to be added to the Home Screen first (Share → Add to Home Screen). The app shows iPhone users this instruction automatically.

Editors post an announcement and tick **Send as a push notification**. Notifications go to every device that turned them on for that conference.

## Running it locally

Requires **Node.js 22.13 or newer**.

```bash
npm install
npm run seed      # loads SAMPLE data (fake conferences, speakers, logins)
npm start         # http://localhost:3000
```

Sample logins (seed data only):
- Admin: `admin@example.com` / `steubenville`
- Partner editor: `partner@example.com` / `partner123` (can edit "Sample South" only)

To start fresh without sample data, skip `npm run seed`. The first visit to `/login` will ask you to create the first administrator account.

`npm test` runs automated checks of the permission rules.

## Hosting (for the MarCom / web team)

It's a single small Node.js app with one SQLite database file. There are no other services to run, so it fits on almost any host:

- **Simple PaaS** (Render, Railway, Fly.io, DigitalOcean App Platform, Azure App Service): `npm install` and `npm start`, with a **persistent disk** mounted for the database.
- **Docker:** `docker build -t sc-app . && docker run -p 3000:3000 -v sc-data:/data -e BASE_URL=https://… sc-app`
- **Existing server / VM:** run behind nginx or your current proxy with any process manager.

Requirements for production:
1. **HTTPS is required.** Push notifications and home-screen install only work over HTTPS.
2. Set `BASE_URL` (used in QR codes), `NODE_ENV=production`, and put `DB_PATH` on a persistent disk. See `.env.example`.
3. **Back up** the database file (`DB_PATH`) regularly. That one file holds all the data.
4. A subdomain such as `app.steubenvilleconferences.com` works well, and it makes the QR codes short and trustworthy.

## Project layout

```
server.js              Express app entry point
src/db.js              Database schema (SQLite, built into Node)
src/auth.js            Logins, sessions, CSRF protection, permissions
src/push.js            Web Push notifications
src/data.js            Shared queries, incl. pushing the core program
src/routes/public.js   Attendee app
src/routes/manage.js   Admin & partner management screens
views/                 Page templates (EJS)
public/                CSS, JS, service worker (offline + push), icons
scripts/seed.js        Sample data
test/                  Automated tests
```

## Ideas for later
- Upload speaker photos and venue maps directly (today these are image links)
- Schedule notifications in advance ("Adoration starts in 15 minutes")
- Let partners add local speakers or emcees
- Self-service password reset by email
- Multiple languages (e.g. Spanish)
- Usage stats per conference
