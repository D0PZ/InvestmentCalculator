// Integration smoke test: predict service + shadow_predictions insert.
// Asume que predict_service está corriendo en :8001.

const db = require('../lib/db');
const mlClient = require('../lib/mlClient');
const { recentBars } = require('../lib/minuteBars');

async function main() {
  console.log('1) health check predict service...');
  const h = await mlClient.health();
  console.log('   ', h);
  if (!h?.ok) {
    console.error('predict service no responde. Inicia con: uvicorn predict_service:app --port 8001');
    process.exit(1);
  }

  const symbol = 'MSFT';
  const bars = recentBars(symbol, 120);
  console.log(`2) ${symbol} bars cargadas: ${bars.length}`);
  if (bars.length < 60) {
    console.error('no hay suficientes bars en minute_bars para', symbol);
    process.exit(1);
  }

  const payload = bars.map(b => ({ t: b.ts, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume }));
  const resp = await mlClient.predict({ symbol, bars: payload });
  console.log('3) predict resp:', { ok: resp?.ok, prob: resp?.prob, ts: resp?.ts });
  if (resp?.ok !== true) process.exit(1);

  const lastBar = bars[bars.length - 1];
  const info = db.prepare(
    `INSERT INTO shadow_predictions
       (symbol, entry_ts, entry_price, prob, model_meta_json, features_json, signal_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(symbol, lastBar.ts, lastBar.close, resp.prob,
        JSON.stringify(resp.meta || null),
        JSON.stringify(resp.feature_snapshot || null), null);
  console.log('4) inserted shadow_prediction id =', info.lastInsertRowid);

  const row = db.prepare('SELECT * FROM shadow_predictions WHERE id=?').get(info.lastInsertRowid);
  console.log('5) read back:', { id: row.id, symbol: row.symbol, prob: row.prob, entry_price: row.entry_price });

  // resolve
  db.prepare(
    `UPDATE shadow_predictions SET outcome=?, exit_ts=?, exit_price=?, pnl_pct=? WHERE id=?`
  ).run('WIN', lastBar.ts + 10*60*1000, lastBar.close*1.006, 0.6, info.lastInsertRowid);
  const after = db.prepare('SELECT outcome, pnl_pct FROM shadow_predictions WHERE id=?').get(info.lastInsertRowid);
  console.log('6) after resolve:', after);

  // cleanup
  db.prepare('DELETE FROM shadow_predictions WHERE id=?').run(info.lastInsertRowid);
  console.log('7) cleaned up.');
  console.log('\nOK — shadow integration end-to-end funciona.');
}

main().catch(e => { console.error(e); process.exit(1); });
