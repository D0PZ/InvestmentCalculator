const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'finance.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const raw = new DatabaseSync(dbPath);
raw.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;`);

raw.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK(type IN ('debit','credit','digital','benefit')),
    balance INTEGER NOT NULL DEFAULT 0,
    credit_limit INTEGER,
    credit_used INTEGER,
    notes TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK(kind IN ('income','expense')),
    amount INTEGER NOT NULL,
    category TEXT,
    description TEXT,
    account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    occurred_on TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    amount_total INTEGER NOT NULL,
    installments INTEGER NOT NULL DEFAULT 1,
    cycle TEXT NOT NULL CHECK(cycle IN ('monthly','annual','installment')),
    monthly_cost INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    started_on TEXT,
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    shares REAL NOT NULL,
    avg_cost REAL NOT NULL,
    market_price REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    fx_to_clp REAL NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(occurred_on);
  CREATE INDEX IF NOT EXISTS idx_tx_kind ON transactions(kind);
  CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category);

  CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    date TEXT PRIMARY KEY,
    value_clp INTEGER NOT NULL,
    cost_clp INTEGER NOT NULL,
    fx REAL NOT NULL,
    positions_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS patrimony_snapshots (
    date TEXT PRIMARY KEY,
    cash_clp INTEGER NOT NULL,
    investments_clp INTEGER NOT NULL,
    debt_clp INTEGER NOT NULL,
    total_clp INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS price_history (
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,
    close REAL NOT NULL,
    PRIMARY KEY (ticker, date)
  );

  CREATE TABLE IF NOT EXISTS trades (
    order_id TEXT PRIMARY KEY,
    ticker TEXT NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
    shares REAL NOT NULL,
    price_usd REAL NOT NULL,
    amount_usd REAL NOT NULL,
    fx_clp REAL,
    trade_date TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'racional.txt',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_trades_ticker ON trades(ticker);
  CREATE INDEX IF NOT EXISTS idx_trades_date ON trades(trade_date);

  CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    side TEXT,
    symbol TEXT,
    message TEXT,
    reason TEXT,
    payload_json TEXT,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(ts);
  CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);
  CREATE INDEX IF NOT EXISTS idx_signals_type_ts ON signals(type, ts);

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT,
    type TEXT NOT NULL,
    severity TEXT,
    message TEXT,
    payload_json TEXT,
    ts INTEGER NOT NULL,
    dedupe_key TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts);
  CREATE INDEX IF NOT EXISTS idx_alerts_symbol ON alerts(symbol);

  CREATE TABLE IF NOT EXISTS fx_rates (
    date TEXT PRIMARY KEY,
    rate REAL NOT NULL,
    source TEXT NOT NULL DEFAULT 'mindicador.cl',
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS minute_bars (
    ticker TEXT NOT NULL,
    ts INTEGER NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'finnhub',
    PRIMARY KEY (ticker, ts)
  );
  CREATE INDEX IF NOT EXISTS idx_minute_bars_ts ON minute_bars(ts);
  CREATE INDEX IF NOT EXISTS idx_minute_bars_ticker_ts ON minute_bars(ticker, ts);

  CREATE TABLE IF NOT EXISTS shadow_predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    entry_ts INTEGER NOT NULL,
    entry_price REAL NOT NULL,
    prob REAL,
    model_meta_json TEXT,
    features_json TEXT,
    signal_id INTEGER,
    outcome TEXT,
    exit_ts INTEGER,
    exit_price REAL,
    pnl_pct REAL,
    predict_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_shadow_pred_ts ON shadow_predictions(entry_ts);
  CREATE INDEX IF NOT EXISTS idx_shadow_pred_symbol ON shadow_predictions(symbol);
  CREATE INDEX IF NOT EXISTS idx_shadow_pred_signal ON shadow_predictions(signal_id);

  CREATE TABLE IF NOT EXISTS ml_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    symbol TEXT NOT NULL,
    prob REAL,
    threshold REAL,
    message TEXT,
    reason TEXT,
    payload_json TEXT,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ml_signals_ts ON ml_signals(ts);
  CREATE INDEX IF NOT EXISTS idx_ml_signals_symbol ON ml_signals(symbol);

  CREATE TABLE IF NOT EXISTS ml_positions (
    symbol TEXT PRIMARY KEY,
    entry REAL NOT NULL,
    target REAL NOT NULL,
    stop REAL NOT NULL,
    target_pct REAL,
    stop_pct REAL,
    prob REAL,
    entry_ts INTEGER NOT NULL,
    expire_ts INTEGER NOT NULL,
    shares REAL,
    capital_usd REAL,
    payload_json TEXT
  );

  CREATE TABLE IF NOT EXISTS ml_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    entry REAL NOT NULL,
    exit REAL NOT NULL,
    target_pct REAL,
    stop_pct REAL,
    prob REAL,
    entry_ts INTEGER NOT NULL,
    exit_ts INTEGER NOT NULL,
    outcome TEXT,
    gross_pct REAL,
    net_pct REAL,
    pnl_usd REAL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ml_trades_ts ON ml_trades(entry_ts);
  CREATE INDEX IF NOT EXISTS idx_ml_trades_exit_ts ON ml_trades(exit_ts);
  CREATE INDEX IF NOT EXISTS idx_ml_trades_symbol ON ml_trades(symbol);
`);

