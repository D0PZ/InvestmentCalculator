const { EventEmitter } = require('node:events');

const MAX_CANDLES_1M = 390;
const MAX_CANDLES_5M = 120;
const RSI_PERIOD = 14;

function bucketStart(ts, minutes) {
  const ms = minutes * 60 * 1000;
  return Math.floor(ts / ms) * ms;
}

function newCandle(start, price) {
  return { t: start, o: price, h: price, l: price, c: price, v: 0 };
}

function updateCandle(candle, price, volume) {
  if (price > candle.h) candle.h = price;
  if (price < candle.l) candle.l = price;
  candle.c = price;
  candle.v += volume;
}

function ema(prev, value, period) {
  const k = 2 / (period + 1);
  return prev == null ? value : value * k + prev * (1 - k);
}

function computeRSI(closes, period = RSI_PERIOD) {
  if (closes.length <= period) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff; else loss -= diff;
  }
  gain /= period; loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

class SymbolState {
  constructor(symbol) {
    this.symbol = symbol;
    this.candles1m = [];
    this.candles5m = [];
    this.vwapNum = 0;
    this.vwapDen = 0;
    this.vwap = null;
    this.lastPrice = null;
    this.lastTs = 0;
    this.intradayVolume = 0;
    this.intradayDay = null;
    this.avgDailyVolume = null;
    this.openPrice = null;
    this.prevClose = null;
    this.dayHigh = null;
    this.dayLow = null;
    this.ema9 = null;
    this.ema20 = null;
    this.rsi = null;
  }

  resetIntraday(dayKey) {
    this.intradayDay = dayKey;
    this.intradayVolume = 0;
    this.vwapNum = 0;
    this.vwapDen = 0;
    this.vwap = null;
    this.openPrice = null;
    this.dayHigh = null;
    this.dayLow = null;
    this.candles1m = [];
    this.candles5m = [];
    this.ema9 = null;
    this.ema20 = null;
    this.rsi = null;
  }

  ingest(tick) {
    const { price, volume, ts } = tick;
    const dayKey = new Date(ts).toISOString().slice(0, 10);
    if (this.intradayDay !== dayKey) this.resetIntraday(dayKey);

    this.lastPrice = price;
    this.lastTs = ts;
    if (this.openPrice == null) this.openPrice = price;
    this.dayHigh = this.dayHigh == null ? price : Math.max(this.dayHigh, price);
    this.dayLow = this.dayLow == null ? price : Math.min(this.dayLow, price);

    this.intradayVolume += volume;
    this.vwapNum += price * volume;
    this.vwapDen += volume;
    this.vwap = this.vwapDen > 0 ? this.vwapNum / this.vwapDen : null;

    this._pushCandle(this.candles1m, 1, MAX_CANDLES_1M, price, volume, ts);
    this._pushCandle(this.candles5m, 5, MAX_CANDLES_5M, price, volume, ts);

    const closes = this.candles1m.map(c => c.c);
    const lastClose = closes[closes.length - 1];
    if (closes.length >= 2 && closes[closes.length - 2] !== lastClose) {
      this.ema9 = ema(this.ema9, lastClose, 9);
      this.ema20 = ema(this.ema20, lastClose, 20);
      this.rsi = computeRSI(closes, RSI_PERIOD);
    } else if (closes.length === 1) {
      this.ema9 = lastClose;
      this.ema20 = lastClose;
    }
  }

  _pushCandle(arr, minutes, max, price, volume, ts) {
    const start = bucketStart(ts, minutes);
    const last = arr[arr.length - 1];
    if (!last || last.t !== start) {
      arr.push(newCandle(start, price));
      while (arr.length > max) arr.shift();
    }
    updateCandle(arr[arr.length - 1], price, volume);
  }

  setReferenceData({ avgDailyVolume, prevClose } = {}) {
    if (Number.isFinite(avgDailyVolume) && avgDailyVolume > 0) this.avgDailyVolume = avgDailyVolume;
    if (Number.isFinite(prevClose) && prevClose > 0) this.prevClose = prevClose;
  }

  rvol() {
    if (!this.avgDailyVolume || this.avgDailyVolume <= 0) return null;
    // Usar minutos en NY directamente — evita el bug del offset UTC (EST vs EDT)
    // que asumía apertura a 14:30 UTC y rompía el cálculo durante DST.
    const ts = this.lastTs || Date.now();
    const parts = {};
    for (const p of new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(ts))) parts[p.type] = p.value;
    const nyMin = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
    const minsSinceOpen = Math.max(1, nyMin - (9 * 60 + 30));  // 9:30 NY = open
    const sessionMins = 390;
    const expected = this.avgDailyVolume * Math.min(minsSinceOpen, sessionMins) / sessionMins;
    return expected > 0 ? this.intradayVolume / expected : null;
  }

  gapPct() {
    if (!this.prevClose || !this.openPrice) return null;
    return ((this.openPrice - this.prevClose) / this.prevClose) * 100;
  }

  changePct() {
    if (!this.prevClose || !this.lastPrice) return null;
    return ((this.lastPrice - this.prevClose) / this.prevClose) * 100;
  }

  snapshot() {
    return {
      symbol: this.symbol,
      lastPrice: this.lastPrice,
      lastTs: this.lastTs,
      openPrice: this.openPrice,
      prevClose: this.prevClose,
      dayHigh: this.dayHigh,
      dayLow: this.dayLow,
      vwap: this.vwap,
      ema9: this.ema9,
      ema20: this.ema20,
      rsi: this.rsi,
      rvol: this.rvol(),
      gapPct: this.gapPct(),
      changePct: this.changePct(),
      intradayVolume: this.intradayVolume,
      candles1m: this.candles1m.slice(),
      candles5m: this.candles5m.slice(),
    };
  }
}

class CandleEngine extends EventEmitter {
  constructor() {
    super();
    this.bySymbol = new Map();
  }

  ensure(symbol) {
    let s = this.bySymbol.get(symbol);
    if (!s) { s = new SymbolState(symbol); this.bySymbol.set(symbol, s); }
    return s;
  }

  bindFeed(feed) {
    feed.on('tick', (tick) => {
      const s = this.ensure(tick.symbol);
      s.ingest(tick);
      this.emit('update', { symbol: tick.symbol, snapshot: s.snapshot() });
    });
  }

  setReferenceData(symbol, data) {
    this.ensure(symbol).setReferenceData(data);
  }

  snapshot(symbol) {
    const s = this.bySymbol.get(symbol);
    return s ? s.snapshot() : null;
  }

  snapshots() {
    const out = {};
    for (const [sym, state] of this.bySymbol) out[sym] = state.snapshot();
    return out;
  }
}

let singleton = null;
function getCandleEngine() {
  if (!singleton) singleton = new CandleEngine();
  return singleton;
}

module.exports = { CandleEngine, getCandleEngine };
