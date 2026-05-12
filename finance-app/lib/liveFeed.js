const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

const FINNHUB_WS = 'wss://ws.finnhub.io';
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const PING_INTERVAL_MS = 30000;
const WATCHDOG_MS = 5 * 60 * 1000;

const DEFAULT_WATCHLIST = [
  'MSFT', 'TTWO', 'NOW', 'ACN',
  'GOOGL', 'AMZN', 'META', 'NVDA',
  'AMD', 'MU', 'INTC', 'TSM',
  'PLTR', 'TSLA', 'CRWD', 'SHOP',
  'LLY', 'UNH', 'V', 'COST',
];

function parseWatchlist(raw) {
  if (!raw) return [];
  return [...new Set(
    raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  )];
}

class LiveFeed extends EventEmitter {
  constructor({ apiKey, watchlist } = {}) {
    super();
    this.apiKey = apiKey || process.env.FINNHUB_API_KEY || '';
    const fromEnv = parseWatchlist(process.env.LIVE_WATCHLIST);
    this.watchlist = Array.isArray(watchlist) && watchlist.length
      ? watchlist
      : (fromEnv.length ? fromEnv : DEFAULT_WATCHLIST.slice());
    this.ws = null;
    this.reconnectMs = RECONNECT_MIN_MS;
    this.reconnectTimer = null;
    this.watchdogTimer = null;
    this.pingTimer = null;
    this.stopped = false;
    this.connected = false;
    this.lastBySymbol = new Map();
  }

  start() {
    if (!this.apiKey) {
      this.emit('status', { state: 'no-key', message: 'FINNHUB_API_KEY missing in .env' });
      return;
    }
    if (this.watchlist.length === 0) {
      this.emit('status', { state: 'empty-watchlist', message: 'LIVE_WATCHLIST is empty' });
      return;
    }
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.watchdogTimer);
    clearInterval(this.pingTimer);
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch {}
      this.ws = null;
    }
    this.connected = false;
    this.emit('status', { state: 'stopped' });
  }

  setWatchlist(next) {
    const cleaned = parseWatchlist(Array.isArray(next) ? next.join(',') : String(next || ''));
    const added = cleaned.filter(s => !this.watchlist.includes(s));
    const removed = this.watchlist.filter(s => !cleaned.includes(s));
    this.watchlist = cleaned;
    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      for (const s of removed) this._send({ type: 'unsubscribe', symbol: s });
      for (const s of added) this._send({ type: 'subscribe', symbol: s });
    }
  }

  getSnapshot() {
    const out = {};
    for (const [sym, last] of this.lastBySymbol) out[sym] = last;
    return out;
  }

  _connect() {
    if (this.stopped) return;
    const url = `${FINNHUB_WS}?token=${encodeURIComponent(this.apiKey)}`;
    this.emit('status', { state: 'connecting' });
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.reconnectMs = RECONNECT_MIN_MS;
      this.emit('status', { state: 'connected', watchlist: this.watchlist.slice() });
      for (const sym of this.watchlist) {
        this._send({ type: 'subscribe', symbol: sym });
      }
      this._armWatchdog();
      this._startPinging();
    });

    ws.on('pong', () => this._armWatchdog());

    ws.on('message', (raw) => {
      this._armWatchdog();
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ping') return;
      if (msg.type === 'trade' && Array.isArray(msg.data)) {
        for (const t of msg.data) {
          if (!t || !t.s) continue;
          const tick = {
            symbol: String(t.s).toUpperCase(),
            price: Number(t.p),
            ts: Number(t.t),
            volume: Number(t.v) || 0,
            conditions: Array.isArray(t.c) ? t.c : [],
          };
          if (!Number.isFinite(tick.price) || !Number.isFinite(tick.ts)) continue;
          this.lastBySymbol.set(tick.symbol, tick);
          this.emit('tick', tick);
        }
      }
    });

    ws.on('error', (err) => {
      this.emit('status', { state: 'error', message: err?.message || String(err) });
    });

    ws.on('close', (code, reason) => {
      this.connected = false;
      clearTimeout(this.watchdogTimer);
      clearInterval(this.pingTimer);
      this.emit('status', {
        state: 'disconnected',
        code,
        reason: reason?.toString() || '',
      });
      if (this.stopped) return;
      const delay = this.reconnectMs;
      this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
      this.reconnectTimer = setTimeout(() => this._connect(), delay);
    });
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(JSON.stringify(obj)); } catch {}
  }

  _startPinging() {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try { this.ws.ping(); } catch {}
      }
    }, PING_INTERVAL_MS);
  }

  _armWatchdog() {
    clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try { this.ws.terminate(); } catch {}
      }
    }, WATCHDOG_MS);
  }
}

let singleton = null;
function getLiveFeed() {
  if (!singleton) singleton = new LiveFeed();
  return singleton;
}

module.exports = { LiveFeed, getLiveFeed, parseWatchlist };