function migrateShadowPredictions() {
  const cols = raw.prepare(`PRAGMA table_info(shadow_predictions)`).all();
  if (cols.length === 0) return;
  const probCol = cols.find(c => c.name === 'prob');
  const hasStatus = cols.some(c => c.name === 'predict_status');
  const needsProbRelax = probCol && probCol.notnull === 1;
  if (!needsProbRelax && hasStatus) return;
  raw.exec('BEGIN');
  try {
    raw.exec(`
      CREATE TABLE shadow_predictions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        entry_ts INTEGER NOT NULL,
        entry_price REAL NOT NULL,
        prob REAL,
        model_meta_json TEXT,
        features_json TEXT,
        signal_id INTEGER,
        outcome TEXT,
        exit_ts INTEGER,
        exit_price REAL,
        pnl_pct REAL,
        predict_status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO shadow_predictions_new
        (id, symbol, entry_ts, entry_price, prob, model_meta_json, features_json,
         signal_id, outcome, exit_ts, exit_price, pnl_pct, predict_status, created_at)
      SELECT id, symbol, entry_ts, entry_price, prob, model_meta_json, features_json,
             signal_id, outcome, exit_ts, exit_price, pnl_pct,
             CASE WHEN prob IS NULL THEN 'pending' ELSE 'done' END,
             created_at
        FROM shadow_predictions;
      DROP TABLE shadow_predictions;
      ALTER TABLE shadow_predictions_new RENAME TO shadow_predictions;
      CREATE INDEX IF NOT EXISTS idx_shadow_pred_ts ON shadow_predictions(entry_ts);
      CREATE INDEX IF NOT EXISTS idx_shadow_pred_symbol ON shadow_predictions(symbol);
      CREATE INDEX IF NOT EXISTS idx_shadow_pred_signal ON shadow_predictions(signal_id);
    `);
    raw.exec('COMMIT');
  } catch (err) {
    raw.exec('ROLLBACK');
    throw err;
  }
}
migrateShadowPredictions();

raw.exec(`CREATE INDEX IF NOT EXISTS idx_shadow_pred_status ON shadow_predictions(predict_status);`);

function optimize() {
  raw.exec('PRAGMA optimize');
}

let shutdownHooked = false;
function ensureShutdownHook() {
  if (shutdownHooked) return;
  shutdownHooked = true;
  // Solo en beforeExit (cuando el event loop está vacío). NO en SIGINT/SIGTERM —
  // eso lo maneja server.js para drenar HTTP/SSE primero; este hook se dispara
  // al final del lifecycle natural una vez que el server cerró.
  process.once('beforeExit', () => {
    try { raw.exec('PRAGMA optimize'); } catch {}
    try { raw.close(); } catch {}
  });
}
ensureShutdownHook();

const db = {
  prepare(sql) {
    const stmt = raw.prepare(sql);
    return {
      run: (...args) => stmt.run(...args),
      get: (...args) => stmt.get(...args),
      all: (...args) => stmt.all(...args),
    };
  },
  exec: (sql) => raw.exec(sql),
  optimize,
};

module.exports = db;
