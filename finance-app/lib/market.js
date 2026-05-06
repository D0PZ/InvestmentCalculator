const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const MINDICADOR_URL = 'https://mindicador.cl/api/dolar';

const COMMON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function fetchChart(symbol, { range = '5d', interval = '1d', period1, period2 } = {}) {
  let qs;
  if (period1 && period2) {
    qs = `period1=${period1}&period2=${period2}&interval=${interval}`;
  } else {
    qs = `range=${range}&interval=${interval}`;
  }
  const url = `${YAHOO_CHART}${encodeURIComponent(symbol)}?${qs}`;
  const res = await fetch(url, { headers: COMMON_HEADERS });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.chart?.result?.[0] || null;
}

async function fetchOneQuote(symbol) {
  const r = await fetchChart(symbol, { range: '5d', interval: '1d' });
  if (!r) return null;
  const meta = r.meta;
  if (!meta?.regularMarketPrice) return null;
  return {
    price: meta.regularMarketPrice,
    currency: meta.currency || 'USD',
    previousClose: meta.chartPreviousClose ?? meta.regularMarketPrice,
    changePercent: meta.chartPreviousClose ? ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose * 100) : 0,
    asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
  };
}

async function fetchQuotes(symbols) {
  if (!symbols || symbols.length === 0) return {};
  const unique = [...new Set(symbols.map(s => s.toUpperCase()))];
  const results = await Promise.all(unique.map(s => fetchOneQuote(s).catch(() => null)));
  const out = {};
  unique.forEach((sym, i) => { if (results[i]) out[sym] = results[i]; });
  return out;
}

async function fetchHistory(symbol, fromISO, toISO) {
  const period1 = Math.floor(new Date(fromISO).getTime() / 1000);
  const period2 = Math.floor(new Date(toISO + 'T23:59:59').getTime() / 1000);
  const r = await fetchChart(symbol, { period1, period2, interval: '1d' });
  if (!r || !r.timestamp) return [];
  const closes = r.indicators?.quote?.[0]?.close || [];
  const rows = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const close = closes[i];
    if (Number.isFinite(close) && close > 0) {
      rows.push({
        date: new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10),
        close,
      });
    }
  }
  return rows;
}

async function fetchUSDCLP() {
  try {
    const res = await fetch(MINDICADOR_URL, { headers: COMMON_HEADERS });
    if (!res.ok) return null;
    const data = await res.json();
    const latest = data?.serie?.[0]?.valor;
    return Number.isFinite(latest) && latest > 0 ? latest : null;
  } catch {
    return null;
  }
}

module.exports = { fetchQuotes, fetchHistory, fetchUSDCLP };
