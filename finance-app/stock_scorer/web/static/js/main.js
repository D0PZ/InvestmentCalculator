/* ════════════════════════════════════════════════════════════════════
   main.js — WebSocket client + DOM rendering
   Stock Scorer Dashboard
   ════════════════════════════════════════════════════════════════════ */

// ── State ──────────────────────────────────────────────────────────────
let _scores   = [];
let _prevPrices = {};
let _sortCol  = "score";
let _sortDir  = -1;   // -1 = desc, 1 = asc
let _filterText   = "";
let _filterVerdict = "";
let _refreshSecs  = 30;
let _countdownVal = 30;
let _countdownTimer = null;

// ── WebSocket ───────────────────────────────────────────────────────────
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);

  ws.onopen = () => {
    setStatus("connected", "En vivo");
  };

  ws.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.type === "loading") {
      document.getElementById("loading-msg").innerHTML =
        data.message + "<br><small>Esto puede tardar 30-90s la primera vez.</small>";
      return;
    }
    if (data.type === "error") {
      console.error("Server error:", data.message);
      return;
    }
    if (data.type === "update") {
      hideLoading();
      applyUpdate(data);
      resetCountdown(data.refresh || 30);
    }
  };

  ws.onclose = () => {
    setStatus("error", "Desconectado · reconectando…");
    setTimeout(connect, 3000);
  };

  ws.onerror = () => {
    setStatus("error", "Error de conexión");
  };
}

// ── Status helpers ──────────────────────────────────────────────────────
function setStatus(state, text) {
  const dot  = document.getElementById("status-dot");
  const span = document.getElementById("status-text");
  dot.className  = `dot ${state}`;
  span.textContent = text;
}

function hideLoading() {
  const el = document.getElementById("loading-overlay");
  if (el) el.classList.add("hidden");
}

// ── Countdown ───────────────────────────────────────────────────────────
function resetCountdown(secs) {
  _refreshSecs = secs;
  _countdownVal = secs;
  if (_countdownTimer) clearInterval(_countdownTimer);
  renderCountdown();
  _countdownTimer = setInterval(() => {
    _countdownVal = Math.max(0, _countdownVal - 1);
    renderCountdown();
  }, 1000);
}

function renderCountdown() {
  const el = document.getElementById("countdown");
  if (el) el.textContent = _countdownVal;
}

// ── Main update handler ─────────────────────────────────────────────────
function applyUpdate(data) {
  // Update header meta
  document.getElementById("last-update").textContent  = data.timestamp || "—";
  document.getElementById("model-badge").textContent  = data.model_kind || "—";
  document.getElementById("ticker-count").textContent = data.scores?.length ?? "—";
  document.getElementById("kpi-cycle").textContent    = `#${data.cycle}`;

  // Store scores globally for filtering/sorting
  _scores = data.scores || [];

  // KPIs
  renderKPI(data.positions);

  // Panels
  renderOrders(data.orders || [], data.scores || []);
  renderPositions(data.positions || []);
  renderScores();
}

// ── KPI Bar ─────────────────────────────────────────────────────────────
function renderKPI(positions) {
  let totalValue   = 0;
  let totalCost    = 0;
  let totalPnlUsd  = 0;

  (positions || []).forEach(p => {
    if (p.market_value) totalValue += p.market_value;
    totalCost   += p.cost_basis || 0;
    if (p.pnl_usd) totalPnlUsd += p.pnl_usd;
  });

  const pnlPct  = totalCost > 0 ? (totalPnlUsd / totalCost) * 100 : 0;
  const buySig  = _scores.filter(s => s.verdict === "COMPRAR YA" || s.verdict === "COMPRAR (parcial)").length;
  const sellSig = _scores.filter(s => s.verdict === "VENDER SI TIENES").length;

  const portEl = document.getElementById("kpi-portfolio");
  if (portEl) portEl.textContent = totalValue > 0 ? `$${totalValue.toFixed(2)}` : "—";

  const pnlEl = document.getElementById("kpi-pnl");
  if (pnlEl) {
    const sign = totalPnlUsd >= 0 ? "+" : "";
    pnlEl.textContent = totalCost > 0
      ? `${sign}$${totalPnlUsd.toFixed(2)} (${sign}${pnlPct.toFixed(1)}%)`
      : "—";
    pnlEl.className = `kpi__val ${totalPnlUsd >= 0 ? "pnl--pos" : "pnl--neg"}`;
  }

  const buyEl = document.getElementById("kpi-buy-signals");
  if (buyEl) buyEl.textContent = buySig;

  const sellEl = document.getElementById("kpi-sell-signals");
  if (sellEl) sellEl.textContent = sellSig;
}

