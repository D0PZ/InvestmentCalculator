const db = require('./db');
const { fetchHistory } = require('./market');

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function variance(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
}

function covariance(a, b) {
  if (a.length !== b.length || a.length < 2) return 0;
  const ma = mean(a), mb = mean(b);
  return a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0) / (a.length - 1);
}

function correlation(a, b) {
  const va = variance(a), vb = variance(b);
  if (va === 0 || vb === 0) return null;
  return covariance(a, b) / Math.sqrt(va * vb);
}

function beta(stock, benchmark) {
  const vb = variance(benchmark);
  if (vb === 0) return null;
  return covariance(stock, benchmark) / vb;
}

function dailyReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    if (prev && prev > 0) out.push((closes[i] - prev) / prev);
    else out.push(0);
  }
  return out;
}

function readCachedRange(ticker, fromISO, toISO) {
  return db.prepare(
    `SELECT date, close FROM price_history WHERE ticker=? AND date BETWEEN ? AND ? ORDER BY date`
  ).all(ticker, fromISO, toISO);
}

function writeCached(ticker, rows) {
  const stmt = db.prepare(
    `INSERT INTO price_history (ticker, date, close) VALUES (?, ?, ?)
     ON CONFLICT(ticker, date) DO UPDATE SET close=excluded.close`
  );
  for (const r of rows) stmt.run(ticker, r.date, r.close);
}

async function getHistory(ticker, fromISO, toISO) {
  const cached = readCachedRange(ticker, fromISO, toISO);
  const expectedTradingDays = Math.floor(
    (new Date(toISO).getTime() - new Date(fromISO).getTime()) / 86400000 * (5 / 7)
  );
  if (cached.length >= expectedTradingDays - 2) return cached;

  try {
    const fresh = await fetchHistory(ticker, fromISO, toISO);
    if (fresh.length > 0) {
      writeCached(ticker, fresh);
      return readCachedRange(ticker, fromISO, toISO);
    }
  } catch {}
  return cached;
}

async function buildAlignedReturns({ tickers, fromISO, toISO }) {
  const seriesByTicker = {};
  for (const t of tickers) {
    const rows = await getHistory(t, fromISO, toISO);
    const map = new Map();
    for (const r of rows) map.set(r.date, Number(r.close));
    seriesByTicker[t] = map;
  }

  let commonDates = null;
  for (const t of tickers) {
    const dates = new Set(seriesByTicker[t].keys());
    if (commonDates === null) commonDates = new Set(dates);
    else for (const d of [...commonDates]) if (!dates.has(d)) commonDates.delete(d);
  }
  const sortedDates = commonDates ? [...commonDates].sort() : [];

  const closesByTicker = {};
  const returnsByTicker = {};
  for (const t of tickers) {
    const closes = sortedDates.map(d => seriesByTicker[t].get(d));
    closesByTicker[t] = closes;
    returnsByTicker[t] = dailyReturns(closes);
  }
  return { dates: sortedDates, closes: closesByTicker, returns: returnsByTicker };
}

async function computePortfolioCorrelation({ positions, benchmarks = ['SPY', 'QQQ'], days = 30 }) {
  if (!positions || positions.length === 0) {
    return { error: 'no positions', benchmarks: {}, per_ticker: [] };
  }
  const buffer = Math.max(14, Math.ceil(days * 0.5));
  const today = new Date();
  const from = new Date(today.getTime() - (days + buffer) * 86400000);
  const fromISO = from.toISOString().slice(0, 10);
  const toISO = today.toISOString().slice(0, 10);

  const portfolioTickers = [...new Set(positions.map(p => p.ticker))];
  const allTickers = [...new Set([...portfolioTickers, ...benchmarks])];

  const aligned = await buildAlignedReturns({ tickers: allTickers, fromISO, toISO });
  const obs = aligned.returns[allTickers[0]]?.length || 0;
  if (obs < 5) {
    return { error: `pocos datos (${obs} observaciones)`, observations: obs, benchmarks: {}, per_ticker: [] };
  }

  const lastIdx = aligned.dates.length - 1;
  const lastPx = (t) => aligned.closes[t]?.[lastIdx] || 0;
  const totalValue = positions.reduce((s, p) => s + p.shares * lastPx(p.ticker), 0);

  const weights = {};
  for (const p of positions) {
    const value = p.shares * lastPx(p.ticker);
    weights[p.ticker] = totalValue > 0 ? value / totalValue : 0;
  }

  const portfolioReturns = [];
  for (let i = 0; i < obs; i++) {
    let r = 0;
    for (const p of positions) {
      r += weights[p.ticker] * (aligned.returns[p.ticker][i] || 0);
    }
    portfolioReturns.push(r);
  }

  const portfolioCum = portfolioReturns.reduce((s, r) => s * (1 + r), 1) - 1;
  const portfolioVol = Math.sqrt(variance(portfolioReturns));
  const portfolioAvg = mean(portfolioReturns);

  const result = {
    window_days: days,
    observations: obs,
    date_from: aligned.dates[0] || null,
    date_to: aligned.dates[lastIdx] || null,
    portfolio: {
      avg_daily: portfolioAvg,
      vol_daily: portfolioVol,
      cumulative: portfolioCum,
      weights,
    },
    benchmarks: {},
    per_ticker: [],
  };

  for (const b of benchmarks) {
    const bReturns = aligned.returns[b];
    if (!bReturns || bReturns.length === 0) {
      result.benchmarks[b] = { error: 'sin datos históricos' };
      continue;
    }
    const corr = correlation(portfolioReturns, bReturns);
    const bet = beta(portfolioReturns, bReturns);
    const bCum = bReturns.reduce((s, r) => s * (1 + r), 1) - 1;
    const explained = corr != null ? corr * corr : null;
    result.benchmarks[b] = {
      correlation: corr,
      r_squared: explained,
      beta: bet,
      cumulative_return: bCum,
      market_explained_pct: explained != null ? +(explained * 100).toFixed(1) : null,
      stock_specific_pct: explained != null ? +((1 - explained) * 100).toFixed(1) : null,
    };
  }

  for (const p of positions) {
    const pReturns = aligned.returns[p.ticker];
    if (!pReturns) continue;
    const entry = {
      ticker: p.ticker,
      weight: +(weights[p.ticker] * 100).toFixed(2),
      cumulative: pReturns.reduce((s, r) => s * (1 + r), 1) - 1,
    };
    for (const b of benchmarks) {
      const bReturns = aligned.returns[b];
      if (!bReturns || bReturns.length === 0) continue;
      entry[`corr_${b}`] = correlation(pReturns, bReturns);
      entry[`beta_${b}`] = beta(pReturns, bReturns);
    }
    result.per_ticker.push(entry);
  }
  result.per_ticker.sort((a, b) => b.weight - a.weight);

  return result;
}

module.exports = {
  computePortfolioCorrelation,
  correlation,
  beta,
  variance,
  covariance,
  dailyReturns,
};
