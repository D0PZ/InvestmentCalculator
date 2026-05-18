/**
 * mlStandaloneEngine — sistema de trading paper basado solo en el modelo ML.
 *
 * Diferencia clave con strategyEngine:
 *  - strategyEngine usa heurísticas (VWAP reclaim + RVOL + RSI). ML solo lo audita.
 *  - mlStandaloneEngine usa SÓLO la probabilidad ML para decidir entries.
 *    Exits por target/stop ATR-relativo + horizonte + cierre de mercado.
 *
 * Persiste en tablas separadas: ml_signals, ml_positions, ml_trades.
 * Vars de entorno:
 *   ML_STANDALONE_ENABLED=true       (default true; pone false para apagar)
 *   ML_STANDALONE_INTERVAL_MS=60000  (polling de evaluación)
 *   ML_STANDALONE_THRESHOLD=         (override del threshold del modelo)
 *   ML_STANDALONE_CAPITAL_USD=100
 *   ML_STANDALONE_MAX_OPEN=3
 *   ML_STANDALONE_COMMISSION_PCT=0.6
 *   ML_STANDALONE_SLIPPAGE_PCT=0.05
 */

const { EventEmitter } = require('node:events');
const db = require('./db');
const mlClient = require('./mlClient');
const log = require('./logger').child('mlStandalone');

function parseWhitelist() {
  const raw = process.env.ML_STANDALONE_WHITELIST || '';
  return raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
}

const DEFAULTS = {
  intervalMs: Number(process.env.ML_STANDALONE_INTERVAL_MS) || 60_000,
  thresholdOverride: process.env.ML_STANDALONE_THRESHOLD
    ? Number(process.env.ML_STANDALONE_THRESHOLD) : null,
  capitalUsd: Number(process.env.ML_STANDALONE_CAPITAL_USD) || 100,
  maxOpen: Number(process.env.ML_STANDALONE_MAX_OPEN) || 3,
  commissionPct: Number(process.env.ML_STANDALONE_COMMISSION_PCT) || 0.6,
  slippagePct: Number(process.env.ML_STANDALONE_SLIPPAGE_PCT) || 0.05,
  minMinutesFromOpen: 30,
  flatBeforeCloseMin: 5,
  lookbackBars: 180,
  whitelist: parseWhitelist(),  // si vacío, opera todo el watchlist; si tiene tickers, SOLO esos
  onlyProfitable: (process.env.ML_STANDALONE_ONLY_PROFITABLE || 'true').toLowerCase() !== 'false',
};

const NYSE_CLOSE_MIN = 16 * 60;
function nyMinuteOfDay(ts = Date.now()) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ts))) parts[p.type] = p.value;
  return parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
}

const ENABLED = (process.env.ML_STANDALONE_ENABLED || 'true').toLowerCase() !== 'false';

class MLStandaloneEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.cfg = { ...DEFAULTS, ...opts };
    this.watchlist = [];
    this.candleEngine = null;
    this.timer = null;
    this.modelMeta = null;
    this.threshold = this.cfg.thresholdOverride || 0.6;
    this.horizonMin = 30;
    this.targetMultAtr = 2.0;
    this.stopMultAtr = 1.0;
    this.lastCycleAt = 0;
    this.lastCycleResult = null;
    this._hydratePositions();
  }

  _hydratePositions() {
    try {
      const rows = db.prepare('SELECT * FROM ml_positions').all();
      this.openPositions = new Map(rows.map(r => [r.symbol, r]));
    } catch {
      this.openPositions = new Map();
    }
  }

  _resolveEligibleTickers(watchlist) {
    const base = (watchlist || []).filter(t => t !== 'SPY').map(t => t.toUpperCase());
    if (this.cfg.whitelist.length > 0) {
      return base.filter(t => this.cfg.whitelist.includes(t));
    }
    if (this.cfg.onlyProfitable && this.profitableSet?.size > 0) {
      return base.filter(t => this.profitableSet.has(t));
    }
    return base;
  }

  async _initFromService() {
    const h = await mlClient.health();
    if (!h?.ok) return false;
    this.modelMeta = h;
    if (h.threshold && !this.cfg.thresholdOverride) this.threshold = Number(h.threshold);
    if (h.meta?.label_cfg) {
      this.horizonMin = Number(h.meta.label_cfg.horizon_min) || this.horizonMin;
      this.targetMultAtr = Number(h.meta.label_cfg.target_mult_atr) || this.targetMultAtr;
      this.stopMultAtr = Number(h.meta.label_cfg.stop_mult_atr) || this.stopMultAtr;
    }
    try {
      const res = await fetch(`${mlClient.ML_URL}/models`);
      const body = await res.json();
      const profitable = (body.per_ticker || []).filter(m => m.profitable).map(m => m.symbol);
      this.profitableSet = new Set(profitable);
      this.perTickerCfg = new Map((body.per_ticker || []).map(m => [m.symbol, m]));
      log.info({ profitable }, 'per-ticker models loaded');
    } catch (e) {
      log.warn({ err: e.message }, '/models lookup failed');
      this.profitableSet = new Set();
      this.perTickerCfg = new Map();
    }
    this.watchlist = this._resolveEligibleTickers(this._pendingWatchlist || []);
    this.initialized = true;
    log.info({
      version: h.version,
      threshold: this.threshold,
      horizonMin: this.horizonMin,
      eligible: this.watchlist,
      whitelistSize: this.cfg.whitelist.length,
      onlyProfitable: this.cfg.onlyProfitable,
    }, 'mlStandalone online');
    return true;
  }

  async bind({ candleEngine, watchlist }) {
    this.candleEngine = candleEngine;
    this._pendingWatchlist = watchlist || [];
    if (!ENABLED) {
      log.info('mlStandalone disabled by env');
      return;
    }
    const ok = await this._initFromService();
    if (!ok) {
      log.warn('predict service unavailable — will retry every cycle');
    }
    this.timer = setInterval(() => this.cycle().catch(e => log.error({ err: e.message }, 'cycle err')),
                             this.cfg.intervalMs);
    setImmediate(() => this.cycle().catch(e => log.error({ err: e.message }, 'cycle err')));
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  _persistSignal(sig) {
    try {
      const info = db.prepare(
        `INSERT INTO ml_signals (type, symbol, prob, threshold, message, reason, payload_json, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        sig.type, sig.symbol, sig.prob ?? null, sig.threshold ?? null,
        sig.message || null, sig.reason || null,
        JSON.stringify(sig), sig.ts || Date.now(),
      );
      return Number(info?.lastInsertRowid) || null;
    } catch (e) {
      log.error({ err: e.message }, 'persist err');
      return null;
    }
  }

  async cycle() {
    if (!ENABLED) return;
    const now = Date.now();
    this.lastCycleAt = now;
    if (!this.initialized) {
      const ok = await this._initFromService();
      if (!ok) {
        this.lastCycleResult = { ts: now, reason: 'predict_service_unavailable' };
        return;
      }
    }

    // 1) Resolve exits for any open position using latest snap from candleEngine
    if (this.candleEngine) {
      for (const [symbol, pos] of [...this.openPositions]) {
        const snap = this.candleEngine.snapshot(symbol);
        if (!snap || !Number.isFinite(snap.lastPrice)) continue;
        const price = snap.lastPrice;
        let outcome = null;
        let exitPrice = null;
        let reason = null;
        if (price >= pos.target) {
          outcome = 'WIN'; exitPrice = pos.target; reason = 'target alcanzado';
        } else if (price <= pos.stop) {
          outcome = 'LOSS'; exitPrice = pos.stop; reason = 'stop loss';
        } else if (now >= pos.expire_ts) {
          outcome = 'TIMEOUT'; exitPrice = price; reason = `timeout ${this.horizonMin}m`;
        } else if (nyMinuteOfDay(now) >= NYSE_CLOSE_MIN - this.cfg.flatBeforeCloseMin) {
          outcome = 'EOD_CLOSE'; exitPrice = price; reason = 'cierre de mercado';
        }
        if (outcome) this._closePosition(pos, exitPrice, outcome, reason, now);
      }
    }

    // 2) Decide entries: query batch signals for non-open tickers
    const available = this.cfg.maxOpen - this.openPositions.size;
    const result = { ts: now, entries: 0, exits: 0, evaluated: 0 };
    if (available <= 0) {
      this.lastCycleResult = { ...result, reason: 'max_open_reached' };
      return;
    }
    const nyMin = nyMinuteOfDay(now);
    if (nyMin < 570 + this.cfg.minMinutesFromOpen ||
        nyMin >= NYSE_CLOSE_MIN - this.cfg.flatBeforeCloseMin - this.horizonMin) {
      this.lastCycleResult = { ...result, reason: 'outside_trading_window' };
      return;
    }

    const candidates = this.watchlist.filter(t => !this.openPositions.has(t));
    if (candidates.length === 0) {
      this.lastCycleResult = { ...result, reason: 'no_candidates' };
      return;
    }

    const batch = await mlClient.signalsBatch({
      tickers: candidates,
      threshold: null,  // usar el threshold del modelo (per-ticker o universal)
      lookbackBars: this.cfg.lookbackBars,
      onlyPassing: true,
    });
    if (!batch || batch.ok === false) {
      this.lastCycleResult = { ...result, reason: 'predict_error', error: batch?.error };
      return;
    }
    result.evaluated = batch.n_evaluated;
    const signals = (batch.signals || []).slice(0, available);
    for (const sig of signals) {
      const symbol = sig.symbol;
      const snap = this.candleEngine?.snapshot(symbol);
      const lastPrice = snap?.lastPrice ?? sig.feature_snapshot?.close ?? null;
      if (!Number.isFinite(lastPrice)) continue;

      // Resolver target/stop según label_cfg del modelo usado
      const lc = sig.label_cfg || {};
      let target, stop, targetPct, stopPct;
      if (lc.label_mode === 'fixed' && Number.isFinite(lc.fixed_target_pct)) {
        targetPct = Number(lc.fixed_target_pct);
        stopPct = Number(lc.fixed_stop_pct);
        target = +(lastPrice * (1 + targetPct / 100)).toFixed(4);
        stop = +(lastPrice * (1 - stopPct / 100)).toFixed(4);
      } else {
        const atrPct = sig.atr_pct ?? sig.feature_snapshot?.atr_pct;
        if (!Number.isFinite(atrPct) || atrPct <= 0) continue;
        const atrDollars = atrPct * lastPrice;
        const tMult = Number(lc.target_mult_atr) || this.targetMultAtr;
        const sMult = Number(lc.stop_mult_atr) || this.stopMultAtr;
        target = +(lastPrice + tMult * atrDollars).toFixed(4);
        stop = +(lastPrice - sMult * atrDollars).toFixed(4);
        targetPct = (target - lastPrice) / lastPrice * 100;
        stopPct = (lastPrice - stop) / lastPrice * 100;
      }
      const horizon = Number(lc.horizon_min) || this.horizonMin;
      const shares = +(this.cfg.capitalUsd / lastPrice).toFixed(4);
      const pos = {
        symbol,
        entry: +lastPrice.toFixed(4),
        target, stop,
        target_pct: targetPct,
        stop_pct: stopPct,
        prob: sig.prob,
        entry_ts: now,
        expire_ts: now + horizon * 60 * 1000,
        shares,
        capital_usd: this.cfg.capitalUsd,
        payload_json: JSON.stringify({
          feature_snapshot: sig.feature_snapshot,
          version: batch.version,
          model_kind: sig.model_kind,
          label_cfg: lc,
        }),
      };
      db.prepare(
        `INSERT INTO ml_positions
           (symbol, entry, target, stop, target_pct, stop_pct, prob, entry_ts, expire_ts, shares, capital_usd, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(pos.symbol, pos.entry, pos.target, pos.stop, pos.target_pct, pos.stop_pct,
            pos.prob, pos.entry_ts, pos.expire_ts, pos.shares, pos.capital_usd, pos.payload_json);
      this.openPositions.set(symbol, pos);
      const sig_payload = {
        type: 'ENTRY', symbol, prob: sig.prob, threshold: sig.threshold || this.threshold,
        position: pos,
        message: `🤖 ML COMPRAR ${symbol} @ $${pos.entry.toFixed(2)} · prob ${(sig.prob * 100).toFixed(1)}% · target $${target.toFixed(2)} stop $${stop.toFixed(2)} · ${sig.model_kind}`,
        reason: `ML[${sig.model_kind}] prob=${sig.prob.toFixed(3)} ≥ thr=${(sig.threshold || this.threshold).toFixed(3)}`,
        ts: now,
      };
      this._persistSignal(sig_payload);
      this.emit('signal', sig_payload);
      result.entries++;
    }
    this.lastCycleResult = result;
  }

  _closePosition(pos, exitPrice, outcome, reason, now) {
    const gross_pct = (exitPrice - pos.entry) / pos.entry * 100;
    const net_pct = gross_pct - this.cfg.commissionPct - 2 * this.cfg.slippagePct;
    const pnl_usd = +(net_pct / 100 * pos.capital_usd).toFixed(4);
    db.prepare(
      `INSERT INTO ml_trades
         (symbol, entry, exit, target_pct, stop_pct, prob, entry_ts, exit_ts, outcome, gross_pct, net_pct, pnl_usd, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(pos.symbol, pos.entry, exitPrice, pos.target_pct, pos.stop_pct, pos.prob,
          pos.entry_ts, now, outcome, gross_pct, net_pct, pnl_usd, reason);
    db.prepare(`DELETE FROM ml_positions WHERE symbol=?`).run(pos.symbol);
    this.openPositions.delete(pos.symbol);
    const sign = net_pct >= 0 ? '+' : '';
    const sig_payload = {
      type: 'EXIT', symbol: pos.symbol, prob: pos.prob, threshold: this.threshold,
      position: { ...pos, exit: exitPrice, exitTs: now, outcome, gross_pct, net_pct, pnl_usd },
      message: `🤖 ML VENDER ${pos.symbol} @ $${exitPrice.toFixed(2)} · ${outcome} ${sign}${net_pct.toFixed(3)}% (${sign}$${pnl_usd}) · ${reason}`,
      reason, ts: now,
    };
    this._persistSignal(sig_payload);
    this.emit('signal', sig_payload);
  }

  state() {
    return {
      enabled: ENABLED,
      cfg: this.cfg,
      threshold: this.threshold,
      modelMeta: this.modelMeta,
      open: Object.fromEntries(this.openPositions),
      lastCycleAt: this.lastCycleAt,
      lastCycleResult: this.lastCycleResult,
      stats: this._stats(),
    };
  }

  _stats() {
    try {
      const row = db.prepare(
        `SELECT COUNT(*) AS trades,
                SUM(CASE WHEN net_pct > 0 THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN net_pct <= 0 THEN 1 ELSE 0 END) AS losses,
                SUM(pnl_usd) AS total_pnl,
                AVG(net_pct) AS avg_net_pct
         FROM ml_trades`
      ).get();
      const trades = Number(row?.trades) || 0;
      const wins = Number(row?.wins) || 0;
      return {
        trades, wins, losses: Number(row?.losses) || 0,
        winRate: trades ? +(wins / trades * 100).toFixed(1) : null,
        totalPnl: +(Number(row?.total_pnl) || 0).toFixed(2),
        avgNetPct: row?.avg_net_pct != null ? +Number(row.avg_net_pct).toFixed(4) : null,
      };
    } catch { return { trades: 0, wins: 0, losses: 0, winRate: null, totalPnl: 0, avgNetPct: null }; }
  }
}

let singleton = null;
function getMLStandaloneEngine() {
  if (!singleton) singleton = new MLStandaloneEngine();
  return singleton;
}

module.exports = { MLStandaloneEngine, getMLStandaloneEngine, ENABLED };