// ── Orders panel ────────────────────────────────────────────────────────
function verdictClass(v) {
  if (v === "COMPRAR YA")        return "buy";
  if (v === "COMPRAR (parcial)") return "buy2";
  if (v === "VENDER SI TIENES")  return "sell";
  if (v === "WATCHLIST")         return "watch";
  return "neutral";
}

function renderOrders(orders, allScores) {
  const container = document.getElementById("orders-container");
  if (!container) return;

  if (!orders.length) {
    container.innerHTML = `<p class="empty-msg">Sin setups accionables hoy — espera mejor oportunidad.</p>`;
    return;
  }

  const intraConfirmText = (s) => {
    if (!s.intra_signal) return null;
    const vd   = s.vwap_dist != null ? `VWAP ${fmt_pct(s.vwap_dist)}` : "";
    const m1h  = s.momentum_1h != null ? `1h ${fmt_pct(s.momentum_1h)}` : "";
    const stats = [vd, m1h].filter(Boolean).join("  ·  ");

    if (s.verdict.startsWith("COMPRAR")) {
      if (s.intra_signal === "ALCISTA") return { cls: "confirm", text: `✓ Intradía CONFIRMA  (${stats})` };
      if (s.intra_signal === "BAJISTA") return { cls: "warn",    text: `⚠ Intradía CONTRADICE  (${stats}) — espera entry o reduce size 50%` };
      return { cls: "neutral", text: `Intradía neutro  (${stats})` };
    }
    if (s.verdict === "VENDER SI TIENES") {
      if (s.intra_signal === "ALCISTA") return { cls: "warn",    text: `⚠ Intradía rebotando  (${stats}) — quizá esperar` };
      if (s.intra_signal === "BAJISTA") return { cls: "confirm", text: `✓ Intradía CONFIRMA caída  (${stats})` };
    }
    return null;
  };

  let html = "";
  orders.forEach(s => {
    const vc     = verdictClass(s.verdict);
    const cardCl = s.verdict.startsWith("COMPRAR") ? "buy" : s.verdict === "VENDER SI TIENES" ? "sell" : "watch";
    const reasons = (s.verdict_reasons || []).map(r => `<div class="order-card__reason">${r}</div>`).join("");

    let planHtml = "";
    if (s.trade_plan && s.verdict !== "VENDER SI TIENES") {
      const p = s.trade_plan;
      planHtml = `
        <div class="order-card__plan">
          <div class="plan-item plan-item--sl">
            <div class="plan-item__label">Stop Loss</div>
            <div class="plan-item__val">$${p.stop_loss.toFixed(2)} <small style="color:var(--text-dim)">(-${p.risk_pct.toFixed(1)}%)</small></div>
          </div>
          <div class="plan-item plan-item--tp">
            <div class="plan-item__label">Take Profit</div>
            <div class="plan-item__val">$${p.take_profit.toFixed(2)} <small style="color:var(--text-dim)">(+${p.reward_pct.toFixed(1)}%)</small></div>
          </div>
          <div class="plan-item plan-item--rr">
            <div class="plan-item__label">R:R · Size</div>
            <div class="plan-item__val">${p.risk_reward.toFixed(1)} · ${p.position_size_pct.toFixed(1)}%</div>
          </div>
        </div>`;
    }

    const ic = intraConfirmText(s);
    const intraHtml = ic
      ? `<div class="order-card__intra intra--${ic.cls}">${ic.text}</div>`
      : "";

    const price = s.last_price != null ? `$${s.last_price.toFixed(2)}` : "—";

    html += `
      <div class="order-card order-card--${cardCl}">
        <div class="order-card__header">
          <span class="order-card__ticker">${s.ticker}</span>
          <span class="order-card__verdict verdict--${vc}">${s.verdict}</span>
          <span class="order-card__price">${price}</span>
        </div>
        <div class="order-card__reasons">${reasons}</div>
        ${planHtml}
        ${intraHtml}
      </div>`;
  });

  container.innerHTML = html;
}

