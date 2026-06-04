const { EventEmitter } = require('node:events');
const db = require('./db');

const DEFAULT_RULES = {
  rvolThreshold: 2.0,
  gapPctThreshold: 2.0,
  maxAlerts: 200,
  dedupeWindowMs: 5 * 60 * 1000,
};

const SEVERITY = {
  vwapCross: 'info',
  rvolSpike: 'warn',
  gap: 'warn',
  filing: 'critical',
};

class AlertEngine extends EventEmitter {
  constructor(rules = {}) {
    super();
    this.rules = { ...DEFAULT_RULES, ...rules };
    this.lastVwapSide = new Map();
    this.lastFireAt = new Map();
    this.history = [];
    this._hydrate();
  }

  _hydrate() {
    try {
      const rows = db.prepare(
        `SELECT symbol, type, severity, message, payload_json, ts FROM alerts ORDER BY ts DESC LIMIT ?`
      ).all(this.rules.maxAlerts);
      for (const r of rows.reverse()) {
        let data = null;
        try { data = r.payload_json ? JSON.parse(r.payload_json) : null; } catch {}
        this.history.push({
          id: `${r.symbol}:${r.type}:${r.ts}`,
          symbol: r.symbol,
          type: r.type,
          severity: r.severity,
          message: r.message,
          data,
          ts: Number(r.ts),
        });
      }
    } catch {}
  }

  _persist(alert) {
    try {
      db.prepare(
        `INSERT INTO alerts (symbol, type, severity, message, payload_json, ts, dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        alert.symbol || null,
        alert.type,
        alert.severity || null,
        alert.message || null,
        alert.data ? JSON.stringify(alert.data) : null,
        alert.ts,
        `${alert.symbol}:${alert.type}`,
      );
    } catch {}
  }

  bind({ candleEngine, edgarStream, catalystStream }) {
    if (candleEngine) {
      candleEngine.on('update', ({ symbol, snapshot }) => this._evaluate(symbol, snapshot));
    }
    if (edgarStream) {
      edgarStream.on('filing', (filing) => this._onFiling(filing));
    }
    if (catalystStream) {
      catalystStream.on('catalyst', (c) => this._onCatalyst(c));
    }
  }

  // Catalizador fundamental (earnings inminente, acción de analista, drift de consenso).
  // El catalystStream ya deduplica a nivel DB (sólo emite eventos nuevos), por eso pasamos
  // noTimeDedupe: no queremos que la ventana de 5m colapse dos ratings distintos del mismo símbolo.
  _onCatalyst(c) {
    const severity = c.sentiment === 'bearish' ? 'warn' : 'info';
    this._fire({
      type: `catalyst:${c.type}`,
      symbol: c.ticker,
      severity,
      message: c.headline,
      data: c,
      ts: c.ts || Date.now(),
      noTimeDedupe: true,
    });
  }

  _evaluate(symbol, snap) {
    if (!snap || !Number.isFinite(snap.lastPrice)) return;

    if (Number.isFinite(snap.vwap)) {
      const side = snap.lastPrice >= snap.vwap ? 'above' : 'below';
      const prev = this.lastVwapSide.get(symbol);
      if (prev && prev !== side) {
        this._fire({
          type: 'vwapCross',
          symbol,
          severity: SEVERITY.vwapCross,
          message: side === 'above'
            ? `${symbol} cruzó VWAP ↑ a ${snap.lastPrice.toFixed(2)}`
            : `${symbol} cruzó VWAP ↓ a ${snap.lastPrice.toFixed(2)}`,
          data: { vwap: snap.vwap, price: snap.lastPrice, side },
        });
      }
      this.lastVwapSide.set(symbol, side);
    }

    if (Number.isFinite(snap.rvol) && snap.rvol >= this.rules.rvolThreshold) {
      this._fire({
        type: 'rvolSpike',
        symbol,
        severity: SEVERITY.rvolSpike,
        message: `${symbol} RVOL ${snap.rvol.toFixed(2)}× — flujo inusual`,
        data: { rvol: snap.rvol },
      });
    }

    if (Number.isFinite(snap.gapPct) && Math.abs(snap.gapPct) >= this.rules.gapPctThreshold) {
      this._fire({
        type: 'gap',
        symbol,
        severity: SEVERITY.gap,
        message: `${symbol} gap ${snap.gapPct > 0 ? '+' : ''}${snap.gapPct.toFixed(2)}% vs cierre previo`,
        data: { gapPct: snap.gapPct, openPrice: snap.openPrice, prevClose: snap.prevClose },
      });
    }
  }

  _onFiling(filing) {
    const tail = (filing.title || '').split('-').pop().trim();
    this._fire({
      type: 'filing',
      symbol: filing.symbol,
      severity: SEVERITY.filing,
      message: `${filing.symbol} 8-K filed — ${tail || 'material event'}`,
      data: { url: filing.url, title: filing.title, summary: filing.summary },
      ts: filing.ts,
    });
  }

  _fire(alert) {
    const key = `${alert.symbol}:${alert.type}`;
    const now = Date.now();
    const last = this.lastFireAt.get(key) || 0;
    if (!alert.noTimeDedupe && alert.type !== 'filing' && now - last < this.rules.dedupeWindowMs) return;
    this.lastFireAt.set(key, now);

    const enriched = {
      ...alert,
      id: `${key}:${alert.ts || now}`,
      ts: alert.ts || now,
    };
    this.history.push(enriched);
    if (this.history.length > this.rules.maxAlerts) this.history.shift();
    this._persist(enriched);
    this.emit('alert', enriched);
  }

  getRecent(limit = 50) {
    return this.history.slice(-limit).reverse();
  }
}

let singleton = null;
function getAlertEngine() {
  if (!singleton) singleton = new AlertEngine();
  return singleton;
}

module.exports = { AlertEngine, getAlertEngine };
