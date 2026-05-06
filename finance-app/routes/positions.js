const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { syncFromStockScorer, refreshPrices } = require('../lib/stockSync');
const { getCurrentFX, getCachedFX } = require('../lib/fx');
const { todayISO } = require('../lib/format');

router.get('/', async (req, res) => {
  const positions = db.prepare(`SELECT * FROM positions ORDER BY ticker`).all();
  const total = positions.reduce((s, p) => s + (p.shares * p.market_price * p.fx_to_clp), 0);
  const accounts = db.prepare(`SELECT * FROM accounts ORDER BY name`).all();
  const flash = req.session?.flash || null;
  if (req.session) req.session.flash = null;
  const fx = getCachedFX();
  res.render('positions', { positions, accounts, total, flash, fx, today: todayISO(), title: 'Posiciones' });
});

router.post('/buy', async (req, res) => {
  try {
    const { ticker, usd_amount, price_per_share, occurred_on, account_id, description } = req.body;
    const t = String(ticker || '').toUpperCase().trim();
    const usd = Number(usd_amount);
    const price = Number(price_per_share);
    if (!t || !(usd > 0) || !(price > 0)) throw new Error('Ticker, USD y precio son requeridos');

    const fx = await getCurrentFX({ force: true });
    const fxRate = fx.rate;
    const newShares = usd / price;
    const clpAmount = Math.round(usd * fxRate);

    const existing = db.prepare(`SELECT * FROM positions WHERE ticker=?`).get(t);
    if (existing) {
      const totalShares = existing.shares + newShares;
      const totalCostUSD = existing.shares * existing.avg_cost + newShares * price;
      const newAvg = totalCostUSD / totalShares;
      db.prepare(
        `UPDATE positions SET shares=?, avg_cost=?, market_price=?, fx_to_clp=?, updated_at=datetime('now') WHERE id=?`
      ).run(totalShares, newAvg, price, fxRate, existing.id);
    } else {
      db.prepare(
        `INSERT INTO positions (ticker, shares, avg_cost, market_price, currency, fx_to_clp)
         VALUES (?, ?, ?, ?, 'USD', ?)`
      ).run(t, newShares, price, price, fxRate);
    }

    db.prepare(
      `INSERT INTO transactions (kind, amount, category, description, account_id, occurred_on)
       VALUES ('expense', ?, 'inversión', ?, ?, ?)`
    ).run(
      clpAmount,
      description || `Compra ${t} ${newShares.toFixed(7)} sh @ US$${price.toFixed(2)} (US$${usd.toFixed(2)} · FX ${fxRate.toFixed(2)})`,
      account_id ? Number(account_id) : null,
      occurred_on || todayISO()
    );

    if (account_id) {
      const acc = db.prepare(`SELECT * FROM accounts WHERE id=?`).get(Number(account_id));
      if (acc) {
        if (acc.type === 'credit') {
          db.prepare(`UPDATE accounts SET credit_used = COALESCE(credit_used,0) + ?, updated_at=datetime('now') WHERE id=?`).run(clpAmount, acc.id);
        } else {
          db.prepare(`UPDATE accounts SET balance = balance - ?, updated_at=datetime('now') WHERE id=?`).run(clpAmount, acc.id);
        }
      }
    }

    req.session.flash = { type: 'good', text: `Compra registrada: ${t} +${newShares.toFixed(7)} sh @ US$${price} · CLP ${clpAmount.toLocaleString('es-CL')} (FX ${fxRate.toFixed(2)})` };
  } catch (e) {
    req.session.flash = { type: 'bad', text: `Error compra: ${e.message}` };
  }
  res.redirect('/positions');
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
