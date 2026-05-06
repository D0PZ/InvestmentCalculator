const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { setPassword, verifyPassword, getStoredHash } = require('../lib/auth');
const { getCachedFX, getCurrentFX } = require('../lib/fx');

router.get('/', (req, res) => {
  const fx = getCachedFX();
  const flash = req.session?.flash || null;
  if (req.session) req.session.flash = null;
  const counts = {
    transactions: db.prepare(`SELECT COUNT(*) AS c FROM transactions`).get().c,
    accounts: db.prepare(`SELECT COUNT(*) AS c FROM accounts`).get().c,
    subscriptions: db.prepare(`SELECT COUNT(*) AS c FROM subscriptions`).get().c,
    positions: db.prepare(`SELECT COUNT(*) AS c FROM positions`).get().c,
    snapshots: db.prepare(`SELECT COUNT(*) AS c FROM patrimony_snapshots`).get().c,
    priceHistory: db.prepare(`SELECT COUNT(*) AS c FROM price_history`).get().c,
  };
  res.render('settings', { fx, flash, counts, title: 'Settings' });
});

router.post('/password', (req, res) => {
  const { current, password, confirm } = req.body;
  if (!verifyPassword(current, getStoredHash())) {
    req.session.flash = { type: 'bad', text: 'Contraseña actual incorrecta' };
    return res.redirect('/settings');
  }
  if (!password || password.length < 8) {
    req.session.flash = { type: 'bad', text: 'Nueva contraseña: mínimo 8 caracteres' };
    return res.redirect('/settings');
  }
  if (password !== confirm) {
    req.session.flash = { type: 'bad', text: 'Las contraseñas nuevas no coinciden' };
    return res.redirect('/settings');
  }
  setPassword(password);
  req.session.flash = { type: 'good', text: 'Contraseña actualizada' };
  res.redirect('/settings');
});

router.post('/fx/refresh', async (req, res) => {
  const fx = await getCurrentFX({ force: true });
  req.session.flash = { type: fx.fallback ? 'bad' : 'good', text: `FX actualizado: ${fx.rate?.toFixed(2)} (${fx.fallback ? 'fallback' : 'mindicador.cl'})` };
  res.redirect('/settings');
});

router.post('/fx/manual', (req, res) => {
  const rate = Number(req.body.rate);
  if (!(rate > 0)) {
    req.session.flash = { type: 'bad', text: 'Tasa inválida' };
    return res.redirect('/settings');
  }
  const payload = JSON.stringify({ rate, fetched_at: new Date().toISOString(), manual: true });
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('fx_usdclp', ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(payload);
  req.session.flash = { type: 'good', text: `FX manual aplicado: ${rate.toFixed(2)}` };
  res.redirect('/settings');
});

module.exports = router;
