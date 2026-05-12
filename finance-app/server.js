require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const morgan = require('morgan');
const cookieSession = require('cookie-session');
const expressLayouts = require('express-ejs-layouts');

const { requireAuth } = require('./lib/auth');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use(morgan('dev'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(cookieSession({
  name: 'finance.sid',
  keys: [SESSION_SECRET],
  maxAge: 7 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
}));

const { clp, pct, pctFromRatio, signedClp } = require('./lib/format');
app.locals.clp = clp;
app.locals.pct = pct;
app.locals.pctFromRatio = pctFromRatio;
app.locals.signedClp = signedClp;

app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  res.locals.authed = !!(req.session && req.session.authed);
  next();
});

app.use('/', require('./routes/auth'));
app.use(requireAuth);

app.use('/', require('./routes/dashboard'));
app.use('/transactions', require('./routes/transactions'));
app.use('/accounts', require('./routes/accounts'));
app.use('/subscriptions', require('./routes/subscriptions'));
app.use('/positions', require('./routes/positions'));
app.use('/settings', require('./routes/settings'));
app.use('/live', require('./routes/live'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { error: err, title: 'Error' });
});

const maintenance = require('./lib/maintenance');
maintenance.startScheduler();

app.listen(PORT, () => {
  console.log(`💰 Finance app running at http://localhost:${PORT}`);
});
