const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { syncFromStockScorer, refreshPrices } = require('../lib/stockSync');
const { getCurrentFX, getCachedFX } = require('../lib/fx');
const { todayISO } = require('../lib/format');
const { computePositionReturns } = require('../lib/returns');
const { ensurePriceCacheRow } = require('../lib/portfolio');

function genManualOrderId(ticker) {
  return `MANUAL-${ticker}-${Date.now().toString(36).toUpperCase()}`;
}

router.get('/', async (req, res, next) => {
  try {
    const fx = getCachedFX();
    const positions = await computePositionReturns(fx.rate);
    const total = positions.reduce((s, p) => s + p.value_clp, 0);
    const totalCost = positions.reduce((s, p) => s + p.cost_clp, 0);
    const accounts = db.prepare(`SELECT * FROM accounts ORDER BY name`).all();
    const flash = req.session?.flash || null;
    if (req.session) req.session.flash = null;
    res.render('positions', {
      positions, accounts, total, totalCost,
      flash, fx, today: todayISO(),
      title: 'Posiciones',
    });
  } catch (e) { next(e); }
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
    const tradeDate = occurred_on ? String(occurred_on).slice(0, 10) : todayISO();
    const orderId = genManualOrderId(t);

    db.prepare(
      `INSERT INTO trades (order_id, ticker, side, shares, price_usd, amount_usd, fx_clp, trade_date, source)
       VALUES (?, ?, 'BUY', ?, ?, ?, ?, ?, 'manual')`
    ).run(orderId, t, newShares, price, +(newShares * price).toFixed(4), fxRate, tradeDate);

    ensurePriceCacheRow(t, price, fxRate);

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

router.post('/sell', async (req, res) => {
  try {
    const { ticker, usd_amount, price_per_share, occurred_on } = req.body;
    const t = String(ticker || '').toUpperCase().trim();
    const usd = Number(usd_amount);
    const price = Number(price_per_share);
    if (!t || !(usd > 0) || !(price > 0)) throw new Error('Ticker, USD y precio son requeridos');

    const fx = await getCurrentFX({ force: true });
    const fxRate = fx.rate;
    const soldShares = usd / price;
    const tradeDate = occurred_on ? String(occurred_on).slice(0, 10) : todayISO();
    const orderId = genManualOrderId(t);

    const net = db.prepare(`
      SELECT SUM(CASE WHEN side='BUY' THEN shares ELSE -shares END) AS net FROM trades WHERE ticker=?
    `).get(t)?.net || 0;
    if (soldShares > net + 0.0001) {
      throw new Error(`Estás vendiendo ${soldShares.toFixed(8)} pero solo tienes ${net.toFixed(8)} de ${t}`);
    }

    db.prepare(
      `INSERT INTO trades (order_id, ticker, side, shares, price_usd, amount_usd, fx_clp, trade_date, source)
       VALUES (?, ?, 'SELL', ?, ?, ?, ?, ?, 'manual')`
    ).run(orderId, t, soldShares, price, +(soldShares * price).toFixed(4), fxRate, tradeDate);

    ensurePriceCacheRow(t, price, fxRate);

    req.session.flash = { type: 'good', text: `Venta registrada: ${t} ${soldShares.toFixed(7)} sh @ US$${price} = US$${(soldShares*price).toFixed(2)}` };
  } catch (e) {
    req.session.flash = { type: 'bad', text: `Error venta: ${e.message}` };
  }
  res.redirect('/positions');
});

router.post('/:ticker/close', (req, res) => {
  try {
    const t = String(req.params.ticker || '').toUpperCase();
    const count = db.prepare(`DELETE FROM trades WHERE ticker=?`).run(t).changes;
    db.prepare(`DELETE FROM positions WHERE ticker=?`).run(t);
    req.session.flash = { type: 'good', text: `Borrados ${count} trades de ${t} (acción cerrada del historial)` };
  } catch (e) {
    req.session.flash = { type: 'bad', text: `Error: ${e.message}` };
  }
  res.redirect('/positions');
});

module.exports = router;
