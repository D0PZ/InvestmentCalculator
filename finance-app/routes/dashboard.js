const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { computeHealth } = require('../lib/health');
const { currentYYYYMM } = require('../lib/format');
const { getCurrentFX } = require('../lib/fx');
const { ensureTodaySnapshots } = require('../lib/snapshots');
const { computePortfolioReturns, computePatrimonyReturns } = require('../lib/returns');

router.get('/', async (req, res, next) => {
  try {
    const yyyymm = req.query.month || currentYYYYMM();
    const fx = await getCurrentFX();
    ensureTodaySnapshots();

    const health = computeHealth(yyyymm);
    const recentTx = db.prepare(
      `SELECT t.*, a.name AS account_name FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
       ORDER BY occurred_on DESC, t.id DESC LIMIT 10`
    ).all();
    const subs = db.prepare(`SELECT * FROM subscriptions WHERE active=1 ORDER BY monthly_cost DESC`).all();

    const portfolioReturns = await computePortfolioReturns(fx.rate);
    const patrimonyReturns = computePatrimonyReturns();

    res.render('dashboard', {
      health, recentTx, subs, yyyymm, fx,
      portfolioReturns, patrimonyReturns,
      title: 'Dashboard',
    });
  } catch (e) { next(e); }
});

module.exports = router;
