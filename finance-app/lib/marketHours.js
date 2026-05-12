function getNyParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return parts;
}

function nyDateAtHour(parts, hour, minute) {
  const isoLocal = `${parts.year}-${parts.month}-${parts.day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
  const guess = new Date(isoLocal + 'Z');
  const checkParts = getNyParts(guess);
  const hourDiff = parseInt(checkParts.hour, 10) - hour;
  return new Date(guess.getTime() - hourDiff * 3600000);
}

function getMarketState(now = new Date()) {
  const parts = getNyParts(now);
  const dow = parts.weekday;
  const h = parseInt(parts.hour, 10);
  const m = parseInt(parts.minute, 10);
  const minutesOfDay = h * 60 + m;

  const isWeekend = (dow === 'Sat' || dow === 'Sun');
  const openMin = 9 * 60 + 30;
  const closeMin = 16 * 60;
  const preMin = 4 * 60;
  const afterMin = 20 * 60;

  let state = 'closed';
  if (!isWeekend) {
    if (minutesOfDay >= openMin && minutesOfDay < closeMin) state = 'open';
    else if (minutesOfDay >= preMin && minutesOfDay < openMin) state = 'pre-market';
    else if (minutesOfDay >= closeMin && minutesOfDay < afterMin) state = 'after-hours';
  }

  let nextOpen = nyDateAtHour(parts, 9, 30);
  if (nextOpen.getTime() <= now.getTime()) {
    nextOpen = new Date(nextOpen.getTime() + 24 * 3600000);
  }
  while (true) {
    const dowCheck = getNyParts(nextOpen).weekday;
    if (dowCheck !== 'Sat' && dowCheck !== 'Sun') break;
    nextOpen = new Date(nextOpen.getTime() + 24 * 3600000);
  }

  let nextClose = nyDateAtHour(parts, 16, 0);
  if (state === 'open' && nextClose.getTime() <= now.getTime()) {
    nextClose = new Date(nextClose.getTime() + 24 * 3600000);
  }

  return {
    state,
    open: state === 'open',
    nextOpen: nextOpen.toISOString(),
    nextClose: nextClose.toISOString(),
    nyTime: `${parts.hour}:${parts.minute} ${dow}`,
  };
}

module.exports = { getMarketState };
