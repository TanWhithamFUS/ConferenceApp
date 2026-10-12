const path = require('node:path');
const express = require('express');
const auth = require('./src/auth');
const util = require('./src/util');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
app.disable('x-powered-by');

app.locals.u = util;
app.locals.orgName = process.env.ORG_NAME || 'Steubenville Conferences';

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// The service worker must be served from the root so it can control the whole app.
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.set('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(auth.loadUser);
app.use(auth.checkCsrf);

app.use(require('./src/routes/public'));
app.use(require('./src/routes/manage'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: 'That page doesn’t exist.' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Something went wrong', message: 'Please try again in a moment.' });
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Steubenville Conferences app running at http://localhost:${port}`));
}

module.exports = app;
