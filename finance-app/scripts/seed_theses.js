/**
 * Siembra tesis de inversión (type='thesis') en la tabla catalysts, una por ticker del
 * watchlist. El Catalyst Radar las muestra (tooltip 💡). Editable: re-correr actualiza
 * (INSERT OR REPLACE por dedupe_key THESIS:<ticker>).
 *
 * Tesis ancladas en datos reales del radar (earnings, consenso, acciones de analistas a
 * jun-2026) + criterio. NO es asesoría financiera. Las tesis envejecen — actualízalas.
 *
 * Uso: node scripts/seed_theses.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('../lib/db');

// stance: bullish | neutral | bearish (lean propio, no el consenso)
const THESES = [
  { t: 'ACN', stance: 'neutral', thesis: 'Consultora IT de calidad bajo presión: ciclo de gasto empresarial débil y la IA canibaliza horas de servicios.',
    catalyst: 'Earnings 18-jun (¡14d!). Goldman, Stifel y Wells Fargo recortaron PT justo antes — expectativas moderándose.', risk: 'Guía floja de bookings/IA. Es tu posición: el agente entra en earnings-blackout cerca de la fecha.' },
  { t: 'MU', stance: 'bullish', thesis: 'Ciclo de memoria al alza por IA; HBM3E para GPUs es el driver de márgenes.',
    catalyst: 'Earnings 24-jun. Morgan Stanley subió PT (Overweight). Consenso fuerte (SB18/B33).', risk: 'Memoria es brutalmente cíclica; señal de oversupply pega duro.' },
  { t: 'TSM', stance: 'bullish', thesis: 'El fundidor irreemplazable de la era IA (fabrica para NVDA/AMD/AAPL); pricing power en nodos avanzados.',
    catalyst: 'Earnings 15-jul. Bernstein lo llama el AI play "más confiable".', risk: 'Geopolítico (Taiwán/China) — el descuento permanente de valuación.' },
  { t: 'NOW', stance: 'bullish', thesis: 'Plataforma de workflow empresarial montando la ola de IA agentic; net retention alto.',
    catalyst: 'Earnings 21-jul. Oppenheimer Outperform, BofA "AI workflow recovery bet".', risk: 'Múltiplo premium vulnerable a cualquier desaceleración de software.' },
  { t: 'GOOGL', stance: 'bullish', thesis: 'Search + Cloud + Gemini; el mercado pasó del miedo "IA mata Search" a reconocer la fuerza de Gemini.',
    catalyst: 'Earnings 21-jul. Goldman + TD Cowen mantienen Buy. Consenso fuerte (score 80).', risk: 'Antitrust/regulatorio y capex de IA.' },
  { t: 'TSLA', stance: 'neutral', thesis: 'La acción más polarizada: tesis robotaxi/FSD/Optimus vs. fundamentales de auto débiles.',
    catalyst: 'Earnings 21-jul. Consenso genuinamente dividido (23 hold, 8 sell/strongsell).', risk: 'Ejecución de robotaxi + márgenes de autos + factor Musk.' },
  { t: 'INTC', stance: 'bearish', thesis: 'El turnaround más duro del grupo: foundry quema caja, 32 "hold" = muéstrame resultados.',
    catalyst: 'Earnings 22-jul. Consenso el más débil (score 17).', risk: 'Ejecución de 18A y market share vs AMD/TSM. Especulativo.' },
  { t: 'UNH', stance: 'bullish', thesis: 'Tras un 2025 castigado (costos médicos, ruido), el setup riesgo/recompensa luce atractivo a analistas.',
    catalyst: 'Earnings 27-jul. Cluster alcista 4-jun: Morgan Stanley sube PT, BofA sube a Buy.', risk: 'Tendencia de costos médicos (MLR) y ruido político/regulatorio.' },
  { t: 'V', stance: 'bullish', thesis: 'Peaje del pago global, márgenes extraordinarios, defensivo de calidad.',
    catalyst: 'Earnings 27-jul. Consenso bull (score 55).', risk: 'Regulación de interchange + competencia fintech/stablecoins. (Ratings detectados aquí traen ruido de Finnhub.)' },
  { t: 'MSFT', stance: 'bullish', thesis: 'El blue-chip de IA: Copilot + Azure OpenAI + capa de aplicación. Consenso casi unánime (SB23/B38).',
    catalyst: 'Earnings 28-jul. Score 84, de los más altos del grupo.', risk: 'Capex de IA gigante presiona márgenes; monetización de Copilot por probar. Es tu posición.' },
  { t: 'META', stance: 'bullish', thesis: 'Máquina de publicidad + eficiencia que financia apuestas de IA/Reality Labs.',
    catalyst: 'Earnings 28-jul. RBC Outperform $810, Wolfe "valuación atractiva".', risk: 'Gasto en IA/metaverso, regulación.' },
  { t: 'AMZN', stance: 'bullish', thesis: 'AWS reacelera con IA + retail/márgenes mejorando + publicidad. Consenso TOP del grupo (SB22/B49).',
    catalyst: 'Earnings 29-jul. Wolfe reafirma Outperform. Score 93.', risk: 'Capex, competencia cloud, salud del consumo.' },
  { t: 'AMD', stance: 'bullish', thesis: 'El retador #2 en GPUs de IA (MI300/MI400) detrás de NVDA; data center es el driver.',
    catalyst: 'Earnings 3-ago. Barclays y TD Cowen subieron PT (Overweight/Buy).', risk: 'Ejecución vs NVDA dominante; software (ROCm) atrás de CUDA.' },
  { t: 'PLTR', stance: 'neutral', thesis: 'AIP con crecimiento comercial US explosivo, pero valuación extrema (múltiplo de los más altos del mercado).',
    catalyst: 'Earnings 3-ago. Consenso tibio (score 35) — el debate es el precio, no el negocio.', risk: 'Valuación; cualquier desaceleración se castiga muy duro.' },
  { t: 'SHOP', stance: 'neutral', thesis: 'Infra de e-commerce con reaceleración de GMV; señales mixtas de analistas.',
    catalyst: 'Earnings 4-ago. Piper Sandler bull, pero Barclays + Citi recortaron PT tras Q1.', risk: 'Valuación + sensibilidad al consumo.' },
  { t: 'TTWO', stance: 'bullish', thesis: 'GTA 6 (19-nov-2026) es uno de los mayores lanzamientos de entretenimiento de la historia; ingreso recurrente reduce el fade post-lanzamiento.',
    catalyst: 'Earnings 5-ago. 3× iniciación Piper Sandler Overweight PT $280 (el evento que originó este análisis).', risk: 'Retraso de GTA 6 (historial de Rockstar) — el swing #1.' },
  { t: 'LLY', stance: 'bullish', thesis: 'Líder de GLP-1 (Zepbound/Mounjaro); el mercado de obesidad es secular y enorme.',
    catalyst: 'Earnings 5-ago. Wolfe se mantiene bullish.', risk: 'Competencia (Novo + orales nuevos), capacidad de producción, valuación premium.' },
  { t: 'NVDA', stance: 'bullish', thesis: 'El rey de la IA: Blackwell + foso CUDA. Consenso ultra-bull (SB24/B39).',
    catalyst: 'Earnings 25-ago (el más lejano — menos riesgo de evento cercano). Score 86.', risk: 'Concentración de demanda en hyperscalers, ASICs custom, cualquier air-pocket de capex.' },
  { t: 'CRWD', stance: 'bullish', thesis: 'Líder de ciberseguridad (Falcon) consolidando plataforma; recuperó confianza post-incidente 2024.',
    catalyst: 'Earnings 25-ago. Cluster de PT raises 4-jun (Morgan Stanley, Bernstein, Canaccord).', risk: 'Valuación premium + competencia (Palo Alto, SentinelOne).' },
  { t: 'COST', stance: 'bullish', thesis: 'Minorista de calidad por excelencia: membresías recurrentes, lealtad férrea, defensivo.',
    catalyst: 'TD Cowen Buy $1175, DA Davidson bull. (Finnhub no devolvió fecha de earnings — calendario fiscal propio.)', risk: 'Valuación rica para un retailer (múltiplo premium).' },
];

const SENT = { bullish: 'bullish', neutral: 'neutral', bearish: 'bearish' };
const today = new Date().toISOString().slice(0, 10);
const now = Date.now();

const stmt = db.prepare(
  `INSERT OR REPLACE INTO catalysts
     (ticker, type, event_date, headline, detail, sentiment, firm, source, url, payload_json, ts, dedupe_key)
   VALUES (?, 'thesis', ?, ?, ?, ?, NULL, 'claude', NULL, ?, ?, ?)`
);

let n = 0;
for (const x of THESES) {
  const detail = `Catalizador: ${x.catalyst} · Riesgo: ${x.risk}`;
  const payload = JSON.stringify({ stance: x.stance, key_catalyst: x.catalyst, main_risk: x.risk, authored: today });
  stmt.run(x.t, today, x.thesis, detail, SENT[x.stance] || 'neutral', payload, now, `THESIS:${x.t}`);
  n++;
}
console.log(`Sembradas ${n} tesis (type='thesis') en catalysts.`);
const cnt = db.prepare(`SELECT COUNT(*) AS n FROM catalysts WHERE type='thesis'`).get();
console.log(`Total thesis en DB: ${cnt.n}`);
