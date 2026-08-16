/* =====================================================================
   fx.js — live currency conversion via the free Frankfurter API.
   Falls back to open.er-api.com, then 1:1. Rates cached 1h in-memory.
   ===================================================================== */
(function () {
  const cache = new Map();
  const TTL = 60 * 60 * 1000;

  async function fetchFrankfurter(from, to) {
    try {
      const r = await fetch(`https://api.frankfurter.app/latest?from=${from}&to=${to}`);
      if (!r.ok) return null;
      const d = await r.json();
      return typeof d?.rates?.[to] === 'number' ? d.rates[to] : null;
    } catch { return null; }
  }

  async function fetchOpenERApi(from, to) {
    try {
      const r = await fetch(`https://open.er-api.com/v6/latest/${from}`);
      if (!r.ok) return null;
      const d = await r.json();
      return typeof d?.rates?.[to] === 'number' ? d.rates[to] : null;
    } catch { return null; }
  }

  window.getFxRate = async function (from, to) {
    if (from === to) return 1;
    const key = `${from}_${to}`;
    const c = cache.get(key);
    if (c && Date.now() - c.ts < TTL) return c.rate;
    const rate = (await fetchFrankfurter(from, to)) ?? (await fetchOpenERApi(from, to)) ?? 1;
    cache.set(key, { rate, ts: Date.now() });
    return rate;
  };

  window.formatMoney = function (value, currency) {
    const meta = window.CURRENCIES[currency] || { symbol: '' };
    return `${meta.symbol}${Number(value).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  };
})();
