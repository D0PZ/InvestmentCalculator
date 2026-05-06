const YAHOO_QUOTE = 'https://query1.finance.yahoo.com/v7/finance/quote';

async function fetchQuotes(symbols) {
  if (!symbols || symbols.length === 0) return {};
  const url = `${YAHOO_QUOTE}?symbols=${encodeURIComponent(symbols.join(','))}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (finance-app)',
      'Accept': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Yahoo quote ${res.status}: ${res.statusText}`);
  const data = await res.json();
  const out = {};
  const results = data?.quoteResponse?.result || [];
  for (const r of results) {
    out[r.symbol] = {
      price: r.regularMarketPrice,
      currency: r.currency,
      previousClose: r.regularMarketPreviousClose,
      changePercent: r.regularMarketChangePercent,
    };
  }
  return out;
}

async function fetchUSDCLP() {
  try {
    const q = await fetchQuotes(['USDCLP=X']);
    return q['USDCLP=X']?.price || null;
  } catch {
    return null;
  }
}

module.exports = { fetchQuotes, fetchUSDCLP };
