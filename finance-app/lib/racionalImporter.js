const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const { fetchUSDCLPNearest } = require('./fxHistorical');

const FILE = path.join(__dirname, '..', 'racional.txt');

const TRADE_BLOCK_RE = /(?:(?:Compraste|Vendiste)\s+US\$[\d.,]+\s+de\s+[^()]+\([A-Z]{1,6}\)|Tu (?:compra|venta) de\s+[A-Z]{1,6})[\s\S]*?Orden\s+#([0-9A-F]{6,})\s*\n\s*(Recibiste|Vendiste)\s+([\d.,]+)\s+acciones\s+de\s+[^()]+\(([A-Z]{1,6})\)[^.]*?a un valor de US\$([\d.,]+)\s+por acción/g;
const INNER_DATE_RE = /Orden\s*\n\s*enviada\s*\n\s*(\d{2}\/\d{2}\/\d{2})/;
const SIMPLE_CSV_RE = /^([A-Z.]{1,6})\s*,\s*([\d.,]+)\s*,\s*([\d.,]+)(?:\s*,\s*(\S+))?\s*$/;

function parseNumberCL(s) {
  if (s == null) return NaN;
  const cleaned = String(s).trim().replace(/\./g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function dmyToISO(dmy) {
  const m = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(dmy);
  if (!m) return null;
  const [, d, mo, y] = m;
  const yyyy = `20${y}`;
  return `${yyyy}-${mo}-${d}`;
}

function extractRacionalTrades(text) {
  const trades = [];
  let m;
  TRADE_BLOCK_RE.lastIndex = 0;
  while ((m = TRADE_BLOCK_RE.exec(text)) !== null) {
    const orderId = m[1].toUpperCase();
    const verb = m[2];
    const shares = parseNumberCL(m[3]);
    const symbol = m[4].toUpperCase();
    const price = parseNumberCL(m[5]);
    if (!Number.isFinite(shares) || !Number.isFinite(price) || shares <= 0 || price <= 0) continue;

    const side = verb === 'Vendiste' ? 'SELL' : 'BUY';
    const blockText = m[0];
    const dm = INNER_DATE_RE.exec(blockText);
    const tradeDate = dm ? dmyToISO(dm[1]) : null;

    trades.push({
      orderId,
      symbol,
      side,
      shares,
      price,
      amount: +(shares * price).toFixed(4),
      tradeDate,
    });
  }

  return trades;
}

function extractCsvLines(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    const m = SIMPLE_CSV_RE.exec(trimmed);
    if (m) {
      const symbol = m[1].toUpperCase();
      const shares = parseNumberCL(m[2]);
      const price = parseNumberCL(m[3]);
      if (Number.isFinite(shares) && Number.isFinite(price) && shares > 0 && price > 0) {
        rows.push({ symbol, shares, price });
      }
    }
  }
  return rows;
}

function upsertTrade(t, fxClp) {
  db.prepare(
    `INSERT INTO trades (order_id, ticker, side, shares, price_usd, amount_usd, fx_clp, trade_date, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'racional.txt')
     ON CONFLICT(order_id) DO UPDATE SET
       ticker=excluded.ticker,
       side=excluded.side,
       shares=excluded.shares,
       price_usd=excluded.price_usd,
       amount_usd=excluded.amount_usd,
       fx_clp=COALESCE(excluded.fx_clp, trades.fx_clp),
       trade_date=excluded.trade_date`
  ).run(t.orderId, t.symbol, t.side, t.shares, t.price, t.amount, fxClp || null, t.tradeDate || '');
}

async function syncTradesFromText(text) {
  const trades = extractRacionalTrades(text);
  let buys = 0, sells = 0, withFx = 0;
  for (const t of trades) {
    let fx = null;
    if (t.tradeDate) {
      try {
        const fxResult = await fetchUSDCLPNearest(t.tradeDate);
        if (fxResult) { fx = fxResult.rate; withFx++; }
      } catch {}
    }
    upsertTrade(t, fx);
    if (t.side === 'BUY') buys++; else sells++;
  }
  return { buys, sells, withFx, total: trades.length };
}

function netPositionsFromDB() {
  const rows = db.prepare(`
    SELECT ticker,
           SUM(CASE WHEN side='BUY' THEN shares ELSE 0 END) AS bought,
           SUM(CASE WHEN side='SELL' THEN shares ELSE 0 END) AS sold,
           SUM(CASE WHEN side='BUY' THEN shares*price_usd ELSE 0 END) AS cost_usd,
           SUM(CASE WHEN side='BUY' THEN shares*price_usd*COALESCE(fx_clp,0) ELSE 0 END) AS cost_clp,
           SUM(CASE WHEN side='BUY' THEN CASE WHEN fx_clp IS NOT NULL THEN shares ELSE 0 END ELSE 0 END) AS shares_with_fx,
           MIN(CASE WHEN side='BUY' THEN trade_date END) AS first_buy
    FROM trades
    GROUP BY ticker
  `).all();

  const positions = [];
  for (const r of rows) {
    const bought = Number(r.bought) || 0;
    const sold = Number(r.sold) || 0;
    const net = bought - sold;
    if (net <= 0.000001) continue;
    const costUSD = Number(r.cost_usd) || 0;
    const avgCost = costUSD / bought;
    const fxCovered = Number(r.shares_with_fx) || 0;
    const costClp = Number(r.cost_clp) || 0;
    positions.push({
      symbol: r.ticker,
      shares: +net.toFixed(8),
      costBasis: +avgCost.toFixed(4),
      costUSD: +costUSD.toFixed(2),
      costCLP: fxCovered > 0 ? Math.round(costClp * (bought / fxCovered)) : null,
      openTs: r.first_buy ? new Date(r.first_buy + 'T00:00:00Z').getTime() : null,
    });
  }
  positions.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return positions;
}

async function loadRacionalPositions(filePath = FILE) {
  let raw = '';
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch { return { positions: [], buys: 0, sells: 0, error: null }; }

  const result = await syncTradesFromText(raw);

  let positions = netPositionsFromDB();

  if (positions.length === 0 && result.total === 0) {
    const csvRows = extractCsvLines(raw);
    if (csvRows.length > 0) {
      const sym = new Map();
      const cost = new Map();
      for (const r of csvRows) {
        sym.set(r.symbol, (sym.get(r.symbol) || 0) + r.shares);
        cost.set(r.symbol, (cost.get(r.symbol) || 0) + r.shares * r.price);
      }
      positions = [...sym].map(([s, sh]) => ({
        symbol: s,
        shares: +sh.toFixed(8),
        costBasis: +(cost.get(s) / sh).toFixed(4),
        costUSD: +cost.get(s).toFixed(2),
        costCLP: null,
        openTs: null,
      })).sort((a, b) => a.symbol.localeCompare(b.symbol));
    }
  }

  return {
    positions,
    buys: result.buys,
    sells: result.sells,
    withFx: result.withFx,
    error: null,
  };
}

function getAllTrades() {
  return db.prepare(`SELECT * FROM trades ORDER BY trade_date, created_at`).all();
}

function getRealizedPL() {
  const rows = db.prepare(`
    SELECT ticker,
           SUM(CASE WHEN side='BUY' THEN shares ELSE 0 END) AS bought,
           SUM(CASE WHEN side='SELL' THEN shares ELSE 0 END) AS sold,
           SUM(CASE WHEN side='BUY' THEN shares*price_usd ELSE 0 END) AS buy_cost,
           SUM(CASE WHEN side='SELL' THEN shares*price_usd ELSE 0 END) AS sell_proceeds
    FROM trades
    GROUP BY ticker
    HAVING sold > 0
  `).all();

  return rows.map(r => {
    const bought = Number(r.bought) || 0;
    const sold = Number(r.sold) || 0;
    const buyCost = Number(r.buy_cost) || 0;
    const sellProc = Number(r.sell_proceeds) || 0;
    const avgBuy = bought > 0 ? buyCost / bought : 0;
    const realizedCost = +(avgBuy * sold).toFixed(2);
    const realizedPnl = +(sellProc - realizedCost).toFixed(2);
    const realizedPct = realizedCost > 0 ? +(realizedPnl / realizedCost * 100).toFixed(2) : null;
    return {
      ticker: r.ticker,
      soldShares: +sold.toFixed(8),
      avgBuyPrice: +avgBuy.toFixed(4),
      proceedsUSD: +sellProc.toFixed(2),
      costUSD: realizedCost,
      pnlUSD: realizedPnl,
      pnlPct: realizedPct,
      fullyClosed: bought - sold <= 0.000001,
    };
  });
}

module.exports = {
  loadRacionalPositions,
  syncTradesFromText,
  extractRacionalTrades,
  netPositionsFromDB,
  getAllTrades,
  getRealizedPL,
  FILE,
};
