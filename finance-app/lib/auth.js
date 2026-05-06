const crypto = require('crypto');
const db = require('./db');

const KEY_LEN = 64;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, KEY_LEN).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, KEY_LEN).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getStoredHash() {
  const row = db.prepare(`SELECT value FROM settings WHERE key='password_hash'`).get();
  return row ? row.value : null;
}

function setPassword(password) {
  const stored = hashPassword(password);
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('password_hash', ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(stored);
}

function isPasswordSet() {
  return !!getStoredHash();
}

function requireAuth(req, res, next) {
  if (req.path === '/login' || req.path === '/setup' || req.path.startsWith('/css') || req.path.startsWith('/js')) {
    return next();
  }
  if (!isPasswordSet()) return res.redirect('/setup');
  if (req.session && req.session.authed) return next();
  return res.redirect('/login');
}

module.exports = { hashPassword, verifyPassword, getStoredHash, setPassword, isPasswordSet, requireAuth };
