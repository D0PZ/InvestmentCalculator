/**
 * catalystStream — radar de catalizadores fundamentales por ticker, basado en Finnhub.
 *
 * Hermano fundamental de edgarStream (que vigila 8-K de SEC). Mientras edgar capta
 * "evento material ya ocurrido", catalystStream capta el ciclo de eventos que mueven
 * la acción en horizonte de días/semanas:
 *
 *   - earnings:    próxima fecha de resultados (free: /calendar/earnings) → countdown +
 *                  feature de evento del modelo ML (días-a-earnings).
 *   - rating:      acciones de analistas (iniciación / upgrade / downgrade / price target)
 *                  RECONSTRUIDAS desde /company-news por keywords + casa de análisis.
 *                  (El endpoint /stock/upgrade-downgrade es premium → este es el sustituto.)
 *   - reco_trend:  distribución buy/hold/sell mensual (free: /stock/recommendation) y su
 *                  cambio mes a mes (drift de consenso).
 *
 * Free tier = 60 req/min. Hacemos rotación: UN ticker por tick, 3 endpoints espaciados,
 * y pausa larga entre barridos completos. Pico ~30 req/min, holgado.
 *
 * Persiste en la tabla `catalysts` con dedupe_key UNIQUE (INSERT OR IGNORE → idempotente).
 * El gating de emisión de alertas usa "filas nuevas + recientes": como el backfill ya
 * dejó el histórico en la tabla, sólo un evento genuinamente nuevo dispara alerta. No hay
 * replay tras reinicio.
 *
 * Vars de entorno:
 *   FINNHUB_API_KEY                    (requerida; sin ella queda idle)
 *   CATALYST_ENABLED=true
 *   CATALYST_PER_TICKER_MS=6000        (gap entre tickers en el barrido)
 *   CATALYST_SWEEP_PAUSE_MS=1800000    (pausa tras barrido completo; 30 min)
 *   CATALYST_ENDPOINT_GAP_MS=800       (gap entre los 3 endpoints de un ticker)
 *   CATALYST_EARNINGS_SOON_DAYS=7      (umbral para alertar earnings inminente)
 *   CATALYST_NEWS_LOOKBACK_DAYS=10     (ventana de news que se escanea por barrido)
 *   CATALYST_EMIT_RECENCY_DAYS=4       (sólo emite alerta de rating si la noticia es así de reciente)
 */

const { EventEmitter } = require('node:events');
const db = require('./db');
const log = require('./logger').child('catalyst');

const FINNHUB = 'https://finnhub.io/api/v1';

const ENABLED = (process.env.CATALYST_ENABLED || 'true').toLowerCase() !== 'false';
const PER_TICKER_MS   = Number(process.env.CATALYST_PER_TICKER_MS)   || 6000;
const SWEEP_PAUSE_MS  = Number(process.env.CATALYST_SWEEP_PAUSE_MS)  || 30 * 60 * 1000;
const ENDPOINT_GAP_MS = Number(process.env.CATALYST_ENDPOINT_GAP_MS) || 800;
const EARNINGS_SOON_DAYS = Number(process.env.CATALYST_EARNINGS_SOON_DAYS) || 7;
const NEWS_LOOKBACK_DAYS = Number(process.env.CATALYST_NEWS_LOOKBACK_DAYS) || 10;
const EMIT_RECENCY_DAYS  = Number(process.env.CATALYST_EMIT_RECENCY_DAYS)  || 4;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const todayISO = () => new Date().toISOString().slice(0, 10);
const isoFromNow = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const daysBetween = (isoA, isoB) =>
  Math.round((Date.parse(isoB + 'T00:00:00Z') - Date.parse(isoA + 'T00:00:00Z')) / 86400000);

