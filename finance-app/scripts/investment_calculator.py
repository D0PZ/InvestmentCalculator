"""
Calculadora de Inversión a Largo Plazo (CLP)
============================================

Simula el crecimiento de capital invertido durante N años, con aportes
mensuales basados en un % del sueldo, rentabilidad anual compuesta,
suscripción mensual de plataforma e inflación.

Todos los valores monetarios están en CLP. El resultado final se muestra
también en USD usando el tipo de cambio actual obtenido desde mindicador.cl
(Banco Central de Chile). Si no hay conexión, se usa un valor de respaldo.

Instalación:
    pip install plotly pandas numpy requests
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

import numpy as np
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import requests

MESES_ES = [
    "Ene", "Feb", "Mar", "Abr", "May", "Jun",
    "Jul", "Ago", "Sep", "Oct", "Nov", "Dic",
]


def fmt_fecha(ts: pd.Timestamp) -> str:
    return f"{MESES_ES[ts.month - 1]} {ts.year}"

# =============================================================================
# CONFIGURACIÓN
# =============================================================================

YEARS = 1
INITIAL_CAPITAL_CLP = 0  # parte desde cero

# INGRESOS (CLP)
# Sin capital inicial y sin aportes (no hay plata para tradear)
MONTHLY_SALARY_CLP = 15_000
SALARY_GROWTH = 0.00
SAVINGS_RATE = 1.00

# =============================================================================
# MODELO DE TRADING SEMANAL
# =============================================================================
# Asumimos 1 trade por semana (~4 por mes). Cada escenario define:
#   - win_rate: probabilidad de cerrar el trade en ganancia
#   - tp:       take-profit (ganancia por trade)
#   - sl:       stop-loss   (pérdida por trade)
# El retorno mensual esperado se calcula como:
#   E[r_trade] = win_rate * tp + (1 - win_rate) * sl
#   r_mensual  = (1 + E[r_trade]) ** 4 - 1
#   r_anual    = (1 + r_mensual) ** 12 - 1

TRADES_POR_MES = 4   # 1 trade / semana

def _annual_from_trade(win_rate: float, tp: float, sl: float) -> float:
    expected = win_rate * tp + (1 - win_rate) * sl
    return (1 + expected) ** (TRADES_POR_MES * 12) - 1

# ESCENARIOS (trading activo semanal)
#   Realista: trader real, 55% win rate, RR 1.5:1 (+15% / -10%)
#   Optimista: muy buen año, 65% win rate, RR 1.5:1
#   Pro: élite, 70% win rate, RR 1.5:1
ANNUAL_RETURN_REALISTIC  = _annual_from_trade(win_rate=0.55, tp=0.15, sl=-0.10)
ANNUAL_RETURN_OPTIMISTIC = _annual_from_trade(win_rate=0.65, tp=0.15, sl=-0.10)
ANNUAL_RETURN_ULTRA      = _annual_from_trade(win_rate=0.70, tp=0.15, sl=-0.10)

# VOLATILIDAD (trading activo = mucho más alta que buy-and-hold)
ANNUAL_VOLATILITY = 0.60

# MONTE CARLO
MC_SIMULATIONS = 500
MC_BASE_RETURN = ANNUAL_RETURN_REALISTIC
MC_SEED = 42

# Sin crisis para horizonte tan corto (1 año)
CRISIS_EVENTS: list[tuple[int, float, int]] = []

# COSTOS
MONTHLY_SUBSCRIPTION_CLP = 66_000 / 12  # plan anual de 66.000 CLP

# MACRO
INFLATION = 0.02  # inflación anual estimada

# Tipo de cambio de respaldo si falla la API
FALLBACK_USD_CLP = 950.0


# =============================================================================
# TIPO DE CAMBIO
# =============================================================================

def get_usd_clp() -> tuple[float, str]:
    """Obtiene el valor del dólar observado actual en CLP.

    Returns:
        (valor_clp_por_usd, fecha_iso)
    """
    try:
        r = requests.get("https://mindicador.cl/api/dolar", timeout=5)
        r.raise_for_status()
        data = r.json()
        serie = data["serie"][0]
        return float(serie["valor"]), str(serie["fecha"])[:10]
    except Exception as exc:  # noqa: BLE001
        print(f"[aviso] No se pudo obtener tipo de cambio ({exc}). "
              f"Usando valor de respaldo {FALLBACK_USD_CLP} CLP/USD.")
        return FALLBACK_USD_CLP, datetime.now().strftime("%Y-%m-%d") + " (fallback)"


# =============================================================================
# SIMULACIÓN
# =============================================================================

@dataclass
class SimulationResult:
    capital: np.ndarray         # capital al final de cada mes (CLP, real)
    contributions: np.ndarray   # aportes acumulados (CLP, nominal)


def compute_drawdown(capital: np.ndarray) -> np.ndarray:
    """Drawdown porcentual respecto al máximo histórico (peak-to-trough)."""
    peak = np.maximum.accumulate(capital)
    return (capital - peak) / peak  # valores <= 0


def simulate(
    annual_return: float,
    years: int = YEARS,
    initial_capital: float = INITIAL_CAPITAL_CLP,
    monthly_salary: float = MONTHLY_SALARY_CLP,
    salary_growth: float = SALARY_GROWTH,
    savings_rate: float = SAVINGS_RATE,
    monthly_subscription: float = MONTHLY_SUBSCRIPTION_CLP,
    inflation: float = INFLATION,
    volatility: float = 0.0,
    crisis_events: list[tuple[int, float, int]] | None = None,
    rng: np.random.Generator | None = None,
) -> SimulationResult:
    """Simula la evolución mes a mes del capital.

    Args:
        annual_return: rentabilidad anual esperada (media).
        volatility: desv. est. anual de los retornos. 0 = determinista.
        crisis_events: lista de (mes, shock_pct, meses_pausa_aporte).
        rng: generador de aleatorios (para reproducibilidad / MC).
    """
    months = years * 12
    monthly_return = (1 + annual_return) ** (1 / 12) - 1
    monthly_inflation = (1 + inflation) ** (1 / 12) - 1
    monthly_vol = volatility / np.sqrt(12)

    if rng is None:
        rng = np.random.default_rng()

    # Mapa rapido mes -> evento
    events = {m: (shock, pause) for m, shock, pause in (crisis_events or [])}
    pause_remaining = 0

    capital = float(initial_capital)
    salary = float(monthly_salary)
    total_contrib = 0.0

    capital_hist = np.empty(months, dtype=np.float64)
    contrib_hist = np.empty(months, dtype=np.float64)

    for month in range(months):
        # Ajuste anual de sueldo
        if month > 0 and month % 12 == 0:
            salary *= (1 + salary_growth)

        # Aporte mensual (a menos que estemos en pausa post-crisis)
        if pause_remaining > 0:
            monthly_investment = 0.0
            pause_remaining -= 1
        else:
            monthly_investment = salary * savings_rate
        capital += monthly_investment
        total_contrib += monthly_investment

        # Evento de crisis: shock instantáneo ANTES del retorno del mes
        # (la crisis golpea el capital existente; el retorno luego se aplica
        # sobre el capital ya golpeado)
        if month in events:
            shock, pause = events[month]
            capital *= (1 + shock)
            pause_remaining = pause

        # Rentabilidad (estocástica si hay volatilidad)
        if monthly_vol > 0:
            r = rng.normal(monthly_return, monthly_vol)
        else:
            r = monthly_return
        capital *= (1 + r)

        # Suscripción mensual (solo si hay capital suficiente)
        if capital > monthly_subscription:
            capital -= monthly_subscription
        else:
            capital = 0.0

        # Ajuste por inflación (capital en términos reales)
        capital /= (1 + monthly_inflation)

        capital_hist[month] = capital
        contrib_hist[month] = total_contrib

    return SimulationResult(capital=capital_hist, contributions=contrib_hist)


def monte_carlo(
    annual_return: float = MC_BASE_RETURN,
    volatility: float = ANNUAL_VOLATILITY,
    n_sims: int = MC_SIMULATIONS,
    seed: int | None = MC_SEED,
    crisis_events: list[tuple[int, float, int]] | None = None,
) -> dict[str, np.ndarray]:
    """Ejecuta N simulaciones estocásticas independientes.

    Cada trayectoria usa su propio Generator (seed + i) para garantizar
    independencia estadística entre simulaciones.
    """
    months = YEARS * 12
    runs = np.empty((n_sims, months), dtype=np.float64)
    for i in range(n_sims):
        sub_seed = (seed + i) if seed is not None else None
        sim = simulate(
            annual_return=annual_return,
            volatility=volatility,
            crisis_events=crisis_events,
            rng=np.random.default_rng(sub_seed),
        )
        runs[i] = sim.capital
    return {
        "p10": np.percentile(runs, 10, axis=0),
        "p50": np.percentile(runs, 50, axis=0),
        "p90": np.percentile(runs, 90, axis=0),
        "mean": runs.mean(axis=0),
        "runs": runs,
    }


def cagr(final_value: float, initial_value: float, years: float) -> float:
    """Compound Annual Growth Rate. Devuelve 0 si los datos no son válidos."""
    if initial_value <= 0 or final_value <= 0 or years <= 0:
        return 0.0
    return (final_value / initial_value) ** (1 / years) - 1


# =============================================================================
# FORMATO
# =============================================================================

def fmt_clp(v: float) -> str:
    return f"${v:,.0f} CLP".replace(",", ".")


def fmt_usd(v: float) -> str:
    return f"US${v:,.0f}"


# =============================================================================
# MAIN
# =============================================================================

def main() -> None:
    usd_clp, fx_date = get_usd_clp()

    # Escenarios deterministas (sin volatilidad)
    realistic = simulate(ANNUAL_RETURN_REALISTIC)
    optimistic = simulate(ANNUAL_RETURN_OPTIMISTIC)
    ultra = simulate(ANNUAL_RETURN_ULTRA)

    # Escenario "vida real": volatilidad + crisis + pausa de aporte
    real_life = simulate(
        ANNUAL_RETURN_REALISTIC,
        volatility=ANNUAL_VOLATILITY,
        crisis_events=CRISIS_EVENTS,
        rng=np.random.default_rng(MC_SEED),
    )

    # Monte Carlo (P10 / P50 / P90)
    mc = monte_carlo(crisis_events=CRISIS_EVENTS)

    months = YEARS * 12
    start = pd.Timestamp.today().normalize().replace(day=1)
    fechas = pd.date_range(start=start, periods=months, freq="MS")
    df = pd.DataFrame({
        "Fecha": fechas,
        "Realista (25%) CLP": realistic.capital,
        "Optimista (40%) CLP": optimistic.capital,
        "Pro (30%) CLP": ultra.capital,
        "Vida real CLP": real_life.capital,
        "MC P10 CLP": mc["p10"],
        "MC P50 CLP": mc["p50"],
        "MC P90 CLP": mc["p90"],
        "Aportes acumulados CLP": realistic.contributions,
    })
    # Ganancia neta (mercado) = capital - aportes acumulados
    df["Ganancia realista CLP"] = (
        df["Realista (25%) CLP"] - df["Aportes acumulados CLP"]
    )

    # Drawdowns (sobre el escenario "vida real" y el realista determinista)
    dd_real_life = compute_drawdown(real_life.capital) * 100  # %
    dd_realistic = compute_drawdown(realistic.capital) * 100

    # ---------- Resumen en consola ----------
    final_real_clp = realistic.capital[-1]
    final_opt_clp = optimistic.capital[-1]
    final_ultra_clp = ultra.capital[-1]
    final_life_clp = real_life.capital[-1]
    final_contrib = realistic.contributions[-1]
    max_dd_life = dd_real_life.min()

    # CAGR sobre el dinero efectivamente invertido (capital inicial + aportes)
    invested = INITIAL_CAPITAL_CLP + final_contrib
    cagr_real = cagr(final_real_clp, invested, YEARS) * 100
    cagr_opt = cagr(final_opt_clp, invested, YEARS) * 100
    cagr_pro = cagr(final_ultra_clp, invested, YEARS) * 100
    cagr_life = cagr(final_life_clp, invested, YEARS) * 100
    cagr_mc50 = cagr(mc["p50"][-1], invested, YEARS) * 100

    print("=" * 64)
    print(f"Proyección de Inversión a {YEARS} años")
    print(f"Tipo de cambio: 1 USD = {usd_clp:,.2f} CLP  (fecha: {fx_date})")
    print(f"Volatilidad anual: {ANNUAL_VOLATILITY * 100:.0f}%   "
          f"Monte Carlo: {MC_SIMULATIONS} simulaciones")
    print("-" * 64)
    print("Modelo trading semanal: 1 trade/sem (4/mes), TP +15% / SL -10%")
    print(f"  Realista  (win 55%):  retorno anual teórico "
          f"{ANNUAL_RETURN_REALISTIC * 100:>8.1f}%")
    print(f"  Optimista (win 65%):  retorno anual teórico "
          f"{ANNUAL_RETURN_OPTIMISTIC * 100:>8.1f}%")
    print(f"  Pro       (win 70%):  retorno anual teórico "
          f"{ANNUAL_RETURN_ULTRA * 100:>8.1f}%")
    print("-" * 64)
    print(f"Capital inicial:        {fmt_clp(INITIAL_CAPITAL_CLP)}  "
          f"({fmt_usd(INITIAL_CAPITAL_CLP / usd_clp)})")
    print(f"Sueldo inicial:         {fmt_clp(MONTHLY_SALARY_CLP)}/mes  "
          f"({fmt_usd(MONTHLY_SALARY_CLP / usd_clp)}/mes)")
    print(f"Tasa de ahorro:         {SAVINGS_RATE * 100:.0f}%")
    print(f"Aportes acumulados:     {fmt_clp(final_contrib)}  "
          f"({fmt_usd(final_contrib / usd_clp)})")
    print(f"Total invertido:        {fmt_clp(invested)}  "
          f"({fmt_usd(invested / usd_clp)})")
    print("-" * 64)
    print(f"{'Escenario':<22}{'Final CLP':>20}  {'CAGR real':>10}")
    print(f"{'Realista (25%)':<22}{fmt_clp(final_real_clp):>20}  "
          f"{cagr_real:>9.2f}%")
    print(f"{'Optimista (40%)':<22}{fmt_clp(final_opt_clp):>20}  "
          f"{cagr_opt:>9.2f}%")
    print(f"{'Pro (30%)':<22}{fmt_clp(final_ultra_clp):>20}  "
          f"{cagr_pro:>9.2f}%")
    print(f"{'Vida real 🌊':<22}{fmt_clp(final_life_clp):>20}  "
          f"{cagr_life:>9.2f}%")
    print(f"  Drawdown máximo vida real: {max_dd_life:.1f}%")
    print("-" * 64)
    print("Monte Carlo (final):")
    print(f"  P10 (pesimista):      {fmt_clp(mc['p10'][-1])}  "
          f"({fmt_usd(mc['p10'][-1] / usd_clp)})")
    print(f"  P50 (mediana):        {fmt_clp(mc['p50'][-1])}  "
          f"({fmt_usd(mc['p50'][-1] / usd_clp)})  "
          f"CAGR {cagr_mc50:.2f}%")
    print(f"  P90 (optimista):      {fmt_clp(mc['p90'][-1])}  "
          f"({fmt_usd(mc['p90'][-1] / usd_clp)})")
    print("=" * 64)

    # ---------- Gráfico ----------
    fechas_str = [fmt_fecha(f) for f in df["Fecha"]]

    def hover(serie: np.ndarray) -> list[str]:
        return [
            f"{f}<br>{fmt_clp(c)}<br>{fmt_usd(c / usd_clp)}"
            for f, c in zip(fechas_str, serie)
        ]

    fig = make_subplots(
        rows=2, cols=1, shared_xaxes=True,
        row_heights=[0.72, 0.28], vertical_spacing=0.06,
        subplot_titles=("Capital (CLP, ajustado por inflación)",
                        "Drawdown (%) — caída desde máximo histórico"),
    )

    # ----- Banda Monte Carlo P10-P90 -----
    fig.add_trace(go.Scatter(
        x=df["Fecha"], y=df["MC P90 CLP"],
        mode="lines", name="MC P90",
        line=dict(width=0), showlegend=False,
        hoverinfo="skip",
    ), row=1, col=1)
    fig.add_trace(go.Scatter(
        x=df["Fecha"], y=df["MC P10 CLP"],
        mode="lines", name="Monte Carlo P10–P90",
        line=dict(width=0),
        fill="tonexty", fillcolor="rgba(100,150,255,0.18)",
        hoverinfo="skip",
    ), row=1, col=1)
    fig.add_trace(go.Scatter(
        x=df["Fecha"], y=df["MC P50 CLP"],
        mode="lines", name="Monte Carlo mediana (P50)",
        line=dict(width=2, color="#6495ff", dash="dash"),
        hovertext=hover(df["MC P50 CLP"]), hoverinfo="text",
    ), row=1, col=1)

    # ----- Series deterministas -----
    fig.add_trace(go.Scatter(
        x=df["Fecha"], y=df["Aportes acumulados CLP"],
        mode="lines+markers", name="Aportes acumulados",
        line=dict(dash="dot", color="#888", width=1.5),
        marker=dict(size=4, symbol="circle", color="#888",
                    line=dict(width=1, color="#1e1e1e")),
        hovertext=hover(df["Aportes acumulados CLP"]), hoverinfo="text",
    ), row=1, col=1)
    fig.add_trace(go.Scatter(
        x=df["Fecha"], y=df["Ganancia realista CLP"],
        mode="lines", name="Ganancia neta (mercado, realista)",
        line=dict(width=1.5, color="#4caf50", dash="dashdot"),
        hovertext=hover(df["Ganancia realista CLP"]), hoverinfo="text",
        visible="legendonly",
    ), row=1, col=1)
    fig.add_trace(go.Scatter(
        x=df["Fecha"], y=df["Realista (25%) CLP"],
        mode="lines+markers", name="Realista (25%)",
        line=dict(width=2),
        marker=dict(size=5, symbol="circle",
                    line=dict(width=1, color="#1e1e1e")),
        hovertext=hover(df["Realista (25%) CLP"]), hoverinfo="text",
    ), row=1, col=1)
    fig.add_trace(go.Scatter(
        x=df["Fecha"], y=df["Optimista (40%) CLP"],
        mode="lines+markers", name="Optimista (40%)",
        line=dict(width=2),
        marker=dict(size=5, symbol="diamond",
                    line=dict(width=1, color="#1e1e1e")),
        hovertext=hover(df["Optimista (40%) CLP"]), hoverinfo="text",
    ), row=1, col=1)
    fig.add_trace(go.Scatter(
        x=df["Fecha"], y=df["Pro (30%) CLP"],
        mode="lines+markers", name="Pro (30%) ⭐",
        line=dict(width=2, color="#ffd700"),
        marker=dict(size=6, symbol="star", color="#ffd700",
                    line=dict(width=1, color="#1e1e1e")),
        hovertext=hover(df["Pro (30%) CLP"]), hoverinfo="text",
    ), row=1, col=1)
    fig.add_trace(go.Scatter(
        x=df["Fecha"], y=df["Vida real CLP"],
        mode="lines+markers", name="Vida real 🌊 (vol+crisis)",
        line=dict(width=2, color="#ff6b6b"),
        marker=dict(size=4, symbol="x", color="#ff6b6b"),
        hovertext=hover(df["Vida real CLP"]), hoverinfo="text",
    ), row=1, col=1)

    # ----- Marcadores de eventos de crisis -----
    for m, shock, _ in CRISIS_EVENTS:
        if m < months:
            x_event = df["Fecha"].iloc[m].to_pydatetime()
            fig.add_shape(
                type="line", xref="x", yref="paper",
                x0=x_event, x1=x_event, y0=0.32, y1=1.0,
                line=dict(color="rgba(255,107,107,0.5)",
                          width=1, dash="dash"),
            )
            fig.add_annotation(
                x=x_event, y=1.0, xref="x", yref="paper",
                text=f"{shock * 100:+.0f}%",
                showarrow=False, yanchor="bottom",
                font=dict(color="#ff6b6b", size=11),
            )

    # ----- Drawdown subplot -----
    fig.add_trace(go.Scatter(
        x=df["Fecha"], y=dd_realistic,
        mode="lines", name="Drawdown realista",
        line=dict(color="#9aa0a6", width=1.5, dash="dot"),
        fill="tozeroy", fillcolor="rgba(154,160,166,0.10)",
        hovertemplate="%{x|%b %Y}<br>%{y:.2f}%<extra>Realista</extra>",
    ), row=2, col=1)
    fig.add_trace(go.Scatter(
        x=df["Fecha"], y=dd_real_life,
        mode="lines", name="Drawdown vida real",
        line=dict(color="#ff6b6b", width=2),
        fill="tozeroy", fillcolor="rgba(255,107,107,0.18)",
        hovertemplate="%{x|%b %Y}<br>%{y:.2f}%<extra>Vida real</extra>",
    ), row=2, col=1)

    fig.update_layout(
        title=(f"Proyección de Inversión a {YEARS} Años (CLP)<br>"
               f"<sub>1 USD = {usd_clp:,.2f} CLP — {fx_date} · "
               f"vol {ANNUAL_VOLATILITY * 100:.0f}% · "
               f"{MC_SIMULATIONS} simulaciones MC</sub>"),
        template="plotly_dark",
        hovermode="x unified",
        dragmode="zoom",
        height=820,
        legend=dict(orientation="h", yanchor="bottom", y=1.04,
                    xanchor="right", x=1),
        updatemenus=[dict(
            type="buttons", direction="left",
            x=0.0, y=1.12, xanchor="left", yanchor="top",
            bgcolor="#222", bordercolor="#444",
            font=dict(color="#eee", size=11),
            buttons=[
                dict(label="Lineal", method="relayout",
                     args=[{"yaxis.type": "linear",
                            "yaxis.tickmode": "auto",
                            "yaxis.nticks": 12}]),
                dict(label="Log", method="relayout",
                     args=[{"yaxis.type": "log",
                            "yaxis.tickmode": "auto",
                            "yaxis.nticks": 8}]),
            ],
        )],
    )

    # ---- Calcular paso "redondo" para el eje Y lineal (5M, 10M, 25M…) ----
    y_max = max(
        df["MC P90 CLP"].max(),
        df["Optimista (40%) CLP"].max(),
        df["Pro (30%) CLP"].max(),
    )
    # Buscar un step que dé ~10 ticks y sea múltiplo de 1·2·5 · 10^k
    rough = y_max / 10
    magnitude = 10 ** np.floor(np.log10(rough))
    for mult in (1, 2, 2.5, 5, 10):
        step = mult * magnitude
        if step >= rough:
            break

    # Eje X compartido: ticks anuales + minor mensual (en AMBOS subplots)
    x_kwargs = dict(
        type="date", dtick="M12", tickformat="%Y",
        ticklabelmode="period",
        showgrid=True, gridcolor="rgba(255,255,255,0.18)",
        minor=dict(dtick="M1", showgrid=True,
                   gridcolor="rgba(255,255,255,0.06)", ticklen=4),
        rangeslider=dict(visible=False),
        showticklabels=True,
    )
    fig.update_xaxes(**x_kwargs, row=1, col=1)
    fig.update_xaxes(**x_kwargs, row=2, col=1)

    fig.update_yaxes(
        tickformat=",.0f", separatethousands=True,
        title_text="Capital (CLP)",
        tick0=0, dtick=step,                # paso fijo redondo
        showgrid=True, gridcolor="rgba(255,255,255,0.18)",
        row=1, col=1,
    )
    fig.update_yaxes(ticksuffix="%", title_text="Drawdown",
                     rangemode="tozero", row=2, col=1)

    fig.show()


if __name__ == "__main__":
    main()
