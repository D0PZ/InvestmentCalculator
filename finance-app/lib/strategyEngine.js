const { EventEmitter } = require('node:events');
const db = require('./db');
const mlClient = require('./mlClient');
const { recentBars } = require('./minuteBars');

const DEFAULTS = {
  paperBankrollStart: 1000,
  capitalUSD: 100,
  stopPct: 0.3,
  targetPct: 0.6,
  beTriggerPct: 0.3,
  cooldownMs: 90 * 1000,
  rvolMin: 1.3,
  rsiMin: 50,
  rsiMax: 75,
  minSecondsFromOpen: 60,
  flatBeforeCloseMin: 2,
  trailAfterBePct: 0.2,
  maxHoldSeconds: 10 * 60,
};

const NYSE_OPEN_MIN = 9 * 60 + 30;
const NYSE_CLOSE_MIN = 16 * 60;

function nyMinuteOfDay(ts = Date.now()) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ts))) parts[p.type] = p.value;
  return parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
}

class StrategyEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.cfg = { ...DEFAULTS, ...opts };
    this.positions = new Map();
    this.history = [];
    this.lastVwapSide = new Map();
    this.cooldownUntil = new Map();
    this._boundCandle = null;
    this._candleListener = null;
    this._destroyed = false;
    this._hydrateHistory();
  }

  _hydrateHistory() {
    try {
      const rows = db.prepare(
        `SELECT payload_json FROM signals WHERE type='EXIT' ORDER BY ts DESC LIMIT 100`
      ).all();
      for (const r of rows) {
        try {
          const sig = JSON.parse(r.payload_json);
          if (sig?.position) this.history.unshift(sig.position);
        } catch {}
      }
    } catch {}
  }

  _persistSignal(sig) {
    if (sig.type === 'IMPORT') return null;
    try {
      const info = db.prepare(
        `INSERT INTO signals (type, side, symbol, message, reason, payload_json, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        sig.type || null,
        sig.side || null,
        sig.symbol || null,
        sig.message || null,
        sig.reason || null,
        JSON.stringify(sig),
        sig.ts || Date.now(),
      );
      return Number(info?.lastInsertRowid) || null;
    } catch { return null; }
  }

  _recordShadowPrediction(position, signalId) {
    if (!mlClient.ENABLED) return;
    const { symbol, entry, openTs } = position;

    let rowId = null;
    try {
      const info = db.prepare(
        `INSERT INTO shadow_predictions
           (symbol, entry_ts, entry_price, signal_id, predict_status)
         VALUES (?, ?, ?, ?, 'pending')`
      ).run(symbol, openTs, entry, signalId);
      rowId = Number(info?.lastInsertRowid) || null;
    } catch { return; }
    if (!rowId) return;

    setImmediate(async () => {
      try {
        const bars = recentBars(symbol, 120, openTs);
        if (!bars || bars.length < 60) {
          db.prepare(`UPDATE shadow_predictions SET predict_status='skipped_no_bars' WHERE id=?`).run(rowId);
          return;
        }
        const payload = bars.map(b => ({
          t: b.ts, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume,
        }));
        const resp = await mlClient.predict({ symbol, bars: payload });
        if (!resp || resp.ok === false || typeof resp.prob !== 'number') {
          const status = resp?.error ? `error: ${String(resp.error).slice(0, 80)}` : 'no_prob';
          db.prepare(`UPDATE shadow_predictions SET predict_status=? WHERE id=?`).run(status, rowId);
          return;
        }
        db.prepare(
          `UPDATE shadow_predictions
              SET prob=?, model_meta_json=?, features_json=?, predict_status='done'
            WHERE id=?`
        ).run(
          resp.prob,
          JSON.stringify(resp.meta || null),
          JSON.stringify(resp.feature_snapshot || null),
          rowId,
        );
      } catch (err) {
        try {
          db.prepare(`UPDATE shadow_predictions SET predict_status=? WHERE id=?`)
            .run(`exception: ${String(err.message || err).slice(0, 80)}`, rowId);
        } catch {}
      }
    });
  }

  _resolveShadowPrediction(closed) {
    if (!mlClient.ENABLED) return;
    try {
      db.prepare(
        `UPDATE shadow_predictions
           SET outcome=?, exit_ts=?, exit_price=?, pnl_pct=?
         WHERE id = (
           SELECT id FROM shadow_predictions
            WHERE symbol=? AND entry_ts=? AND outcome IS NULL
            ORDER BY id DESC LIMIT 1
         )`
      ).run(
        closed.result || null,
        closed.exitTs || null,
        closed.exit || null,
        closed.pnlPct || null,
        closed.symbol,
        closed.openTs,
      );
    } catch {}
  }

  emit(eventName, payload) {
    if (eventName === 'signal' && payload) {
      const signalId = this._persistSignal(payload);
      if (payload.type === 'ENTRY' && payload.position) {
        this._recordShadowPrediction(payload.position, signalId);
      } else if (payload.type === 'EXIT' && payload.position) {
        this._resolveShadowPrediction(payload.position);
      }
    }
    return super.emit(eventName, payload);
  }

  bind({ candleEngine }) {
    if (!candleEngine || this._destroyed) return;
    if (this._boundCandle) this._unbindCandle();
    this._candleListener = ({ symbol, snapshot }) => this.evaluate(symbol, snapshot);
    candleEngine.on('update', this._candleListener);
    this._boundCandle = candleEngine;
  }

  _unbindCandle() {
    if (this._boundCandle && this._candleListener) {
      try { this._boundCandle.off('update', this._candleListener); } catch {}
    }
    this._boundCandle = null;
    this._candleListener = null;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._unbindCandle();
    this.removeAllListeners();
    this.positions.clear();
    this.lastVwapSide.clear();
    this.cooldownUntil.clear();
    this.history.length = 0;
  }

  evaluate(symbol, snap) {
    if (!snap || !Number.isFinite(snap.lastPrice)) return;
    const open = this.positions.get(symbol);
    if (open) this._evaluateExit(symbol, snap, open);
    else this._evaluateEntry(symbol, snap);
  }

  _evaluateEntry(symbol, snap) {
    const now = Date.now();
    const cooldown = this.cooldownUntil.get(symbol) || 0;
    if (now < cooldown) return;

    const nyMin = nyMinuteOfDay(now);
    if (nyMin < NYSE_OPEN_MIN + this.cfg.minSecondsFromOpen / 60) return;
    if (nyMin >= NYSE_CLOSE_MIN - this.cfg.flatBeforeCloseMin) return;

    if (!Number.isFinite(snap.vwap)) return;
    const side = snap.lastPrice >= snap.vwap ? 'above' : 'below';
    const prev = this.lastVwapSide.get(symbol);
    this.lastVwapSide.set(symbol, side);
    if (prev !== 'below' || side !== 'above') return;

    if (!Number.isFinite(snap.rvol) || snap.rvol < this.cfg.rvolMin) return;
    if (!Number.isFinite(snap.ema9) || !Number.isFinite(snap.ema20) || snap.ema9 <= snap.ema20) return;
    if (!Number.isFinite(snap.rsi) || snap.rsi < this.cfg.rsiMin || snap.rsi > this.cfg.rsiMax) return;

    const entry = +snap.lastPrice.toFixed(2);
    const stop = +(entry * (1 - this.cfg.stopPct / 100)).toFixed(2);
    const target = +(entry * (1 + this.cfg.targetPct / 100)).toFixed(2);
    const beTrigger = +(entry * (1 + this.cfg.beTriggerPct / 100)).toFixed(2);
    const sharesRaw = this.cfg.capitalUSD / entry;
    const shares = +sharesRaw.toFixed(4);
    const positionUSD = +(shares * entry).toFixed(2);
    const riskUSD = +((entry - stop) * shares).toFixed(2);
    const rewardUSD = +((target - entry) * shares).toFixed(2);

    const position = {
      symbol, entry, stop, originalStop: stop, target, beTrigger,
      shares, positionUSD, riskUSD, rewardUSD,
      openTs: now, beActive: false,
      highestPrice: entry,
      strategy: 'VWAP-reclaim-scalp',
    };
    this.positions.set(symbol, position);
    this.emit('signal', {
      type: 'ENTRY', side: 'LONG', symbol, position: { ...position },
      message: `🟢 COMPRAR ${symbol} @ $${entry} · ${shares} acc · stop $${stop} · target $${target}`,
      reason: 'VWAP reclaim + RVOL/EMA/RSI confirmados',
      ts: now,
    });
  }

  _evaluateExit(symbol, snap, open) {
    const price = snap.lastPrice;
    const now = Date.now();

    if (price > (open.highestPrice || open.entry)) open.highestPrice = price;

    if (!open.beActive && price >= open.beTrigger) {
      open.stop = open.entry;
      open.beActive = true;
      this.emit('signal', {
        type: 'BREAKEVEN', symbol, position: { ...open },
        message: `⚪ ${symbol} stop a breakeven $${open.entry} · trade ya no puede perder`,
        reason: `alcanzó +${this.cfg.beTriggerPct}%`,
        ts: now,
      });
    }

    if (open.beActive && this.cfg.trailAfterBePct > 0) {
      const trailStop = +(open.highestPrice * (1 - this.cfg.trailAfterBePct / 100)).toFixed(2);
      if (trailStop > open.stop) open.stop = trailStop;
    }

    const nyMin = nyMinuteOfDay(now);
    const forceClose = nyMin >= NYSE_CLOSE_MIN - this.cfg.flatBeforeCloseMin;
    const heldSeconds = (now - open.openTs) / 1000;
    const maxHoldReached = this.cfg.maxHoldSeconds > 0 && heldSeconds >= this.cfg.maxHoldSeconds;

    let reason = null;
    let result = null;
    if (price >= open.target) { reason = 'target alcanzado'; result = 'WIN'; }
    else if (price <= open.stop) {
      reason = open.beActive ? 'trail/breakeven stop' : 'stop loss';
      result = open.beActive ? (price >= open.entry ? 'WIN' : 'BE') : 'LOSS';
    } else if (Number.isFinite(snap.vwap) && price < snap.vwap * 0.999) {
      reason = 'perdió VWAP'; result = price >= open.entry ? 'WIN' : 'TREND_BREAK';
    } else if (maxHoldReached) {
      reason = `max hold ${this.cfg.maxHoldSeconds}s`;
      result = price >= open.entry ? 'WIN' : 'LOSS';
    } else if (forceClose) {
      reason = 'cierre de mercado'; result = price >= open.entry ? 'WIN' : 'LOSS';
    }
    if (!reason) return;

    const pnl = +((price - open.entry) * open.shares).toFixed(2);
    const pnlPct = +(((price - open.entry) / open.entry) * 100).toFixed(2);
    const closed = { ...open, exit: +price.toFixed(2), exitTs: now, reason, result, pnl, pnlPct };
    this.positions.delete(symbol);
    this.history.push(closed);
    if (this.history.length > 100) this.history.shift();
    this.cooldownUntil.set(symbol, now + this.cfg.cooldownMs);

    const sign = pnl >= 0 ? '+' : '';
    this.emit('signal', {
      type: 'EXIT', side: 'CLOSE', symbol, position: closed,
      message: `🔴 VENDER ${symbol} @ $${price.toFixed(2)} · ${result} ${sign}$${pnl} (${sign}${pnlPct}%) · ${reason}`,
      reason, ts: now,
    });
  }

  setCapital(usd) {
    if (Number.isFinite(usd) && usd > 0) this.cfg.capitalUSD = usd;
  }

  bankroll() {
    const allPnl = this._allHistoryPnl();
    return +(this.cfg.paperBankrollStart + allPnl).toFixed(2);
  }

  _allHistoryPnl() {
    try {
      const row = db.prepare(
        `SELECT SUM(CAST(json_extract(payload_json, '$.position.pnl') AS REAL)) AS total
         FROM signals WHERE type='EXIT'`
      ).get();
      return Number(row?.total) || 0;
    } catch { return this.history.reduce((s, t) => s + (t.pnl || 0), 0); }
  }

  state() {
    return {
      cfg: this.cfg,
      open: Object.fromEntries([...this.positions]),
      history: this.history.slice(-20).reverse(),
      stats: this._stats(),
      bankroll: this.bankroll(),
      bankrollStart: this.cfg.paperBankrollStart,
    };
  }

  _stats() {
    const closed = this.history;
    if (closed.length === 0) return { trades: 0, wins: 0, losses: 0, winRate: null, totalPnl: 0 };
    const wins = closed.filter(t => t.pnl > 0).length;
    const losses = closed.filter(t => t.pnl < 0).length;
    const totalPnl = +closed.reduce((s, t) => s + t.pnl, 0).toFixed(2);
    return {
      trades: closed.length, wins, losses,
      winRate: +(wins / closed.length * 100).toFixed(1),
      totalPnl,
    };
  }
}

let singleton = null;
function getStrategyEngine() {
  if (!singleton) {
    singleton = new StrategyEngine({
      capitalUSD: parseFloat(process.env.TRADE_CAPITAL_USD) || 100,
    });
  }
  return singleton;
}

function resetStrategyEngine() {
  if (singleton) {
    singleton.destroy();
    singleton = null;
  }
}

module.exports = { StrategyEngine, getStrategyEngine, resetStrategyEngine };
