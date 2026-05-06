const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { syncFromStockScorer, refreshPrices } = require('../lib/stockSync');

router.get('/', (req, res) => {
  const positions = db.prepare(`SELECT * FROM positions ORDER BY ticker`).all();
  const total = positions.reduce((s, p) => s + (p.shares * p.market_price * p.fx_to_clp), 0);
  const flash = req.session?.flash || null;
  if (req.session) req.session.flash = null;
  res.render('positions', { positions, total, flash, title: 'Posiciones' });
});

router.post('/sync', async (req, res) => {
  try {
    const result = await syncFromStockScorer();
    req.session.flash = { type: 'good', text: `Sync OK · importadas ${result.imported}, actualizadas ${result.updated}, FX USD/CLP ${result.fx}` };
  } catch (e) {
    req.session.flash = { type: 'bad', text: `Error sync: ${e.message}` };
  }
  res.redirect('/positions');
});

router.post('/refresh', async (req, res) => {
  try {
    const result = await refreshPrices();
    req.session.flash = { type: 'good', text: `Precios actualizados: ${result.refreshed}/${result.total} · FX ${result.fx}` };
  } catch (e) {
    req.session.flash = { type: 'bad', text: `Error refresh: ${e.message}` };
  }
  res.redirect('/positions');
});

router.post('/', (req, res) => {
  const { ticker, shares, avg_cost, market_price, currency, fx_to_clp } = req.body;
  db.prepare(
    `INSERT INTO positions (ticker, shares, avg_cost, market_price, currency, fx_to_clp)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    ticker.toUpperCase(),
    Number(shares),
    Number(avg_cost),
    Number(market_price),
    currency || 'USD',
    Number(fx_to_clp) || 1
  );
  res.redirect('/positions');
});

router.post('/:id/update', (req, res) => {
  const { shares, avg_cost, market_price, fx_to_clp } = req.body;
  db.prepare(
    `UPDATE positions SET shares=?, avg_cost=?, market_price=?, fx_to_clp=?, updated_at=datetime('now') WHERE id=?`
  ).run(Number(shares), Number(avg_cost), Number(market_price), Number(fx_to_clp), Number(req.params.id));
  res.redirect('/positions');
});

router.post('/:id/delete', (req, res) => {
  db.prepare(`DELETE FROM positions WHERE id=?`).run(Number(req.params.id));
  res.redirect('/positions');
});

module.exports = router;
