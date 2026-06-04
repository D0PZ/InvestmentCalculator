/**
 * mlStandaloneEngine — sistema de trading paper basado solo en el modelo ML.
 *
 * Diferencia clave con strategyEngine:
 *  - strategyEngine usa heurísticas (VWAP reclaim + RVOL + RSI). ML solo lo audita.
 *  - mlStandaloneEngine usa SÓLO la probabilidad ML para decidir entries.
 *    Exits por target/stop ATR-relativo + horizonte + cierre de mercado.
 *
 * Gestión inteligente — perfil AGRESIVO (max loss 10% normal, 20% alta convicción):
 *  1) TARGET: tick alcanza target → WIN inmediato, sin confirmación.
 *  2) MAX LOSS: cierre 1m ≤ entry × (1 − max_loss_pct/100) → LOSS. ESTE es el verdadero piso.
 *  3) SIGNAL FLIP: prob ML actual < floor o cayó ≥ exitProbDrop desde entry → exit al precio actual.
 *  4) BREAKEVEN arming: al +R progress, sube current_stop a entry + buffer fees.
 *  5) TRAILING arming: tras +R_TRAIL_TRIGGER, lock = peak − R_TRAIL_LOCK × R_inicial.
 *  6) PROFIT-LOCK STOP: solo si breakeven/trailing ARMADO, sale al current_stop con confirmación 1m.
 *  7) TIMEOUT por horizonte; 8) EOD flat.
 * El stop ATR original NO saca al agente: solo sirve como nivel para calcular R en breakeven/trailing.
 *
 * Cooldown post-LOSS por símbolo evita re-entries inmediatos al chop.
 * Sizing por convicción: capital_usd escala con (prob − threshold).
 *
 * Persiste en tablas separadas: ml_signals, ml_positions, ml_trades.
 * Vars de entorno:
 *   ML_STANDALONE_ENABLED=true            (default true; pone false para apagar)
 *   ML_STANDALONE_INTERVAL_MS=60000       (polling de evaluación)
 *   ML_STANDALONE_THRESHOLD=              (override del threshold del modelo)
 *   ML_STANDALONE_STARTING_CASH=5000      (capital inicial del portafolio del agente)
 *   ML_STANDALONE_TRADE_FRACTION=         (fracción del cash por trade; default 1/MAX_OPEN)
 *   ML_STANDALONE_MIN_TRADE_USD=50        (no entra si el sizing cae bajo este piso)
 *   ML_STANDALONE_MAX_OPEN=3
 *   ML_STANDALONE_COMMISSION_PCT=0.6
 *   ML_STANDALONE_SLIPPAGE_PCT=0.05
 *   ML_STANDALONE_GRACE_SEC=180           (stop ignorado los primeros N segs)
 *   ML_STANDALONE_STOP_CONFIRM_CLOSES=1   (cierres 1m consecutivos ≤ stop)
 *   ML_STANDALONE_BREAKEVEN_R=1.0         (mover a breakeven al alcanzar R×progress)
 *   ML_STANDALONE_TRAIL_TRIGGER_R=1.5     (activar trailing tras este progress)
 *   ML_STANDALONE_TRAIL_LOCK_R=1.0        (lock = peak − R_LOCK × stop_inicial)
 *   ML_STANDALONE_COOLDOWN_LOSS_MIN=15    (minutos de cooldown tras LOSS por símbolo)
 *   ML_STANDALONE_SIZING_BY_PROB=true     (sizing por convicción)
 *   ML_STANDALONE_SIZING_MIN_MULT=0.7
 *   ML_STANDALONE_SIZING_MAX_MULT=1.5
 *   ML_STANDALONE_EXIT_PROB_FLOOR=0.40    (signal flip: exit si prob actual < floor)
 *   ML_STANDALONE_EXIT_PROB_DROP=0.15     (signal decay: exit si prob cae ≥ esta cantidad desde entry)
 *   ML_STANDALONE_MAX_LOSS_PCT=10         (loss máxima tolerada por trade — perfil agresivo)
 *   ML_STANDALONE_MAX_LOSS_PCT_HIGH=20    (loss máxima cuando convicción ≥ HIGH_CONV_THRESHOLD)
 *   ML_STANDALONE_HIGH_CONV_THRESHOLD=0.75 (convicción [0..1] que activa max loss alto)
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
  // Portafolio: el agente parte con startingCash y crece/decrece. Decide monto por trade dinámicamente.
  startingCash:  Number(process.env.ML_STANDALONE_STARTING_CASH) || 5000,
  // Fracción del cash disponible que sirve de base por trade (override; default = 1/maxOpen).
  tradeFraction: process.env.ML_STANDALONE_TRADE_FRACTION
    ? Number(process.env.ML_STANDALONE_TRADE_FRACTION) : null,
  minTradeUsd:   Number(process.env.ML_STANDALONE_MIN_TRADE_USD) || 50,
  maxOpen: Number(process.env.ML_STANDALONE_MAX_OPEN) || 3,
  commissionPct: Number(process.env.ML_STANDALONE_COMMISSION_PCT) || 0.6,
  slippagePct: Number(process.env.ML_STANDALONE_SLIPPAGE_PCT) || 0.05,
  minMinutesFromOpen: 30,
  flatBeforeCloseMin: 5,
  lookbackBars: 180,
  whitelist: parseWhitelist(),
  onlyProfitable: (process.env.ML_STANDALONE_ONLY_PROFITABLE || 'true').toLowerCase() !== 'false',
  graceSec:         Number(process.env.ML_STANDALONE_GRACE_SEC)         || 180,
  stopConfirmCloses: Math.max(1, Number(process.env.ML_STANDALONE_STOP_CONFIRM_CLOSES) || 1),
  breakevenR:       Number(process.env.ML_STANDALONE_BREAKEVEN_R)       || 1.0,
  trailTriggerR:    Number(process.env.ML_STANDALONE_TRAIL_TRIGGER_R)   || 1.5,
  trailLockR:       Number(process.env.ML_STANDALONE_TRAIL_LOCK_R)      || 1.0,
  cooldownLossMin:  Number(process.env.ML_STANDALONE_COOLDOWN_LOSS_MIN) || 15,
  sizingByProb:     (process.env.ML_STANDALONE_SIZING_BY_PROB || 'true').toLowerCase() !== 'false',
  sizingMinMult:    Number(process.env.ML_STANDALONE_SIZING_MIN_MULT)   || 0.7,
  sizingMaxMult:    Number(process.env.ML_STANDALONE_SIZING_MAX_MULT)   || 1.5,
  // Exit por señal ML — re-consulta prob de cada posición y sale si la convicción se pierde
  exitProbFloor:    Number(process.env.ML_STANDALONE_EXIT_PROB_FLOOR)   || 0.40,
  exitProbDrop:     Number(process.env.ML_STANDALONE_EXIT_PROB_DROP)    || 0.15,
  // Perfil agresivo de loss tolerance — NO sale por stop técnico ATR (que es muy ajustado);
  // sale por max_loss_pct real, calculado por convicción al entry.
  //   Convicción baja/media → maxLossPct (10% por defecto)
  //   Convicción alta (≥ highConvThreshold) → maxLossPctHighConv (20% por defecto)
  maxLossPct:         Number(process.env.ML_STANDALONE_MAX_LOSS_PCT)        || 10,
  maxLossPctHighConv: Number(process.env.ML_STANDALONE_MAX_LOSS_PCT_HIGH)   || 20,
  highConvThreshold:  Number(process.env.ML_STANDALONE_HIGH_CONV_THRESHOLD) || 0.75,
  // Catalyst overlay — el agente consulta la tabla `catalysts` al decidir entries:
  //   earnings blackout: no abre scalp si el ticker tiene earnings dentro de N días (gap risk)
  //   bearish veto: no abre si hay ≥ N acciones de analista bajistas frescas y dominan
  catalystAware:        (process.env.ML_STANDALONE_CATALYST_AWARE || 'true').toLowerCase() !== 'false',
  earningsBlackoutDays: Number(process.env.ML_STANDALONE_EARNINGS_BLACKOUT_DAYS) || 1,
  catalystFreshDays:    Number(process.env.ML_STANDALONE_CATALYST_FRESH_DAYS)    || 3,
  catalystBearVeto:     Number(process.env.ML_STANDALONE_CATALYST_BEAR_VETO)     || 2,
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
      this.openPositions = new Map(rows.map(r => {
        // Backfill defensivo si las columnas dinámicas vienen NULL en rehidratación
        if (r.current_stop == null) r.current_stop = r.stop;
        if (r.peak_price == null) r.peak_price = r.entry;
        r.breakeven_armed = !!r.breakeven_armed;
        r.trailing_armed = !!r.trailing_armed;
        return [r.symbol, r];
      }));
    } catch {
      this.openPositions = new Map();
    }
    this.cooldownUntil = new Map(); // symbol -> timestamp (ms)
    this._loadPortfolio();
  }

  _loadPortfolio() {
    try {
      const row = db.prepare(`SELECT * FROM ml_portfolio WHERE id = 1`).get();
      if (row) {
        this.portfolio = {
          startingCash: Number(row.starting_cash),
          cash:         Number(row.cash),
          realizedPnl:  Number(row.realized_pnl),
        };
      } else {
        // Fallback (debería haber sido sembrado por la migración)
        this.portfolio = { startingCash: this.cfg.startingCash, cash: this.cfg.startingCash, realizedPnl: 0 };
      }
    } catch (e) {
      log.warn({ err: e.message }, 'portfolio load failed, using defaults');
      this.portfolio = { startingCash: this.cfg.startingCash, cash: this.cfg.startingCash, realizedPnl: 0 };
    }
  }

  _persistPortfolio() {
    try {
      db.prepare(
        `UPDATE ml_portfolio
            SET cash = ?, realized_pnl = ?, updated_at = datetime('now')
          WHERE id = 1`
      ).run(this.portfolio.cash, this.portfolio.realizedPnl);
    } catch (e) {
      log.error({ err: e.message }, 'portfolio persist failed');
    }
  }

  // Valor de mercado aproximado de las posiciones abiertas (usa lastPrice del snapshot si está,
  // si no usa capital_usd como floor — equity book = cash + capital invertido).
  _equity() {
    let openValue = 0;
    for (const pos of this.openPositions.values()) {
      const snap = this.candleEngine?.snapshot(pos.symbol);
      const px = snap?.lastPrice;
      openValue += Number.isFinite(px) ? pos.shares * px : pos.capital_usd;
    }
    return this.portfolio.cash + openValue;
  }

  _resolveEligibleTickers(watchlist) {
    const REFERENCE = new Set(['SPY', 'QQQ']);
    const base = (watchlist || [])
      .map(t => t.toUpperCase())
      .filter(t => !REFERENCE.has(t));
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

    // 1) Re-evaluar probabilidades ML para posiciones abiertas (exit inteligente por señal)
    const openSymbols = [...this.openPositions.keys()];
    let currentProbBySymbol = new Map();
    if (openSymbols.length > 0) {
      const reEval = await mlClient.signalsBatch({
        tickers: openSymbols,
        threshold: null,
        lookbackBars: this.cfg.lookbackBars,
        onlyPassing: false,  // queremos TODAS las probs, también las que no pasan threshold
      });
      if (reEval && Array.isArray(reEval.signals)) {
        for (const s of reEval.signals) {
          if (Number.isFinite(s.prob)) currentProbBySymbol.set(s.symbol, s.prob);
        }
      }
    }

    // 2) Resolve exits & dinámica de la posición (señal ML + breakeven/trailing/grace/confirmación)
    if (this.candleEngine) {
      for (const [, pos] of [...this.openPositions]) {
        const snap = this.candleEngine.snapshot(pos.symbol);
        if (!snap || !Number.isFinite(snap.lastPrice)) continue;
        const currentProb = currentProbBySymbol.get(pos.symbol);
        if (Number.isFinite(currentProb)) pos.current_prob = currentProb;
        this._managePosition(pos, snap, now);
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

    const candidates = this.watchlist
      .filter(t => !this.openPositions.has(t))
      .filter(t => {
        const until = this.cooldownUntil.get(t);
        return !(until && until > now);
      });
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

      // --- Catalyst overlay: el agente "ve" eventos fundamentales y filtra entradas ---
      if (this.cfg.catalystAware) {
        const cat = this._catalystContext(symbol);
        if (cat.earningsDaysTo != null && cat.earningsDaysTo <= this.cfg.earningsBlackoutDays) {
          log.info({ symbol, earningsDaysTo: cat.earningsDaysTo }, 'skip entry: earnings blackout');
          result.catalystVetoes = (result.catalystVetoes || 0) + 1;
          continue;
        }
        if (cat.freshBear >= this.cfg.catalystBearVeto && cat.freshBear > cat.freshBull) {
          log.info({ symbol, freshBear: cat.freshBear, freshBull: cat.freshBull },
                   'skip entry: acción de analista bajista fresca');
          result.catalystVetoes = (result.catalystVetoes || 0) + 1;
          continue;
        }
        sig._catalyst = cat;
      }

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
      const thr = sig.threshold || this.threshold;
      const capital = +this._decideTradeSize(sig.prob, thr).toFixed(2);
      if (capital <= 0) {
        log.info({ symbol, cash: this.portfolio.cash, prob: sig.prob },
                 'skip entry: insuficiente cash para sizing mínimo');
        continue;
      }
      const shares = +(capital / lastPrice).toFixed(4);
      const entry = +lastPrice.toFixed(4);
      const maxLossPct = this._decideMaxLossPct(sig.prob, thr);
      const conviction = this._conviction(sig.prob, thr);
      const pos = {
        symbol,
        entry,
        target, stop,
        current_stop: stop,        // mutable durante la vida del trade (solo para breakeven/trailing locks)
        peak_price: entry,
        breakeven_armed: false,
        trailing_armed: false,
        max_loss_pct: maxLossPct,
        target_pct: targetPct,
        stop_pct: stopPct,
        prob: sig.prob,
        entry_ts: now,
        expire_ts: now + horizon * 60 * 1000,
        shares,
        capital_usd: capital,
        payload_json: JSON.stringify({
          feature_snapshot: sig.feature_snapshot,
          version: batch.version,
          model_kind: sig.model_kind,
          label_cfg: lc,
          catalyst: sig._catalyst || null,
          sizing: {
            cash_before: this.portfolio.cash,
            applied: capital,
            prob: sig.prob,
            threshold: thr,
            conviction,
            max_loss_pct: maxLossPct,
            fraction: this.cfg.tradeFraction ?? (1 / Math.max(1, this.cfg.maxOpen)),
          },
        }),
      };
      db.prepare(
        `INSERT INTO ml_positions
           (symbol, entry, target, stop, current_stop, peak_price, breakeven_armed, trailing_armed,
            max_loss_pct, target_pct, stop_pct, prob, entry_ts, expire_ts, shares, capital_usd, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(pos.symbol, pos.entry, pos.target, pos.stop, pos.current_stop, pos.peak_price,
            pos.max_loss_pct, pos.target_pct, pos.stop_pct, pos.prob, pos.entry_ts, pos.expire_ts,
            pos.shares, pos.capital_usd, pos.payload_json);
      this.openPositions.set(symbol, pos);
      // Deducir el capital del cash del portafolio
      this.portfolio.cash = +(this.portfolio.cash - capital).toFixed(4);
      this._persistPortfolio();
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

  _conviction(prob, threshold) {
    const span = Math.max(1e-6, 1 - threshold);
    return Math.min(1, Math.max(0, (prob - threshold) / span));
  }

  // Lee la tabla `catalysts` para el símbolo: días al próximo earnings + acciones de analistas
  // frescas. Hace al agente "consciente" de eventos fundamentales (mismos datos que el Catalyst
  // Radar de /live). Es barato (índices por ticker/type) y tolerante a fallos.
  _catalystContext(symbol) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const er = db.prepare(
        `SELECT event_date FROM catalysts WHERE ticker=? AND type='earnings' AND event_date>=?
         ORDER BY event_date ASC LIMIT 1`
      ).get(symbol, today);
      let earningsDaysTo = null;
      if (er) {
        earningsDaysTo = Math.round(
          (Date.parse(er.event_date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
      }
      const since = new Date(Date.now() - this.cfg.catalystFreshDays * 86400000).toISOString().slice(0, 10);
      const ratings = db.prepare(
        `SELECT sentiment FROM catalysts WHERE ticker=? AND type='rating' AND event_date>=?`
      ).all(symbol, since);
      let freshBull = 0, freshBear = 0;
      for (const r of ratings) {
        if (r.sentiment === 'bullish') freshBull++;
        else if (r.sentiment === 'bearish') freshBear++;
      }
      return { earningsDaysTo, freshBull, freshBear };
    } catch {
      return { earningsDaysTo: null, freshBull: 0, freshBear: 0 };
    }
  }

  // Calcula max_loss_pct para esta posición según convicción.
  // Convicción alta (≥ highConvThreshold) → tolerancia ampliada (maxLossPctHighConv).
  _decideMaxLossPct(prob, threshold) {
    const c = this._conviction(prob, threshold);
    return c >= this.cfg.highConvThreshold ? this.cfg.maxLossPctHighConv : this.cfg.maxLossPct;
  }

  // Decide el monto en USD a invertir en este trade.
  //  - Base = cash * tradeFraction (default 1/maxOpen → ~33% cuando maxOpen=3)
  //  - Convicción escala la base entre sizingMinMult y sizingMaxMult según (prob−threshold)/(1−threshold)
  //  - Cap absoluto = cash disponible. Si el resultado < minTradeUsd, devuelve 0 (skip trade).
  _decideTradeSize(prob, threshold) {
    const cash = this.portfolio?.cash ?? 0;
    if (cash < this.cfg.minTradeUsd) return 0;
    const fraction = this.cfg.tradeFraction ?? (1 / Math.max(1, this.cfg.maxOpen));
    let base = cash * fraction;
    if (this.cfg.sizingByProb) {
      const span = Math.max(1e-6, 1 - threshold);
      const conviction = Math.min(1, Math.max(0, (prob - threshold) / span));
      const mult = this.cfg.sizingMinMult + conviction * (this.cfg.sizingMaxMult - this.cfg.sizingMinMult);
      base *= mult;
    }
    const sized = Math.min(base, cash);
    return sized >= this.cfg.minTradeUsd ? sized : 0;
  }

  // Tipping fee buffer en %: comisión + dos slippages (entry+exit), traducido a precio.
  _feeBufferPct() {
    return this.cfg.commissionPct + 2 * this.cfg.slippagePct;
  }

  _persistPosUpdate(pos) {
    try {
      db.prepare(
        `UPDATE ml_positions
            SET current_stop=?, peak_price=?, breakeven_armed=?, trailing_armed=?
          WHERE symbol=?`
      ).run(pos.current_stop, pos.peak_price,
            pos.breakeven_armed ? 1 : 0, pos.trailing_armed ? 1 : 0,
            pos.symbol);
    } catch (e) {
      log.warn({ err: e.message, symbol: pos.symbol }, 'persist update failed');
    }
  }

  // Confirma stop solo cuando el último cierre 1m (ya cerrado) es ≤ current_stop.
  // Requiere N cierres consecutivos según cfg.stopConfirmCloses.
  _stopConfirmedByCloses(snap, stopLevel, n) {
    const candles = snap?.candles1m;
    if (!Array.isArray(candles) || candles.length < n + 1) return false;
    // El último elemento puede ser la vela en curso (no cerrada). Tomamos las N anteriores.
    const closed = candles.slice(-1 - n, -1);
    if (closed.length < n) return false;
    return closed.every(c => Number.isFinite(c?.c) && c.c <= stopLevel);
  }

  // Última vela 1m cerrada (no la que está en curso). Útil para confirmaciones y catastrophic.
  _lastClosedCandle1m(snap) {
    const c = snap?.candles1m;
    if (!Array.isArray(c) || c.length < 2) return null;
    return c[c.length - 2];
  }

  _managePosition(pos, snap, now) {
    const price = snap.lastPrice;
    const initialRisk = pos.entry - pos.stop; // R en $ por share (basado en ATR del modelo)
    const lastClose = this._lastClosedCandle1m(snap)?.c;
    const maxLossPct = pos.max_loss_pct ?? this.cfg.maxLossPct;

    // Track peak para trailing
    if (Number.isFinite(price) && price > (pos.peak_price ?? pos.entry)) {
      pos.peak_price = price;
    }

    // ===== EXITS POR PRIORIDAD (perfil agresivo) =====

    // 1) TARGET — exit limpio por tick, sin confirmación (ganancias siempre se toman)
    if (price >= pos.target) {
      this._closePosition(pos, pos.target, 'WIN', 'target alcanzado', now);
      return;
    }

    // 2) MAX LOSS — el verdadero piso de pérdida. Cierre 1m por debajo de entry × (1 − max_loss_pct/100).
    //    Reemplaza al stop ATR original (que es demasiado ajustado para perfil agresivo).
    //    Por defecto: 10% normal, 20% en alta convicción.
    if (Number.isFinite(lastClose)) {
      const maxLossLevel = pos.entry * (1 - maxLossPct / 100);
      if (lastClose <= maxLossLevel) {
        this._closePosition(pos, lastClose, 'LOSS', `max loss ${maxLossPct}% alcanzado`, now);
        return;
      }
    }

    // 3) SIGNAL FLIP — el modelo ML perdió convicción → exit al precio actual.
    if (Number.isFinite(pos.current_prob)) {
      const dropFromEntry = (pos.prob ?? this.threshold) - pos.current_prob;
      const flippedAbsolute = pos.current_prob < this.cfg.exitProbFloor;
      const flippedRelative = dropFromEntry >= this.cfg.exitProbDrop;
      if (flippedAbsolute || flippedRelative) {
        const outcome = price > pos.entry ? 'WIN' : price < pos.entry ? 'LOSS' : 'SIGNAL_FLIP';
        const reason = flippedAbsolute
          ? `signal flip · prob ${pos.current_prob.toFixed(3)} < floor ${this.cfg.exitProbFloor}`
          : `signal decay · prob ${pos.current_prob.toFixed(3)} (entry ${pos.prob?.toFixed(3)}, Δ=${dropFromEntry.toFixed(3)})`;
        this._closePosition(pos, price, outcome === 'SIGNAL_FLIP' ? 'SIGNAL_FLIP' : outcome, reason, now);
        return;
      }
    }

    // 4) BREAKEVEN arming — al cruzar entry + breakevenR × R, mueve current_stop a entry + buffer fees.
    //    A partir de aquí, si retrocede al breakeven, salimos con ganancia ~0% neta.
    if (!pos.breakeven_armed && initialRisk > 0) {
      const trigger = pos.entry + this.cfg.breakevenR * initialRisk;
      if (price >= trigger) {
        const buffer = pos.entry * (this._feeBufferPct() / 100);
        const newStop = +(pos.entry + buffer).toFixed(4);
        if (newStop > pos.current_stop) {
          pos.current_stop = newStop;
          pos.breakeven_armed = true;
          this._persistPosUpdate(pos);
          log.info({ symbol: pos.symbol, current_stop: newStop, entry: pos.entry },
                   'breakeven armed');
        }
      }
    }

    // 5) TRAILING — al cruzar entry + trailTriggerR × R, lock = peak − trailLockR × R
    if (initialRisk > 0) {
      const trailTrigger = pos.entry + this.cfg.trailTriggerR * initialRisk;
      if (pos.peak_price >= trailTrigger) {
        const trailedStop = +(pos.peak_price - this.cfg.trailLockR * initialRisk).toFixed(4);
        if (trailedStop > pos.current_stop) {
          pos.current_stop = trailedStop;
          pos.trailing_armed = true;
          this._persistPosUpdate(pos);
          log.info({ symbol: pos.symbol, current_stop: trailedStop, peak: pos.peak_price },
                   'trailing updated');
        }
      }
    }

    // 6) PROFIT-LOCK STOP — solo se gatilla si breakeven/trailing ya están armados.
    //    Sale al current_stop con confirmación 1m. Si NO está armado, el stop ATR original NO saca al agente:
    //    el verdadero piso es maxLossPct (paso 2). Esto es lo que da el perfil agresivo.
    if ((pos.breakeven_armed || pos.trailing_armed) && price <= pos.current_stop) {
      const confirmed = this._stopConfirmedByCloses(snap, pos.current_stop, this.cfg.stopConfirmCloses);
      if (!confirmed) return; // wick: no salir
      const reason = pos.trailing_armed ? 'trailing stop' : 'breakeven stop';
      const outcome = pos.current_stop >= pos.entry ? 'WIN' : 'LOSS';
      this._closePosition(pos, pos.current_stop, outcome, reason, now);
      return;
    }

    // 7) TIMEOUT por horizonte
    if (now >= pos.expire_ts) {
      const outcome = price > pos.entry ? 'WIN' : price < pos.entry ? 'LOSS' : 'TIMEOUT';
      this._closePosition(pos, price, outcome === 'TIMEOUT' ? 'TIMEOUT' : outcome,
                          `timeout ${this.horizonMin}m`, now);
      return;
    }

    // 8) EOD flat
    if (nyMinuteOfDay(now) >= NYSE_CLOSE_MIN - this.cfg.flatBeforeCloseMin) {
      const outcome = price > pos.entry ? 'WIN' : price < pos.entry ? 'LOSS' : 'EOD_CLOSE';
      this._closePosition(pos, price, outcome === 'EOD_CLOSE' ? 'EOD_CLOSE' : outcome,
                          'cierre de mercado', now);
    }
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
    // Devolver capital invertido + P&L neto al cash, actualizar realized_pnl acumulado
    const proceeds = +(pos.capital_usd + pnl_usd).toFixed(4);
    this.portfolio.cash = +(this.portfolio.cash + proceeds).toFixed(4);
    this.portfolio.realizedPnl = +(this.portfolio.realizedPnl + pnl_usd).toFixed(4);
    this._persistPortfolio();
    // Cooldown anti-chop: tras LOSS, bloquear re-entry del mismo símbolo por N minutos
    if (outcome === 'LOSS' && this.cfg.cooldownLossMin > 0) {
      this.cooldownUntil.set(pos.symbol, now + this.cfg.cooldownLossMin * 60 * 1000);
    }
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
    const cooldowns = {};
    const now = Date.now();
    for (const [sym, ts] of this.cooldownUntil) {
      if (ts > now) cooldowns[sym] = ts;
    }
    const equity = this._equity();
    const portfolio = this.portfolio ? {
      startingCash: this.portfolio.startingCash,
      cash: this.portfolio.cash,
      realizedPnl: this.portfolio.realizedPnl,
      equity: +equity.toFixed(2),
      openValue: +(equity - this.portfolio.cash).toFixed(2),
      returnPct: this.portfolio.startingCash > 0
        ? +(((equity - this.portfolio.startingCash) / this.portfolio.startingCash) * 100).toFixed(3)
        : null,
    } : null;
    return {
      enabled: ENABLED,
      cfg: this.cfg,
      threshold: this.threshold,
      modelMeta: this.modelMeta,
      portfolio,
      open: Object.fromEntries(this.openPositions),
      cooldowns,
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
