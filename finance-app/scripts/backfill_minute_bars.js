#!/usr/bin/env node
const minuteBars = require('../lib/minuteBars');
const { getLiveFeed } = require('../lib/liveFeed');

const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const COMMON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0',
  'Accept': 'application/json,text/plain,*/*',
};

const ONE_DAY = 86400 * 1000;
const CHUNK_DAYS = 7;
const TOTAL_DAYS = Number(process.env.BACKFILL_DAYS) || 30;

async function fetchYahooMinute(symbol, fromMs, toMs) {
  const period1 = Math.floor(fromMs / 1000);
  const period2 = Math.floor(toMs / 1000);
  const url = `${YAHOO_CHART}${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1m`;
  const res = await fetch(url, { headers: COMMON_HEADERS });
  if (!res.ok) throw new Error(`Yahoo ${symbol}: HTTP ${res.status}`);
  const data = await res.json();
  const r = data?.chart?.result?.[0];
  if (!r || !r.timestamp) return [];
  const closes = r.indicators?.quote?.[0]?.close || [];
  const opens = r.indicators?.quote?.[0]?.open || [];
  const highs = r.indicators?.quote?.[0]?.high || [];
  const lows = r.indicators?.quote?.[0]?.low || [];
  const vols = r.indicators?.quote?.[0]?.volume || [];
  const bars = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const c = closes[i];
    if (!Number.isFinite(c)) continue;
    bars.push({
      t: r.timestamp[i] * 1000,
      o: Number.isFinite(opens[i]) ? opens[i] : c,
      h: Number.isFinite(highs[i]) ? highs[i] : c,
      l: Number.isFinite(lows[i]) ? lows[i] : c,
      c,
      v: Number.isFinite(vols[i]) ? vols[i] : 0,
    });
  }
  return bars;
}

async function backfillSymbol(symbol, totalDays = TOTAL_DAYS) {
  const now = Date.now();
  const earliest = now - totalDays * ONE_DAY;
  let cursor = now;
  let totalInserted = 0;
  let chunks = 0;

  while (cursor > earliest) {
    const from = Math.max(earliest, cursor - CHUNK_DAYS * ONE_DAY);
    try {
      const bars = await fetchYahooMinute(symbol, from, cursor);
      const inserted = minuteBars.upsertBatch(symbol, bars, 'yahoo');
      totalInserted += inserted;
      chunks++;
      console.log(`  [${symbol}] chunk ${chunks}: ${bars.length} fetched, ${inserted} saved (${new Date(from).toISOString().slice(0,10)} → ${new Date(cursor).toISOString().slice(0,10)})`);
      if (bars.length === 0) break;
    } catch (err) {
      console.error(`  [${symbol}] chunk error:`, err.message);
    }
    cursor = from - 60_000;
    await new Promise(r => setTimeout(r, 300));
  }
  return totalInserted;
}

async function main() {
  const argSymbols = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const watchlist = argSymbols.length > 0
    ? argSymbols.map(s => s.toUpperCase())
    : getLiveFeed().watchlist;
  console.log(`Backfilling ${watchlist.length} tickers, ~${TOTAL_DAYS} días back, chunks de ${CHUNK_DAYS}d`);
  console.log('watchlist:', watchlist.join(', '));

  const start = Date.now();
  let grandTotal = 0;
  for (const sym of watchlist) {
    console.log(`\n→ ${sym}`);
    try {
      const n = await backfillSymbol(sym);
      grandTotal += n;
      console.log(`  ${sym}: total ${n} bars`);
    } catch (err) {
      console.error(`  ${sym} failed:`, err.message);
    }
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone: ${grandTotal} bars insertados/actualizados en ${elapsed}s`);

  console.log('\nResumen por ticker:');
  for (const s of minuteBars.statsByTicker()) {
    const first = s.first_ts ? new Date(s.first_ts).toISOString().slice(0, 10) : '—';
    const last = s.last_ts ? new Date(s.last_ts).toISOString().slice(0, 10) : '—';
    console.log(`  ${s.ticker.padEnd(6)} ${String(s.n_bars).padStart(6)} bars  (${first} → ${last})  live=${s.live_bars} backfill=${s.backfilled_bars}`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
