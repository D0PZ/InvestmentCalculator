const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { computeHealth } = require('../lib/health');
const { currentYYYYMM } = require('../lib/format');

router.get('/', (req, res) => {
  const yyyymm = req.query.month || currentYYYYMM();
  const health = computeHealth(yyyymm);
  const recentTx = db.prepare(
    `SELECT t.*, a.name AS account_name FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     ORDER BY occurred_on DESC, t.id DESC LIMIT 10`
  ).all();
  const subs = db.prepare(`SELECT * FROM subscriptions WHERE active=1 ORDER BY monthly_cost DESC`).all();

  res.render('dashboard', { health, recentTx, subs, yyyymm, title: 'Dashboard' });
});

module.exports = router;
