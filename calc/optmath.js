/* 期權數學核心 (Black-Scholes-Merton, 連續股息率) — 瀏覽器同 Node 都用得 */
(function (root) {
  'use strict';
  const DAY_MS = 86400000;

  function normPdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }
  function normCdf(x) { // Abramowitz-Stegun 7.1.26 改良 (W. J. Cody 精度足夠)
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1; const z = Math.abs(x) / Math.SQRT2;
    const t = 1 / (1 + p * z);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
    return 0.5 * (1 + sign * y);
  }

  /** BSM 價格 + Greeks。T 以年計；theta 每日；vega/rho 每 1% */
  function bs(type, S, K, T, r, q, sigma) {
    const isCall = type === 'call';
    if (!(K > 0)) return { price: 0, delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
    if (!(S > 0)) return { price: isCall ? 0 : K * Math.exp(-r * Math.max(T, 0)), delta: isCall ? 0 : -1, gamma: 0, theta: 0, vega: 0, rho: 0 };
    if (T <= 0 || sigma <= 0) {
      const intr = Math.max(0, isCall ? S - K : K - S);
      const itm = isCall ? S > K : S < K;
      return { price: intr, delta: itm ? (isCall ? 1 : -1) : 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
    }
    const sq = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sq);
    const d2 = d1 - sigma * sq;
    const dq = Math.exp(-q * T), dr = Math.exp(-r * T);
    let price, delta, theta, rho;
    if (isCall) {
      price = S * dq * normCdf(d1) - K * dr * normCdf(d2);
      delta = dq * normCdf(d1);
      theta = -S * dq * normPdf(d1) * sigma / (2 * sq) - r * K * dr * normCdf(d2) + q * S * dq * normCdf(d1);
      rho = K * T * dr * normCdf(d2);
    } else {
      price = K * dr * normCdf(-d2) - S * dq * normCdf(-d1);
      delta = -dq * normCdf(-d1);
      theta = -S * dq * normPdf(d1) * sigma / (2 * sq) + r * K * dr * normCdf(-d2) - q * S * dq * normCdf(-d1);
      rho = -K * T * dr * normCdf(-d2);
    }
    const gamma = dq * normPdf(d1) / (S * sigma * sq);
    const vega = S * dq * normPdf(d1) * sq;
    return { price: Math.max(price, 0), delta, gamma, theta: theta / 365, vega: vega / 100, rho: rho / 100, d1, d2 };
  }

  /** 由期權金反推引伸波幅 (二分法) */
  function impliedVol(type, price, S, K, T, r, q) {
    if (!(price > 0) || T <= 0) return null;
    const intr = Math.max(0, type === 'call' ? S * Math.exp(-q * T) - K * Math.exp(-r * T) : K * Math.exp(-r * T) - S * Math.exp(-q * T));
    if (price < intr - 1e-9) return null;
    let lo = 0.001, hi = 5;
    if (bs(type, S, K, T, r, q, hi).price < price) return null;
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2;
      if (bs(type, S, K, T, r, q, mid).price > price) hi = mid; else lo = mid;
      if (hi - lo < 1e-6) break;
    }
    return (lo + hi) / 2;
  }

  // ---------- 日期 ----------
  function parseDate(s) { // 'YYYY-MM-DD' → 本地午夜
    if (s instanceof Date) return new Date(s.getFullYear(), s.getMonth(), s.getDate());
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  function isoDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function daysBetween(a, b) { return Math.round((parseDate(b) - parseDate(a)) / DAY_MS); }
  function addDays(d, n) { const x = parseDate(d); x.setDate(x.getDate() + n); return x; }
  function tradingDaysBetween(a, b) {
    let d = parseDate(a), e = parseDate(b), n = 0;
    while (d < e) { d.setDate(d.getDate() + 1); const w = d.getDay(); if (w !== 0 && w !== 6) n++; }
    return n;
  }

  // ---------- 持倉 ----------
  // leg: {side:+1/-1, type:'call'|'put'|'stock', strike, qty, premium, iv, expiry}
  // ctx: {spot, r, q, mult, today:'YYYY-MM-DD', ivShift}
  function legMult(leg, ctx) { return leg.type === 'stock' ? 1 : ctx.mult; }

  function legValue(leg, S, evalDate, ctx) {
    if (leg.type === 'stock') return S;
    const T = Math.max(0, daysBetween(evalDate, leg.expiry)) / 365;
    const iv = Math.max(0.0001, (leg.iv || 0) + (ctx.ivShift || 0));
    return bs(leg.type, S, leg.strike, T, ctx.r, ctx.q, iv).price;
  }
  function legPL(leg, S, evalDate, ctx) {
    return leg.side * (legValue(leg, S, evalDate, ctx) - (leg.premium || 0)) * leg.qty * legMult(leg, ctx);
  }
  function positionPL(legs, S, evalDate, ctx) {
    let s = 0; for (const l of legs) s += legPL(l, S, evalDate, ctx); return s;
  }
  function legGreeks(leg, ctx, evalDate) {
    const m = leg.side * leg.qty * legMult(leg, ctx);
    if (leg.type === 'stock') return { price: ctx.spot, delta: m, gamma: 0, theta: 0, vega: 0, rho: 0, unit: { delta: 1 } };
    const T = Math.max(0, daysBetween(evalDate || ctx.today, leg.expiry)) / 365;
    const g = bs(leg.type, ctx.spot, leg.strike, T, ctx.r, ctx.q, Math.max(0.0001, leg.iv || 0));
    return { price: g.price, delta: g.delta * m, gamma: g.gamma * m, theta: g.theta * m, vega: g.vega * m, rho: g.rho * m, unit: g };
  }

  function earliestExpiry(legs, today) {
    const ex = legs.filter(l => l.type !== 'stock' && l.expiry).map(l => l.expiry).sort();
    return ex.length ? ex[0] : today;
  }

  /** 全面分析：到期盈虧、打和點、最大盈利/虧損、POP、Greeks */
  function analyze(legs, ctx) {
    const res = { legs: [], total: { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 } };
    if (!legs.length) return null;
    const expiry = earliestExpiry(legs, ctx.today);
    const dte = Math.max(0, daysBetween(ctx.today, expiry));
    res.expiry = expiry; res.dte = dte;

    // 淨期權金 (正 = 支出 debit, 負 = 收入 credit)
    let net = 0, optNet = 0, stockCost = 0;
    for (const l of legs) {
      const c = l.side * (l.premium || 0) * l.qty * legMult(l, ctx);
      net += c;
      if (l.type === 'stock') stockCost += c; else optNet += c;
      const g = legGreeks(l, ctx);
      res.legs.push(g);
      for (const k of ['delta', 'gamma', 'theta', 'vega', 'rho']) res.total[k] += g[k];
    }
    res.netCost = net; res.optionNet = optNet; res.stockCost = stockCost;

    // 掃描到期盈虧
    const strikes = legs.filter(l => l.type !== 'stock').map(l => l.strike).filter(x => x > 0);
    const maxRef = Math.max(ctx.spot, ...strikes, 1);
    const hiS = maxRef * 4;
    const N = 4000;
    const pts = new Set([0, hiS]);
    for (let i = 0; i <= N; i++) pts.add(hiS * i / N);
    for (const k of strikes) { pts.add(k); pts.add(k * 0.9999); pts.add(k * 1.0001); }
    const xs = [...pts].sort((a, b) => a - b);
    const f = S => positionPL(legs, S, expiry, ctx);
    const ys = xs.map(f);

    let maxP = Math.max(...ys), maxL = Math.min(...ys);
    // 搵最接近現價、達到極值嘅股價，並標示「≤ / ≥ / =」
    const tol = 1e-6 * Math.max(1, Math.abs(maxP), Math.abs(maxL)) + 1e-6;
    function locate(target) {
      let best = -1;
      xs.forEach((x, i) => { if (Math.abs(ys[i] - target) <= tol && (best < 0 || Math.abs(x - ctx.spot) < Math.abs(xs[best] - ctx.spot))) best = i; });
      let lo = best, hi = best;
      while (lo > 0 && Math.abs(ys[lo - 1] - target) <= tol) lo--;
      while (hi < xs.length - 1 && Math.abs(ys[hi + 1] - target) <= tol) hi++;
      const r4 = v => Math.round(v * 100) / 100;
      let txt;
      if (lo === hi || r4(xs[lo]) === r4(xs[hi])) txt = '= ' + r4(xs[best]);
      else if (lo === 0) txt = '≤ ' + r4(xs[hi]);
      else if (hi === xs.length - 1) txt = '≥ ' + r4(xs[lo]);
      else txt = r4(xs[lo]) + ' – ' + r4(xs[hi]);
      return [xs[best], txt];
    }
    const [maxPAt, maxPDir] = locate(maxP), [maxLAt, maxLDir] = locate(maxL);
    res.maxProfitDir = maxPDir; res.maxLossDir = maxLDir;
    // 尾部斜率 → 無限盈利 / 無限虧損
    const slopeHi = (f(hiS * 2) - f(hiS)) / hiS;
    const eps = 1e-6 * Math.max(1, Math.abs(maxP), Math.abs(maxL));
    if (slopeHi > eps) maxP = Infinity;
    if (slopeHi < -eps) maxL = -Infinity;
    res.maxProfit = maxP; res.maxLoss = maxL; res.maxProfitAt = maxPAt; res.maxLossAt = maxLAt;

    // 打和點
    const be = [];
    for (let i = 1; i < xs.length; i++) {
      const y0 = ys[i - 1], y1 = ys[i];
      if (y0 === 0 && i === 1) continue;
      if ((y0 < 0 && y1 > 0) || (y0 > 0 && y1 < 0) || (y1 === 0 && y0 !== 0)) {
        let a = xs[i - 1], b = xs[i], fa = y0;
        for (let k = 0; k < 60; k++) { const m = (a + b) / 2, fm = f(m); if ((fa < 0) === (fm < 0)) { a = m; fa = fm; } else b = m; }
        const v = (a + b) / 2;
        if (!be.length || Math.abs(v - be[be.length - 1]) > maxRef * 1e-5) be.push(v);
      }
    }
    res.breakevens = be;

    // 獲利機率 (到期時股價對數常態, 用平均 IV)
    const ivs = legs.filter(l => l.type !== 'stock' && l.iv > 0).map(l => l.iv + (ctx.ivShift || 0));
    const sig = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : (ctx.defaultIV || 0.3);
    const T = dte / 365;
    const cdf = S => {
      if (S <= 0) return 0;
      if (T <= 0) return S >= ctx.spot ? 1 : 0;
      return normCdf((Math.log(S / ctx.spot) - (ctx.r - ctx.q - 0.5 * sig * sig) * T) / (sig * Math.sqrt(T)));
    };
    let pop = 0;
    for (let i = 1; i < xs.length; i++) {
      const mid = (xs[i - 1] + xs[i]) / 2;
      if (f(mid) > 0) pop += cdf(xs[i]) - cdf(xs[i - 1]);
    }
    if (ys[ys.length - 1] > 0) pop += 1 - cdf(xs[xs.length - 1]);
    res.pop = Math.min(1, Math.max(0, pop));
    res.popSigma = sig;
    res.expectedMove = ctx.spot * sig * Math.sqrt(T);

    // 所需本金 / 回報率
    const credit = -optNet; // 期權淨收入 (正數 = 收錢)
    res.credit = credit;
    if (isFinite(maxL)) {
      res.capital = Math.max(0, -maxL + Math.max(0, credit));
      res.capitalKind = 'defined';
    } else {
      // 有無限虧損: Reg-T 粗略保證金 (每張: max(20%·S − 價外, 10%·K/S) + 期權金)
      let m = 0;
      for (const l of legs) {
        if (l.type === 'stock' || l.side > 0) continue;
        const otm = l.type === 'call' ? Math.max(0, l.strike - ctx.spot) : Math.max(0, ctx.spot - l.strike);
        const base = Math.max(0.2 * ctx.spot - otm, 0.1 * (l.type === 'call' ? ctx.spot : l.strike));
        m += (base + (l.premium || 0)) * l.qty * ctx.mult;
      }
      res.capital = m; res.capitalKind = 'margin';
    }
    if (res.capital > 0) {
      const gain = credit > 0 ? credit : (isFinite(maxP) ? maxP : null);
      if (gain != null) {
        res.returnPct = gain / res.capital;
        if (dte > 0) {
          res.annualSimple = res.returnPct * 365 / dte;
          res.annualCompound = Math.pow(1 + res.returnPct, 365 / dte) - 1;
        }
      }
    }
    if (isFinite(maxP) && isFinite(maxL) && maxL < 0) res.rewardRisk = maxP / -maxL;
    return res;
  }

  function strikeStep(price) {
    if (price < 5) return 0.5; if (price < 25) return 0.5; if (price < 100) return 1;
    if (price < 250) return 2.5; if (price < 1000) return 5; return 10;
  }

  const api = { normCdf, normPdf, bs, impliedVol, parseDate, isoDate, daysBetween, addDays, tradingDaysBetween,
    legValue, legPL, positionPL, legGreeks, analyze, earliestExpiry, strikeStep };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.OptMath = api;
})(typeof window !== 'undefined' ? window : globalThis);
