const { EventEmitter } = require('node:events');
const db = require('./db');

const DEFAULTS = {
  capitalUSD: 100,
  stopPct: 0.8,
  targetPct: 2.0,
  beTriggerPct: 1.0,
  cooldownMs: 5 * 60 * 1000,
  rvolMin: 1.5,
  rsiMin: 50,
  rsiMax: 70,
  minSecondsFromOpen: 300,
  flatBeforeCloseMin: 5,
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
    if (sig.type === 'IMPORT') return;
    try {
      db.prepare(
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
    } catch {}
  }

  emit(eventName, payload) {
    if (eventName === 'signal' && payload) this._persistSignal(payload);
    return super.emit(eventName, payload);
  }

  bind({ candleEngine }) {
    if (!candleEngine) return;
    candleEngine.on('update', ({ symbol, snapshot }) => this.evaluate(symbol, snapshot));
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
      strategy: 'VWAP-reclaim-long',
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

    const nyMin = nyMinuteOfDay(now);
    const forceClose = nyMin >= NYSE_CLOSE_MIN - this.cfg.flatBeforeCloseMin;

    let reason = null;
    let result = null;
    if (price >= open.target) { reason = 'target alcanzado'; result = 'WIN'; }
    else if (price <= open.stop) {
      reason = open.beActive ? 'stop breakeven' : 'stop loss';
      result = open.beActive ? 'BE' : 'LOSS';
    } else if (Number.isFinite(snap.vwap) && price < snap.vwap * 0.998) {
      reason = 'perdió VWAP'; result = 'TREND_BREAK';
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

  loadPosition({ symbol, shares, costBasis, openTs }) {
    if (!symbol || !Number.isFinite(shares) || shares <= 0) return null;
    if (!Number.isFinite(costBasis) || costBasis <= 0) return null;
    const entry = +costBasis.toFixed(2);
    const stop = +(entry * (1 - this.cfg.stopPct / 100)).toFixed(2);
    const target = +(entry * (1 + this.cfg.targetPct / 100)).toFixed(2);
    const beTrigger = +(entry * (1 + this.cfg.beTriggerPct / 100)).toFixed(2);
    const positionUSD = +(shares * entry).toFixed(2);
    const riskUSD = +((entry - stop) * shares).toFixed(2);
    const rewardUSD = +((target - entry) * shares).toFixed(2);
    const position = {
      symbol: symbol.toUpperCase(),
      entry, stop, originalStop: stop, target, beTrigger,
      shares, positionUSD, riskUSD, rewardUSD,
      openTs: openTs || Date.now(),
      beActive: false,
      strategy: 'imported-racional',
      imported: true,
    };
    this.positions.set(position.symbol, position);
    this.emit('signal', {
      type: 'IMPORT', side: 'LONG', symbol: position.symbol, position: { ...position },
      message: `📦 Importada ${position.symbol} · ${shares} acc @ $${entry} · stop $${stop} · target $${target}`,
      reason: 'posición existente cargada desde extracto Racional',
      ts: Date.now(),
    });
    return position;
  }

  loadPositionsBulk(rows) {
    const loaded = [];
    for (const r of rows || []) {
      const p = this.loadPosition(r);
      if (p) loaded.push(p);
    }
    return loaded;
  }

  state() {
    return {
      cfg: this.cfg,
      open: Object.fromEntries([...this.positions]),
      history: this.history.slice(-20).reverse(),
      stats: this._stats(),
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

module.exports = { StrategyEngine, getStrategyEngine };
