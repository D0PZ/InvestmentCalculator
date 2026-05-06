const STOOQ_URL = 'https://stooq.com/q/l/';
const MINDICADOR_URL = 'https://mindicador.cl/api/dolar';

function toStooqSymbol(t) {
  if (!t) return '';
  if (t.includes('.')) return t.toLowerCase();
  return t.toLowerCase() + '.us';
}

function parseStooqCSV(csv) {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const cells = line.split(',');
    const row = {};
    headers.forEach((h, i) => row[h] = cells[i]);
    return row;
  });
}

async function fetchOne(symbol) {
  const stooq = toStooqSymbol(symbol);
  const url = `${STOOQ_URL}?s=${encodeURIComponent(stooq)}&f=sd2t2ohlcv&h&e=csv`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (finance-app)' } });
  if (!res.ok) return null;
  const rows = parseStooqCSV(await res.text());
  const row = rows[0];
  if (!row) return null;
  const close = Number(row.Close);
  if (!Number.isFinite(close) || close === 0) return null;
  const open = Number(row.Open);
  return {
    price: close,
    currency: 'USD',
    previousClose: Number.isFinite(open) ? open : close,
    changePercent: Number.isFinite(open) && open ? ((close - open) / open * 100) : 0,
    asOf: row.Date && row.Time ? `${row.Date} ${row.Time}` : null,
  };
}

async function fetchQuotes(symbols) {
  if (!symbols || symbols.length === 0) return {};
  const unique = [...new Set(symbols.map(s => s.toUpperCase()))];
  const results = await Promise.all(unique.map(s => fetchOne(s).catch(() => null)));
  const out = {};
  unique.forEach((sym, i) => { if (results[i]) out[sym] = results[i]; });
  return out;
}

async function fetchUSDCLP() {
  try {
    const res = await fetch(MINDICADOR_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (finance-app)' } });
    if (!res.ok) return null;
    const data = await res.json();
    const latest = data?.serie?.[0]?.valor;
    return Number.isFinite(latest) && latest > 0 ? latest : null;
  } catch {
    return null;
  }
}

module.exports = { fetchQuotes, fetchUSDCLP };