// ---- Detección de acciones de analistas en headlines/summaries de news ----
const FIRMS = [
  'Morgan Stanley', 'Goldman Sachs', 'JPMorgan', 'J.P. Morgan', 'Bank of America', 'BofA',
  'Citigroup', 'Citi', 'Wells Fargo', 'Barclays', 'UBS', 'Jefferies', 'Piper Sandler',
  'Wedbush', 'Oppenheimer', 'Raymond James', 'Truist', 'Evercore', 'Needham', 'Mizuho',
  'Deutsche Bank', 'RBC', 'Stifel', 'KeyBanc', 'TD Cowen', 'Cowen', 'Bernstein', 'Baird',
  'Canaccord', 'Loop Capital', 'Rosenblatt', 'BMO', 'Argus', 'Redburn', 'Guggenheim',
  'Wolfe', 'Melius', 'DA Davidson', 'William Blair', 'Scotiabank', 'Wolfe Research',
  'Morningstar', 'Phillip Securities', 'New Street', 'Erste Group', 'Tigress',
];

// patrón → {action, sentiment, strong}. Orden importa: el primero que matchea gana.
// strong=true → señal de acción de analista por sí sola. strong=false → débil: sólo
// cuenta si además se detecta una casa de análisis (evita roundups genéricos de mercado).
const RATING_RULES = [
  { re: /\b(initiat(?:es|ed|ing|ion)|launch(?:es|ed)?\s+coverage|start(?:s|ed)?\s+coverage|assum(?:es|ed|ing)\s+coverage|begins?\s+coverage)\b/i, action: 'initiation', sentiment: null, strong: true },
  { re: /\bupgrad\w*\b/i, action: 'upgrade', sentiment: 'bullish', strong: true },
  { re: /\bdowngrad\w*\b/i, action: 'downgrade', sentiment: 'bearish', strong: true },
  { re: /\b(rais\w*|lift\w*|boost\w*|hik\w*|increase[sd]?)\s+(?:its?\s+|the\s+)?(?:price\s+)?target\b/i, action: 'pt_raise', sentiment: 'bullish', strong: true },
  { re: /\b(cut\w*|lower\w*|trim\w*|slash\w*|reduce[sd]?)\s+(?:its?\s+|the\s+)?(?:price\s+)?target\b/i, action: 'pt_cut', sentiment: 'bearish', strong: true },
  { re: /\bprice target\b/i, action: 'price_target', sentiment: null, strong: false },
  { re: /\b(reiterat\w*|maintain[s]?|maintained|affirm\w*|reaffirm\w*)\b/i, action: 'reiteration', sentiment: 'neutral', strong: false },
];

// léxico de sesgo para resolver sentiment cuando la regla no lo fija (initiation / price_target)
const BULL_WORDS = /\b(overweight|outperform|strong buy|\bbuy\b|positive|bullish|top pick|conviction)\b/i;
const BEAR_WORDS = /\b(underweight|underperform|\bsell\b|negative|bearish|cautious)\b/i;

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function detectFirmIn(text) {
  if (!text) return null;
  let best = null, bestPos = Infinity;
  for (const f of FIRMS) {
    // \b evita falsos positivos (p.ej. "UBS" dentro de "clubs")
    const m = new RegExp('\\b' + escapeRegex(f) + '\\b', 'i').exec(text);
    if (m && m.index < bestPos) { best = f; bestPos = m.index; }
  }
  return best;
}
// Prefiere la casa nombrada en el titular; cae al summary si el titular no la trae.
function detectFirm(headline, summary) {
  return detectFirmIn(headline) || detectFirmIn(summary);
}

/** Devuelve null si la noticia no parece acción de analista; si lo es, {action, sentiment, firm}. */
function classifyNews(headline, summary) {
  const text = `${headline || ''} . ${summary || ''}`;
  let matched = null;
  for (const rule of RATING_RULES) {
    if (rule.re.test(text)) { matched = rule; break; }
  }
  if (!matched) return null;
  const firm = detectFirm(headline, summary);
  // señal débil (price target / reiteración) sin casa nombrada → probable roundup → descartar
  if (!matched.strong && !firm) return null;
  let sentiment = matched.sentiment;
  if (!sentiment) {
    if (BULL_WORDS.test(text)) sentiment = 'bullish';
    else if (BEAR_WORDS.test(text)) sentiment = 'bearish';
    else sentiment = 'neutral';
  }
  return { action: matched.action, sentiment, firm };
}

