#!/usr/bin/env node
// Resumen rápido del paper-trading ML: winrate, P&L bruto/neto, breakdown por ticker y outcome.
// Uso: node scripts/ml_stats.js
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'finance.db');
const db = new DatabaseSync(dbPath);

const trades = db.prepare('SELECT * FROM ml_trades ORDER BY exit_ts').all();
const open = db.prepare("SELECT * FROM ml_positions").all();
const signals = db.prepare('SELECT COUNT(*) as n FROM ml_signals').get().n;

console.log('====================================');
console.log(`  ML Standalone — resumen`);
console.log(`  ${new Date().toISOString()}`);
console.log('====================================\n');
console.log(`Señales emitidas: ${signals}`);
console.log(`Posiciones abiertas: ${open.length}`);
console.log(`Trades cerrados: ${trades.length}\n`);

if (open.length > 0) {
  console.log('--- Posiciones abiertas ---');
  for (const p of open) console.log(`  ${String(p.symbol).padEnd(6)} entry=${Number(p.entry).toFixed(2)} prob=${Number(p.prob).toFixed(3)} ts=${new Date(p.entry_ts).toISOString().slice(0,16)}`);
  console.log('');
}

if (trades.length === 0) {
  console.log('Sin trades cerrados todavía.');
  process.exit(0);
}

const wins = trades.filter(t => t.net_pct > 0).length;
const losses = trades.filter(t => t.net_pct <= 0).length;
const grossSum = trades.reduce((a, t) => a + Number(t.gross_pct), 0);
const netSum = trades.reduce((a, t) => a + Number(t.net_pct), 0);
const pnlSum = trades.reduce((a, t) => a + Number(t.pnl_usd || 0), 0);

console.log('--- Agregado ---');
console.log(`  Trades: ${trades.length} (W ${wins} / L ${losses})`);
console.log(`  Winrate: ${(wins / trades.length * 100).toFixed(1)}%`);
console.log(`  Gross/trade: ${(grossSum / trades.length).toFixed(3)}%   Total bruto: ${grossSum.toFixed(2)}%`);
console.log(`  Net/trade:   ${(netSum / trades.length).toFixed(3)}%   Total neto:  ${netSum.toFixed(2)}%`);
console.log(`  P&L USD acumulado: $${pnlSum.toFixed(2)}\n`);

console.log('--- Por ticker ---');
const byTicker = {};
for (const t of trades) {
  const k = t.symbol;
  if (!byTicker[k]) byTicker[k] = { n: 0, w: 0, net: 0, pnl: 0 };
  byTicker[k].n++;
  if (t.net_pct > 0) byTicker[k].w++;
  byTicker[k].net += Number(t.net_pct);
  byTicker[k].pnl += Number(t.pnl_usd || 0);
}
const rows = Object.entries(byTicker).sort((a, b) => b[1].net - a[1].net);
console.log('  ticker   n   wr%    net/trade  total_net%   pnl_usd');
for (const [sym, s] of rows) {
  console.log(`  ${sym.padEnd(6)} ${String(s.n).padStart(3)}  ${(s.w/s.n*100).toFixed(1).padStart(5)}  ${(s.net/s.n).toFixed(3).padStart(8)}  ${s.net.toFixed(2).padStart(9)}  ${s.pnl.toFixed(2).padStart(7)}`);
}

console.log('\n--- Por outcome ---');
const byOut = {};
for (const t of trades) byOut[t.outcome] = (byOut[t.outcome] || 0) + 1;
for (const [o, n] of Object.entries(byOut).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${o.padEnd(10)} ${n}`);
}
