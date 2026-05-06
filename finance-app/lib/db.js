const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'finance.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const raw = new DatabaseSync(dbPath);
raw.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);

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
`);

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
};

module.exports = db;