class CatalystStream extends EventEmitter {
  constructor({ watchlist } = {}) {
    super();
    this.watchlist = (watchlist || []).map(s => s.toUpperCase());
    this.key = process.env.FINNHUB_API_KEY || '';
    this.timer = null;
    this.running = false;
    this.idx = 0;
    this.lastError = null;
    this.lastSweepStartedAt = 0;
    this.lastTickerAt = 0;
    this.premiumBlocked = new Set();   // endpoints que devolvieron 403
    this.earningsAlerted = new Set();  // `${ticker}:${date}` ya alertados como "inminente"
    this.stats = { ticks: 0, inserts: 0, emits: 0, errors: 0 };
  }

  setWatchlist(next) {
    this.watchlist = (next || []).map(s => s.toUpperCase());
    if (this.idx >= this.watchlist.length) this.idx = 0;
  }

  start() {
    if (this.running) return;
    if (!ENABLED) { log.info('catalystStream disabled by env'); return; }
    if (!this.key) {
      log.warn('FINNHUB_API_KEY ausente — catalystStream queda idle');
      this.emit('status', { state: 'idle', message: 'no FINNHUB_API_KEY' });
      return;
    }
    this.running = true;
    this.emit('status', { state: 'started', watchlist: this.watchlist.length });
    this._tick();
  }

