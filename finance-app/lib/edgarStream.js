const { EventEmitter } = require('node:events');

const EDGAR_RECENT = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&output=atom&count=100';
const POLL_MS = 5000;
const MAX_DEDUPE = 500;

const TICKER_TO_CIK = {
  MSFT: '0000789019',
  AAPL: '0000320193',
  NVDA: '0001045810',
  TSLA: '0001318605',
  TTWO: '0000946581',
  GOOG: '0001652044',
  GOOGL: '0001652044',
  AMZN: '0001018724',
  META: '0001326801',
  AMD:  '0000002488',
  NFLX: '0001065280',
};

const HEADERS = {
  'User-Agent': 'finance-app personal-use diego.pavez@outlook.com',
  'Accept': 'application/atom+xml,text/xml,*/*',
};

function extract(re, str) {
  const m = re.exec(str);
  return m ? m[1] : null;
}

function parseEntries(xml) {
  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(xml)) !== null) {
    const body = m[1];
    const title = extract(/<title>([\s\S]*?)<\/title>/, body) || '';
    const link = extract(/<link[^>]*href="([^"]+)"/, body) || '';
    const updated = extract(/<updated>([\s\S]*?)<\/updated>/, body) || '';
    const summary = extract(/<summary[^>]*>([\s\S]*?)<\/summary>/, body) || '';
    const cikMatch = /CIK=(\d{10})/i.exec(link) || /CIK=(\d+)/i.exec(link);
    const accMatch = /accession[_-]?number=([\d-]+)/i.exec(link) || /(\d{10}-\d{2}-\d{6})/.exec(link);
    entries.push({
      title: title.trim(),
      link: link.trim(),
      updated,
      summary: summary.replace(/<[^>]+>/g, '').trim(),
      cik: cikMatch ? cikMatch[1].padStart(10, '0') : null,
      accession: accMatch ? accMatch[1] : link,
    });
  }
  return entries;
}

class EdgarStream extends EventEmitter {
  constructor({ watchlist, tickerMap } = {}) {
    super();
    this.watchlist = (watchlist || []).map(s => s.toUpperCase());
    this.tickerMap = { ...TICKER_TO_CIK, ...(tickerMap || {}) };
    this.cikToTicker = this._buildReverseMap();
    this.seen = new Set();
    this.timer = null;
    this.running = false;
    this.lastError = null;
    this.lastPollAt = 0;
    this.bootstrapped = false;
  }

  _buildReverseMap() {
    const out = new Map();
    for (const [ticker, cik] of Object.entries(this.tickerMap)) {
      if (this.watchlist.includes(ticker)) out.set(cik.padStart(10, '0'), ticker);
    }
    return out;
  }

  setWatchlist(next) {
    this.watchlist = (next || []).map(s => s.toUpperCase());
    this.cikToTicker = this._buildReverseMap();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._tick();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }

  async _tick() {
    if (!this.running) return;
    try {
      await this._poll();
    } catch (err) {
      this.lastError = err?.message || String(err);
      this.emit('status', { state: 'error', message: this.lastError });
    }
    if (!this.running) return;
    this.timer = setTimeout(() => this._tick(), POLL_MS);
  }

  async _poll() {
    if (this.cikToTicker.size === 0) return;
    const res = await fetch(EDGAR_RECENT, { headers: HEADERS });
    this.lastPollAt = Date.now();
    if (!res.ok) {
      this.lastError = `HTTP ${res.status}`;
      this.emit('status', { state: 'error', message: this.lastError });
      return;
    }
    const xml = await res.text();
    const entries = parseEntries(xml);
    for (const e of entries) {
      if (!e.cik) continue;
      const ticker = this.cikToTicker.get(e.cik);
      if (!ticker) continue;
      const id = `${ticker}:${e.accession}`;
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      if (this.seen.size > MAX_DEDUPE) {
        const first = this.seen.values().next().value;
        this.seen.delete(first);
      }
      if (!this.bootstrapped) continue;
      this.emit('filing', {
        symbol: ticker,
        formType: '8-K',
        title: e.title,
        summary: e.summary,
        url: e.link,
        ts: e.updated ? Date.parse(e.updated) : Date.now(),
      });
    }
    if (!this.bootstrapped) {
      this.bootstrapped = true;
      this.emit('status', { state: 'bootstrapped', seenCount: this.seen.size });
    }
  }
}

let singleton = null;
function getEdgarStream(opts) {
  if (!singleton) singleton = new EdgarStream(opts || {});
  return singleton;
}

module.exports = { EdgarStream, getEdgarStream, TICKER_TO_CIK };
