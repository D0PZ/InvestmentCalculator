/**
 * Backfill de catalizadores desde Finnhub para toda la watchlist.
 *
 * Pobla la tabla `catalysts` con:
 *   - earnings:   histórico (~400d) + próximas fechas  → feature días-a-earnings del modelo
 *   - reco_trend: histórico de consenso buy/hold/sell mensual
 *   - rating:     acciones de analistas detectadas en company-news (~365d)
 *
 * Uso:  node scripts/backfill_catalysts.js
 * Respeta rate limit (free 60/min) con gaps; no emite alertas (emit:false).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../lib/db');
const { getCatalystStream } = require('../lib/catalystStream');

function parseWatchlist() {
  return (process.env.LIVE_WATCHLIST || '')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
}

(async () => {
  const watchlist = parseWatchlist();
  if (!process.env.FINNHUB_API_KEY) {
    console.error('FALTA FINNHUB_API_KEY en .env'); process.exit(1);
  }
  if (watchlist.length === 0) {
    console.error('LIVE_WATCHLIST vacío en .env'); process.exit(1);
  }
  console.log(`Backfill catalysts para ${watchlist.length} tickers: ${watchlist.join(', ')}`);
  const t0 = Date.now();
  const cs = getCatalystStream({ watchlist });

  const summary = await cs.backfillOnce({
    newsLookbackDays: 365,
    earningsFromDays: -400,
    endpointGapMs: 400,
    onProgress: (ticker, i, n, stats) => {
      console.log(`  [${String(i).padStart(2)}/${n}] ${ticker.padEnd(6)} → inserts=${stats.inserts} errors=${stats.errors}`);
    },
  });

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\nListo en ${secs}s. ${JSON.stringify(summary)}`);

  // Resumen por tipo
  const byType = db.prepare(
    `SELECT type, COUNT(*) AS n FROM catalysts GROUP BY type ORDER BY n DESC`
  ).all();
  console.log('Filas en catalysts por tipo:', JSON.stringify(byType));

  // Conteo de ratings detectados por ticker (lo más interesante)
  const byTicker = db.prepare(
    `SELECT ticker, COUNT(*) AS n FROM catalysts WHERE type='rating' GROUP BY ticker ORDER BY n DESC`
  ).all();
  console.log('Acciones de analistas (rating) detectadas por ticker:', JSON.stringify(byTicker));

  // Muestra de radar para 3 nombres
  for (const sym of ['TTWO', 'NVDA', 'MSFT']) {
    const r = cs.getRadar([sym])[0];
    console.log(`\n── RADAR ${sym} ──`);
    console.log('  nextEarnings:', JSON.stringify(r.nextEarnings));
    console.log('  reco:', r.reco ? `score ${r.reco.score} (${r.reco.period}) ${r.reco.sentiment}` : null);
    console.log('  ratings(top3):', JSON.stringify(r.ratings.slice(0, 3).map(x => ({ d: x.event_date, s: x.sentiment, firm: x.firm, h: (x.headline || '').slice(0, 70) }))));
  }
})().catch(e => { console.error('backfill error:', e); process.exit(1); });