  stop() {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  async _tick() {
    if (!this.running) return;
    const list = this.watchlist;
    if (list.length === 0) { this.timer = setTimeout(() => this._tick(), PER_TICKER_MS); return; }

    if (this.idx === 0) this.lastSweepStartedAt = Date.now();
    const ticker = list[this.idx];
    try {
      await this._processTicker(ticker);
      this.stats.ticks++;
    } catch (err) {
      this.stats.errors++;
      this.lastError = err?.message || String(err);
      log.warn({ ticker, err: this.lastError }, 'processTicker failed');
    }
    this.lastTickerAt = Date.now();

    this.idx++;
    let wait = PER_TICKER_MS;
    if (this.idx >= list.length) {
      this.idx = 0;
      wait = SWEEP_PAUSE_MS;
      this.emit('status', { state: 'swept', tickers: list.length, stats: { ...this.stats } });
      log.info({ stats: this.stats }, 'catalyst sweep complete');
    }
    if (!this.running) return;
    this.timer = setTimeout(() => this._tick(), wait);
  }

  async _fetchJson(pathQuery, tag) {
    if (this.premiumBlocked.has(tag)) return null;
    const sep = pathQuery.includes('?') ? '&' : '?';
    const url = `${FINNHUB}${pathQuery}${sep}token=${this.key}`;
    const res = await fetch(url);
    if (res.status === 403) {
      this.premiumBlocked.add(tag);
      log.warn({ tag }, 'Finnhub endpoint premium (403) — se omite de aquí en más');
      return null;
    }
    if (res.status === 429) {
      log.warn({ tag }, 'Finnhub rate limit (429) — backoff');
      await sleep(2000);
      return null;
    }
    if (!res.ok) { this.lastError = `HTTP ${res.status} ${tag}`; return null; }
    return res.json();
  }

  // INSERT OR IGNORE; devuelve true si insertó fila nueva.
  _persist(row) {
    try {
      const info = db.prepare(
        `INSERT OR IGNORE INTO catalysts
           (ticker, type, event_date, headline, detail, sentiment, firm, source, url, payload_json, ts, dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        row.ticker, row.type, row.event_date || null, row.headline || null, row.detail || null,
        row.sentiment || null, row.firm || null, row.source || 'finnhub', row.url || null,
        row.payload_json || null, row.ts, row.dedupe_key,
      );
      const inserted = Number(info?.changes) > 0;
      if (inserted) this.stats.inserts++;
      return inserted;
    } catch (e) {
      log.warn({ err: e.message, key: row.dedupe_key }, 'catalyst persist failed');
      return false;
    }
  }

  _emit(catalyst) {
    this.stats.emits++;
    this.emit('catalyst', catalyst);
  }

  async _processTicker(ticker, opts = {}) {
    const gap = opts.endpointGapMs ?? ENDPOINT_GAP_MS;
    await this._pollEarnings(ticker, opts);
    await sleep(gap);
    await this._pollRecommendation(ticker, opts);
    await sleep(gap);
    await this._pollNews(ticker, opts);
  }

  async _pollEarnings(ticker, opts = {}) {
    const emit = opts.emit !== false;
    const from = isoFromNow(opts.earningsFromDays ?? -2);
    const to = isoFromNow(opts.earningsToDays ?? 120);
    const data = await this._fetchJson(
      `/calendar/earnings?from=${from}&to=${to}&symbol=${encodeURIComponent(ticker)}`, 'earnings');
    const rows = data?.earningsCalendar || [];
    if (rows.length === 0) return;
    const today = todayISO();
    // Persistir TODAS las fechas (históricas + futuras): el histórico alimenta la feature
    // días-a-earnings del modelo ML; la futura alimenta el countdown del radar.
    for (const r of rows) {
      if (!r.date) continue;
      const dteR = daysBetween(today, r.date);
      this._persist({
        ticker, type: 'earnings', event_date: r.date,
        headline: `Earnings ${ticker} ${r.date}${r.hour ? ' (' + r.hour + ')' : ''}`,
        detail: `EPS ${r.epsActual ?? 'est ' + (r.epsEstimate ?? '—')} · Rev ${r.revenueActual ?? 'est ' + (r.revenueEstimate ?? '—')} · Q${r.quarter ?? '?'} FY${r.year ?? ''}`,
        sentiment: 'neutral', source: 'finnhub:earnings',
        payload_json: JSON.stringify({ ...r, days_to: dteR }),
        ts: Date.now(), dedupe_key: `EARN:${ticker}:${r.date}`,
      });
    }
    // próxima fecha futura → posible alerta de inminencia
    const upcoming = rows
      .filter(r => r.date && r.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    if (!upcoming) return;
    const dte = daysBetween(today, upcoming.date);
    const akey = `${ticker}:${upcoming.date}`;
    if (emit && dte >= 0 && dte <= EARNINGS_SOON_DAYS && !this.earningsAlerted.has(akey)) {
      this.earningsAlerted.add(akey);
      this._emit({
        ticker, type: 'earnings', sentiment: 'neutral', event_date: upcoming.date, days_to: dte,
        headline: `📅 ${ticker}: earnings en ${dte}d (${upcoming.date}${upcoming.hour ? ' ' + upcoming.hour : ''})`,
        detail: `EPS est ${upcoming.epsEstimate ?? '—'}`, source: 'finnhub:earnings',
      });
    }
  }

  async _pollRecommendation(ticker, opts = {}) {
    const emit = opts.emit !== false;
    const data = await this._fetchJson(
      `/stock/recommendation?symbol=${encodeURIComponent(ticker)}`, 'recommendation');
    if (!Array.isArray(data) || data.length === 0) return;
    const score = (r) => (r.strongBuy * 2 + r.buy - r.sell - r.strongSell * 2);
    const total = (r) => (r.strongBuy + r.buy + r.hold + r.sell + r.strongSell) || 1;
    const sorted = [...data].sort((a, b) => (b.period || '').localeCompare(a.period || ''));
    // persistir todos los meses devueltos (histórico de consenso)
    let latestInserted = false;
    sorted.forEach((r, i) => {
      const prev = sorted[i + 1];
      const ins = this._persist({
        ticker, type: 'reco_trend', event_date: r.period,
        headline: `Consenso ${ticker} ${r.period}: SB${r.strongBuy}/B${r.buy}/H${r.hold}/S${r.sell}/SS${r.strongSell}`,
        detail: prev ? `score ${score(r)} (prev ${score(prev)})` : `score ${score(r)}`,
        sentiment: score(r) > 0 ? 'bullish' : score(r) < 0 ? 'bearish' : 'neutral',
        source: 'finnhub:reco',
        payload_json: JSON.stringify({ latest: r, prior: prev || null, score: score(r), score_prev: prev ? score(prev) : null }),
        ts: Date.now(), dedupe_key: `RECO:${ticker}:${r.period}`,
      });
      if (i === 0) latestInserted = ins;
    });
    const latest = sorted[0];
    const prior = sorted[1];
    // emite sólo si el mes más reciente es nuevo (insertado) Y hubo cambio neto de consenso
    if (emit && latestInserted && prior) {
      const d = score(latest) - score(prior);
      const pctBull = ((latest.strongBuy + latest.buy) / total(latest) * 100);
      if (Math.abs(d) >= 2) {
        this._emit({
          ticker, type: 'reco_trend', sentiment: d > 0 ? 'bullish' : 'bearish', event_date: latest.period,
          headline: `📊 ${ticker}: consenso ${d > 0 ? 'mejora' : 'se enfría'} (Δscore ${d > 0 ? '+' : ''}${d}) · ${pctBull.toFixed(0)}% bull`,
          detail: `${latest.period}: SB${latest.strongBuy}/B${latest.buy}/H${latest.hold}/S${latest.sell}/SS${latest.strongSell}`,
          source: 'finnhub:reco',
        });
      }
    }
  }

  async _pollNews(ticker, opts = {}) {
    const emit = opts.emit !== false;
    const from = isoFromNow(-(opts.newsLookbackDays ?? NEWS_LOOKBACK_DAYS));
    const to = todayISO();
    const data = await this._fetchJson(
      `/company-news?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${to}`, 'news');
    if (!Array.isArray(data)) return;
    const recencyCut = Date.now() - EMIT_RECENCY_DAYS * 86400000;
    for (const n of data) {
      const cls = classifyNews(n.headline, n.summary);
      if (!cls) continue;
      const tsMs = (Number(n.datetime) || 0) * 1000;
      const eventDate = tsMs ? new Date(tsMs).toISOString().slice(0, 10) : todayISO();
      const dedupe = `RATE:${ticker}:${n.id || (n.headline || '').slice(0, 40)}`;
      const inserted = this._persist({
        ticker, type: 'rating', event_date: eventDate,
        headline: n.headline || '(sin titular)',
        detail: (n.summary || '').slice(0, 400),
        sentiment: cls.sentiment, firm: cls.firm, source: `news:${n.source || 'finnhub'}`,
        url: n.url || null,
        payload_json: JSON.stringify({ action: cls.action, firm: cls.firm, id: n.id, source: n.source }),
        ts: tsMs || Date.now(), dedupe_key: dedupe,
      });
      // emite alerta sólo si es fila nueva y suficientemente reciente (evita replay del backfill)
      if (emit && inserted && tsMs >= recencyCut) {
        const icon = cls.sentiment === 'bullish' ? '🟢' : cls.sentiment === 'bearish' ? '🔴' : '⚪';
        const firmTxt = cls.firm ? `${cls.firm} ` : '';
        this._emit({
          ticker, type: 'rating', sentiment: cls.sentiment, action: cls.action, firm: cls.firm,
          event_date: eventDate,
          headline: `${icon} ${ticker}: ${firmTxt}${cls.action.replace('_', ' ')} — ${n.headline}`,
          detail: (n.summary || '').slice(0, 240), url: n.url || null, source: `news:${n.source || 'finnhub'}`,
        });
      }
    }
  }

  // Barrido único para backfill (sin scheduler, sin alertas): ventanas amplias para
  // poblar histórico de earnings (feature del modelo), consenso y acciones de analistas.
  async backfillOnce({ newsLookbackDays = 365, earningsFromDays = -400, endpointGapMs = 400, onProgress } = {}) {
    if (!this.key) throw new Error('FINNHUB_API_KEY ausente');
    const opts = { emit: false, newsLookbackDays, earningsFromDays, endpointGapMs };
    for (let i = 0; i < this.watchlist.length; i++) {
      const ticker = this.watchlist[i];
      try {
        await this._processTicker(ticker, opts);
      } catch (e) {
        this.stats.errors++;
        log.warn({ ticker, err: e.message }, 'backfill ticker failed');
      }
      if (onProgress) onProgress(ticker, i + 1, this.watchlist.length, { ...this.stats });
      await sleep(endpointGapMs);
    }
    return { ...this.stats, premiumBlocked: [...this.premiumBlocked] };
  }

  // ---- Lectura para el panel /live/catalysts ----
  getRadar(watchlist) {
    const list = (watchlist || this.watchlist).map(s => s.toUpperCase());
    const today = todayISO();
    const out = [];
    for (const ticker of list) {
      let nextEarnings = null, lastEarnings = null, reco = null, recoPrev = null;
      const ratings = [];
      let thesis = null;
      try {
        const ne = db.prepare(
          `SELECT event_date, headline, detail, payload_json FROM catalysts
            WHERE ticker=? AND type='earnings' AND event_date>=? ORDER BY event_date ASC LIMIT 1`
        ).get(ticker, today);
        if (ne) nextEarnings = { date: ne.event_date, days_to: daysBetween(today, ne.event_date), detail: ne.detail };

        const le = db.prepare(
          `SELECT event_date, payload_json FROM catalysts
            WHERE ticker=? AND type='earnings' AND event_date<? ORDER BY event_date DESC LIMIT 1`
        ).get(ticker, today);
        if (le) { try { lastEarnings = { date: le.event_date, ...JSON.parse(le.payload_json || '{}') }; } catch { lastEarnings = { date: le.event_date }; } }

        const recoRows = db.prepare(
          `SELECT event_date, sentiment, payload_json FROM catalysts
            WHERE ticker=? AND type='reco_trend' ORDER BY event_date DESC LIMIT 2`
        ).all(ticker);
        if (recoRows[0]) { try { reco = { period: recoRows[0].event_date, sentiment: recoRows[0].sentiment, ...JSON.parse(recoRows[0].payload_json || '{}') }; } catch {} }
        if (recoRows[1]) { try { recoPrev = JSON.parse(recoRows[1].payload_json || '{}'); } catch {} }

        // prioriza acciones con casa de análisis nombrada (alta señal) y luego por recencia
        const rRows = db.prepare(
          `SELECT event_date, headline, detail, sentiment, firm, url FROM catalysts
            WHERE ticker=? AND type='rating'
            ORDER BY (firm IS NULL) ASC, event_date DESC, ts DESC LIMIT 5`
        ).all(ticker);
        for (const r of rRows) ratings.push(r);

        const th = db.prepare(
          `SELECT headline, detail, payload_json, ts FROM catalysts
            WHERE ticker=? AND type='thesis' ORDER BY ts DESC LIMIT 1`
        ).get(ticker);
        if (th) { try { thesis = { headline: th.headline, detail: th.detail, ...JSON.parse(th.payload_json || '{}') }; } catch { thesis = { headline: th.headline, detail: th.detail }; } }
      } catch (e) {
        log.warn({ ticker, err: e.message }, 'getRadar query failed');
      }
      out.push({ ticker, nextEarnings, lastEarnings, reco, recoPrev, ratings, thesis });
    }
    // ordena por earnings más próximo primero, luego por rating reciente
    out.sort((a, b) => {
      const da = a.nextEarnings?.days_to ?? 9999;
      const db_ = b.nextEarnings?.days_to ?? 9999;
      return da - db_;
    });
    return out;
  }

  state() {
    return {
      enabled: ENABLED,
      running: this.running,
      hasKey: !!this.key,
      watchlist: this.watchlist,
      idx: this.idx,
      premiumBlocked: [...this.premiumBlocked],
      lastError: this.lastError,
      lastSweepStartedAt: this.lastSweepStartedAt,
      lastTickerAt: this.lastTickerAt,
      stats: { ...this.stats },
      cfg: { PER_TICKER_MS, SWEEP_PAUSE_MS, EARNINGS_SOON_DAYS, NEWS_LOOKBACK_DAYS, EMIT_RECENCY_DAYS },
    };
  }
}

let singleton = null;
function getCatalystStream(opts) {
  if (!singleton) singleton = new CatalystStream(opts || {});
  return singleton;
}

module.exports = { CatalystStream, getCatalystStream, classifyNews, FIRMS };
