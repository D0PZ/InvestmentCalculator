const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Crea una DB con el schema VIEJO de shadow_predictions (prob NOT NULL, sin predict_status),
// inserta una row, luego carga el módulo lib/db (que dispara la migración) y verifica el resultado.
test('migrateShadowPredictions: NOT NULL prob → NULLABLE + predict_status', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-mig-'));
  const dbPath = path.join(tmp, 'old.db');

  // 1. Crear DB vieja
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE shadow_predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      entry_ts INTEGER NOT NULL,
      entry_price REAL NOT NULL,
      prob REAL NOT NULL,
      model_meta_json TEXT,
      features_json TEXT,
      signal_id INTEGER,
      outcome TEXT,
      exit_ts INTEGER,
      exit_price REAL,
      pnl_pct REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  raw.prepare(
    `INSERT INTO shadow_predictions (symbol, entry_ts, entry_price, prob) VALUES (?, ?, ?, ?)`
  ).run('AAPL', 1000, 150.5, 0.72);
  raw.close();

  // 2. Apuntar DB_PATH y cargar lib/db (forzar reload limpio)
  process.env.DB_PATH = dbPath;
  delete require.cache[require.resolve('../lib/db')];
  require('../lib/db');

  // 3. Reabrir y validar schema
  const raw2 = new DatabaseSync(dbPath);
  const cols = raw2.prepare(`PRAGMA table_info(shadow_predictions)`).all();
  const probCol = cols.find(c => c.name === 'prob');
  const statusCol = cols.find(c => c.name === 'predict_status');

  assert.ok(probCol, 'prob column existe');
  assert.equal(probCol.notnull, 0, 'prob ya no es NOT NULL');
  assert.ok(statusCol, 'predict_status column existe');

  // Los datos viejos sobreviven y predict_status='done' (porque prob NOT NULL).
  const row = raw2.prepare(`SELECT prob, predict_status FROM shadow_predictions WHERE symbol=?`).get('AAPL');
  assert.equal(row.prob, 0.72);
  assert.equal(row.predict_status, 'done');

  // Insertar nueva row con prob=NULL debe funcionar
  raw2.prepare(
    `INSERT INTO shadow_predictions (symbol, entry_ts, entry_price, predict_status) VALUES (?, ?, ?, ?)`
  ).run('TSLA', 2000, 200, 'pending');
  const pending = raw2.prepare(`SELECT prob, predict_status FROM shadow_predictions WHERE symbol=?`).get('TSLA');
  assert.equal(pending.prob, null);
  assert.equal(pending.predict_status, 'pending');

  raw2.close();
  // Windows mantiene el archivo locked porque lib/db.js cargó su propia conexión que sigue viva;
  // el cleanup del tmp dir falla con EPERM, lo aceptamos en silencio.
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