// ── Positions panel ─────────────────────────────────────────────────────
function renderPositions(positions) {
  const container = document.getElementById("positions-container");
  if (!container) return;

  if (!positions.length) {
    container.innerHTML = `<p class="empty-msg">No hay posiciones registradas.<br><small>Usá: py -m stock_scorer.live_monitor --add TICKER ...</small></p>`;
    return;
  }

  let html = "";
  positions.forEach(p => {
    const pnl    = p.pnl_pct;
    const pnlCl  = pnl == null ? "pnl--zero" : pnl >= 0 ? "pnl--pos" : "pnl--neg";
    const pnlTxt = pnl != null ? `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%` : "—";
    const pnlUsd = p.pnl_usd != null ? ` ($${p.pnl_usd >= 0 ? "+" : ""}${p.pnl_usd.toFixed(2)})` : "";

    let alertCl = "", alertHtml = "";
    if (p.alert === "VENDER YA") {
      alertCl  = "pos-card--alert-sl";
      alertHtml = `<div class="pos-card__alert alert--sl">🚨 ${p.alert} — precio cruzó SL</div>`;
    } else if (p.alert === "TOMAR GANANCIA") {
      alertCl  = "pos-card--alert-tp";
      alertHtml = `<div class="pos-card__alert alert--tp">💰 ${p.alert} — precio alcanzó TP</div>`;
    } else if (p.alert) {
      alertCl  = "pos-card--warn";
      alertHtml = `<div class="pos-card__alert alert--warn">⚠ ${p.alert}</div>`;
    }

    const cur = p.current_price != null ? `$${p.current_price.toFixed(2)}` : "—";
    const slDist = p.dist_sl_pct != null ? `${fmt_pct(p.dist_sl_pct)} al SL` : "—";
    const tpDist = p.dist_tp_pct != null ? `${fmt_pct(p.dist_tp_pct)} al TP` : "—";

    html += `
      <div class="pos-card ${alertCl}" id="pos-${p.ticker}">
        <div class="pos-card__row1">
          <span class="pos-card__ticker">${p.ticker}</span>
          <span class="pos-card__pnl ${pnlCl}">${pnlTxt}${pnlUsd}</span>
        </div>
        <div class="pos-card__grid">
          <div class="pos-card__cell">Precio actual<br><span>${cur}</span></div>
          <div class="pos-card__cell">Entry<br><span>$${p.entry_price.toFixed(2)}</span></div>
          <div class="pos-card__cell">Días<br><span>${p.days_open}d / ${p.horizon_days}d</span></div>
          <div class="pos-card__cell">SL: $${p.stop_loss.toFixed(2)}<br><span style="color:var(--red)">${slDist}</span></div>
          <div class="pos-card__cell">TP: $${p.take_profit.toFixed(2)}<br><span style="color:var(--green)">${tpDist}</span></div>
          <div class="pos-card__cell">Valor<br><span>${p.market_value != null ? "$" + p.market_value.toFixed(2) : "—"}</span></div>
        </div>
        ${alertHtml}
      </div>`;
  });

  container.innerHTML = html;
}

