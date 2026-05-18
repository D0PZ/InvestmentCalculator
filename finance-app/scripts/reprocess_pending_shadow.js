#!/usr/bin/env node
// Reprocesa filas de shadow_predictions con predict_status='pending' o vacío.
// Útil tras un crash del proceso entre el INSERT del row y el resolve del predict.
//
// Uso:
//   node scripts/reprocess_pending_shadow.js          # procesa todas las pending
//   node scripts/reprocess_pending_shadow.js --limit 50

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const db = require('../lib/db');
const mlClient = require('../lib/mlClient');
const { recentBars } = require('../lib/minuteBars');
const log = require('../lib/logger').child('reprocess-shadow');

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Math.max(1, Number(args[limitIdx + 1]) || 100) : 100;

async function main() {
  if (!mlClient.ENABLED) {
    log.warn('ML_PREDICT_ENABLED=false — nada que hacer');
    return;
  }
  const health = await mlClient.health();
  if (!health || !health.ok) {
    log.error({ url: mlClient.ML_URL, err: health?.error }, 'predict service no responde');
    process.exitCode = 1;
    return;
  }

  const rows = db.prepare(
    `SELECT id, symbol, entry_ts, entry_price
       FROM shadow_predictions
      WHERE predict_status='pending' OR predict_status IS NULL
      ORDER BY id ASC
      LIMIT ?`
  ).all(LIMIT);

  log.info({ count: rows.length, limit: LIMIT }, 'reprocessing pending shadow predictions');

  let done = 0, skipped = 0, failed = 0;
  for (const r of rows) {
    const bars = recentBars(r.symbol, 120, r.entry_ts);
    if (!bars || bars.length < 60) {
      db.prepare(`UPDATE shadow_predictions SET predict_status='skipped_no_bars' WHERE id=?`).run(r.id);
      skipped++;
      continue;
    }
    const payload = bars.map(b => ({
      t: b.ts, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume,
    }));
    const resp = await mlClient.predict({ symbol: r.symbol, bars: payload });
    if (!resp || resp.ok === false || typeof resp.prob !== 'number') {
      const status = resp?.error ? `error: ${String(resp.error).slice(0, 80)}` : 'no_prob';
      db.prepare(`UPDATE shadow_predictions SET predict_status=? WHERE id=?`).run(status, r.id);
      failed++;
      continue;
    }
    db.prepare(
      `UPDATE shadow_predictions
          SET prob=?, model_meta_json=?, features_json=?, predict_status='done'
        WHERE id=?`
    ).run(
      resp.prob,
      JSON.stringify(resp.meta || null),
      JSON.stringify(resp.feature_snapshot || null),
      r.id,
    );
    done++;
  }

  log.info({ done, skipped, failed, total: rows.length }, 'reprocess complete');
}

main().catch((err) => {
  log.error({ err }, 'reprocess fatal');
  process.exitCode = 1;
});
