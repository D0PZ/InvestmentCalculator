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

from dataclasses import dataclass
from datetime import datetime

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import requests

# =============================================================================
# CONFIGURACIÓN
# =============================================================================

YEARS = 50
INITIAL_CAPITAL_CLP = 310_000  # ~330 USD iniciales

# INGRESOS (CLP)
MONTHLY_SALARY_CLP = 1_500_000      # sueldo inicial mensual
SALARY_GROWTH = 0.03                # crecimiento anual del sueldo
SAVINGS_RATE = 0.30                 # % del sueldo destinado a inversión

# INVERSIÓN (rentabilidad anual)
ANNUAL_RETURN_REALISTIC = 0.25
ANNUAL_RETURN_OPTIMISTIC = 0.40

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


def simulate(
    annual_return: float,
    years: int = YEARS,
    initial_capital: float = INITIAL_CAPITAL_CLP,
    monthly_salary: float = MONTHLY_SALARY_CLP,
    salary_growth: float = SALARY_GROWTH,
    savings_rate: float = SAVINGS_RATE,
    monthly_subscription: float = MONTHLY_SUBSCRIPTION_CLP,
    inflation: float = INFLATION,
) -> SimulationResult:
    """Simula la evolución mes a mes del capital invertido."""
    months = years * 12
    monthly_return = (1 + annual_return) ** (1 / 12) - 1
    monthly_inflation = (1 + inflation) ** (1 / 12) - 1

    capital = float(initial_capital)
    salary = float(monthly_salary)
    total_contrib = 0.0

    capital_hist = np.empty(months, dtype=np.float64)
    contrib_hist = np.empty(months, dtype=np.float64)

    for month in range(months):
        # Ajuste anual de sueldo (al inicio de cada año salvo el primero)
        if month > 0 and month % 12 == 0:
            salary *= (1 + salary_growth)

        # Aporte mensual
        monthly_investment = salary * savings_rate
        capital += monthly_investment
        total_contrib += monthly_investment

        # Rentabilidad
        capital *= (1 + monthly_return)

        # Suscripción mensual
        capital -= monthly_subscription

        # Ajuste por inflación (capital en términos reales)
        capital /= (1 + monthly_inflation)

        capital_hist[month] = capital
        contrib_hist[month] = total_contrib

    return SimulationResult(capital=capital_hist, contributions=contrib_hist)


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

    realistic = simulate(ANNUAL_RETURN_REALISTIC)
    optimistic = simulate(ANNUAL_RETURN_OPTIMISTIC)

    months = YEARS * 12
    df = pd.DataFrame({
        "Mes": np.arange(1, months + 1),
        "Año": np.arange(1, months + 1) / 12,
        "Realista (25%) CLP": realistic.capital,
        "Optimista (40%) CLP": optimistic.capital,
        "Aportes acumulados CLP": realistic.contributions,
    })
    df["Realista (25%) USD"] = df["Realista (25%) CLP"] / usd_clp
    df["Optimista (40%) USD"] = df["Optimista (40%) CLP"] / usd_clp

    # ---------- Resumen en consola ----------
    final_real_clp = realistic.capital[-1]
    final_opt_clp = optimistic.capital[-1]
    final_contrib = realistic.contributions[-1]

    print("=" * 60)
    print(f"Proyección de Inversión a {YEARS} años")
    print(f"Tipo de cambio: 1 USD = {usd_clp:,.2f} CLP  (fecha: {fx_date})")
    print("-" * 60)
    print(f"Capital inicial:        {fmt_clp(INITIAL_CAPITAL_CLP)}  "
          f"({fmt_usd(INITIAL_CAPITAL_CLP / usd_clp)})")
    print(f"Sueldo inicial:         {fmt_clp(MONTHLY_SALARY_CLP)}/mes  "
          f"({fmt_usd(MONTHLY_SALARY_CLP / usd_clp)}/mes)")
    print(f"Tasa de ahorro:         {SAVINGS_RATE * 100:.0f}%")
    print(f"Aportes acumulados:     {fmt_clp(final_contrib)}  "
          f"({fmt_usd(final_contrib / usd_clp)})")
    print("-" * 60)
    print(f"Final realista (25%):   {fmt_clp(final_real_clp)}  "
          f"({fmt_usd(final_real_clp / usd_clp)})")
    print(f"Final optimista (40%):  {fmt_clp(final_opt_clp)}  "
          f"({fmt_usd(final_opt_clp / usd_clp)})")
    print("=" * 60)

    # ---------- Gráfico ----------
    hover_real = [
        f"Año {a:.1f}<br>{fmt_clp(c)}<br>{fmt_usd(c / usd_clp)}"
        for a, c in zip(df["Año"], df["Realista (25%) CLP"])
    ]
    hover_opt = [
        f"Año {a:.1f}<br>{fmt_clp(c)}<br>{fmt_usd(c / usd_clp)}"
        for a, c in zip(df["Año"], df["Optimista (40%) CLP"])
    ]
    hover_contrib = [
        f"Año {a:.1f}<br>{fmt_clp(c)}<br>{fmt_usd(c / usd_clp)}"
        for a, c in zip(df["Año"], df["Aportes acumulados CLP"])
    ]

    fig = go.Figure()
    fig.add_trace(go.Scatter(
        x=df["Año"], y=df["Aportes acumulados CLP"],
        mode="lines", name="Aportes acumulados",
        line=dict(dash="dot", color="#888"),
        hovertext=hover_contrib, hoverinfo="text",
    ))
    fig.add_trace(go.Scatter(
        x=df["Año"], y=df["Realista (25%) CLP"],
        mode="lines", name="Escenario Realista (25%)",
        hovertext=hover_real, hoverinfo="text",
    ))
    fig.add_trace(go.Scatter(
        x=df["Año"], y=df["Optimista (40%) CLP"],
        mode="lines", name="Escenario Optimista (40%)",
        hovertext=hover_opt, hoverinfo="text",
    ))

    fig.update_layout(
        title=(f"Proyección de Inversión a {YEARS} Años (CLP)<br>"
               f"<sub>1 USD = {usd_clp:,.2f} CLP — {fx_date}</sub>"),
        xaxis_title="Años",
        yaxis_title="Capital (CLP)",
        template="plotly_dark",
        hovermode="x unified",
        dragmode="zoom",
        legend=dict(orientation="h", yanchor="bottom", y=1.02,
                    xanchor="right", x=1),
    )
    fig.update_yaxes(tickformat=",.0f", separatethousands=True)

    fig.show()


if __name__ == "__main__":
    main()
