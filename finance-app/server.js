require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const pinoHttp = require('pino-http');
const cookieSession = require('cookie-session');
const expressLayouts = require('express-ejs-layouts');

const logger = require('./lib/logger');
const { requireAuth } = require('./lib/auth');
const { csrfMiddleware } = require('./lib/csrf');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'frame-ancestors': ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(pinoHttp({
  logger,
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'debug';
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
  customErrorMessage: (req, res, err) => `${req.method} ${req.url} ${res.statusCode} ${err.message}`,
  // Los serializers están en lib/logger.js. wrapSerializers:false hace que reciban
  // el req/res de express directamente, no el .raw.
  wrapSerializers: false,
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
  etag: true,
  lastModified: true,
}));

// /healthz se monta antes de session/auth/csrf para que sea siempre accesible.
app.use('/', require('./routes/healthz'));

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
app.locals.safeJson = require('./lib/safeJson').safeJson;

app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  res.locals.authed = !!(req.session && req.session.authed);
  next();
});

app.use(csrfMiddleware);

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
  logger.error({ err, path: req.path, method: req.method }, 'request error');
  res.status(500).render('error', { error: err, title: 'Error' });
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandledRejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException');
});

const maintenance = require('./lib/maintenance');
maintenance.startScheduler();

const server = app.listen(PORT, () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV || 'development' }, 'finance app started');
});

function shutdown(signal) {
  logger.info({ signal }, 'shutdown initiated');
  maintenance.stopScheduler();
  server.close((err) => {
    if (err) logger.error({ err }, 'server.close error');
    else logger.info('server closed cleanly');
  });
  setTimeout(() => {
    logger.warn('forcing exit after 5s grace period');
    process.exit(0);
  }, 5000).unref();
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