// ── Scores table ────────────────────────────────────────────────────────
function renderScores() {
  const tbody = document.getElementById("scores-tbody");
  if (!tbody) return;

  let data = [..._scores];

  // Filter
  if (_filterText) {
    const q = _filterText.toUpperCase();
    data = data.filter(s => s.ticker.includes(q));
  }
  if (_filterVerdict) {
    data = data.filter(s => s.verdict === _filterVerdict);
  }

  // Sort
  data.sort((a, b) => {
    let va = a[_sortCol], vb = b[_sortCol];
    if (va == null) va = _sortDir === -1 ? -Infinity : Infinity;
    if (vb == null) vb = _sortDir === -1 ? -Infinity : Infinity;
    if (typeof va === "string") return _sortDir * va.localeCompare(vb);
    return _sortDir * (vb - va);
  });

  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty-msg">Sin resultados.</td></tr>`;
    return;
  }

  let html = "";
  data.forEach(s => {
    const scoreVal = s.score ?? 0;
    const scoreCl  = scoreVal >= 0.6 ? "score--high" : scoreVal >= 0.4 ? "score--mid" : "score--low";

    const pUpTxt   = s.p_up   != null ? (s.p_up   * 100).toFixed(0) + "%" : "—";
    const pDownTxt = s.p_down != null ? (s.p_down * 100).toFixed(0) + "%" : "—";
    const retTxt   = s.expected_return != null ? fmt_pct(s.expected_return) : "—";
    const rsiTxt   = s.rsi  != null ? s.rsi.toFixed(0) : "—";
    const rsiColor = s.rsi  != null ? (s.rsi > 70 ? "color:var(--red)" : s.rsi < 30 ? "color:var(--green)" : "") : "";
    const price    = s.last_price != null ? `$${s.last_price.toFixed(2)}` : "—";

    // Intra badge
    let intraBadge = `<span class="intra-badge intra-badge--none">—</span>`;
    if (s.intra_signal) {
      const map = { ALCISTA: ["bull", "ALC"], BAJISTA: ["bear", "BAJ"], NEUTRO: ["neut", "NEU"] };
      const [cl, lbl] = map[s.intra_signal] || ["neut", s.intra_signal.slice(0,3)];
      intraBadge = `<span class="intra-badge intra-badge--${cl}">${lbl}</span>`;
    }

    // VWAP dist
    const vwapTxt = s.vwap_dist != null ? fmt_pct(s.vwap_dist) : "—";
    const vwapCl  = s.vwap_dist != null ? (s.vwap_dist >= 0 ? "pct--pos" : "pct--neg") : "pct--zero";

    // Verdict tag
    const vc = verdictClass(s.verdict);
    const vtag = `<span class="verdict-tag verdict-tag--${vc}">${s.verdict}</span>`;

    html += `<tr>
      <td class="col-ticker">${s.ticker}</td>
      <td>${price}</td>
      <td class="col-score ${scoreCl}">${scoreVal.toFixed(3)}</td>
      <td class="col-pup">${pUpTxt}</td>
      <td class="col-pdown">${pDownTxt}</td>
      <td class="${s.expected_return >= 0 ? "pct--pos" : "pct--neg"}">${retTxt}</td>
      <td style="${rsiColor}">${rsiTxt}</td>
      <td>${intraBadge}</td>
      <td class="${vwapCl}">${vwapTxt}</td>
      <td>${vtag}</td>
    </tr>`;
  });

  tbody.innerHTML = html;
}

// ── Helpers ─────────────────────────────────────────────────────────────
function fmt_pct(v) {
  if (v == null) return "—";
  const sign = v >= 0 ? "+" : "";
  return `<span class="${v >= 0 ? "pct--pos" : "pct--neg"}">${sign}${v.toFixed(2)}%</span>`;
}

// ── Sorting ──────────────────────────────────────────────────────────────
document.querySelectorAll(".sortable").forEach(th => {
  th.addEventListener("click", () => {
    const col = th.dataset.col;
    if (_sortCol === col) {
      _sortDir *= -1;
    } else {
      _sortCol = col;
      _sortDir = -1;
    }
    document.querySelectorAll(".sortable").forEach(h => h.classList.remove("sorted-asc", "sorted-desc"));
    th.classList.add(_sortDir === -1 ? "sorted-desc" : "sorted-asc");
    renderScores();
  });
});

// ── Filtering ────────────────────────────────────────────────────────────
document.getElementById("filter-input")?.addEventListener("input", e => {
  _filterText = e.target.value.trim();
  renderScores();
});
document.getElementById("filter-verdict")?.addEventListener("change", e => {
  _filterVerdict = e.target.value;
  renderScores();
});

// ── Init ────────────────────────────────────────────────────────────────
// Default sort indicator
document.querySelector(`th[data-col="score"]`)?.classList.add("sorted-desc");

connect();
