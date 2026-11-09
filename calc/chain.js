/* Delayed option-chain parser — browser and Node.
   Compact file (calc/data/chains/SYM.json), written by tools/refresh_option_chains.py:

   { "symbol":"NVDA", "source":"CBOE delayed", "asOf":"2026-11-09 15:40:07", "spot":178.8,
     "expiries": { "2026-12-24": { "c":[[strike,bid,ask,iv,last],...], "p":[...] } } }

   HK files use the same shape with source "HKEX delayed" (0700.HK.json, ATS code TCH).
   iv is a decimal (0.62 = 62%). bid/ask/last are per share. 0 means missing.
   US chains keep only the standard root (NVDA, not an adjusted deliverable). */
(function (root) {
  'use strict';

  function num(x) {
    const n = typeof x === 'number' ? x : parseFloat(x);
    return Number.isFinite(n) ? n : 0;
  }
  function round4(x) {
    const n = Math.round(num(x) * 10000) / 10000;
    return Math.abs(n - Math.round(n)) < 1e-9 ? Math.round(n) : n;
  }
  function normRoot(s) {
    return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
  function isoFromYYMMDD(s) {
    const y = 2000 + (+s.slice(0, 2));
    const m = +s.slice(2, 4);
    const d = +s.slice(4, 6);
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  /** OCC-style symbol: NVDA261224P00150000 */
  function occParts(symbol) {
    const m = /^([A-Z0-9.]+)(\d{6})([CP])(\d{8})$/.exec(symbol || '');
    if (!m) return null;
    const expiry = isoFromYYMMDD(m[2]);
    if (!expiry) return null;
    return { root: m[1], expiry, type: m[3] === 'C' ? 'call' : 'put', strike: (+m[4]) / 1000 };
  }

  function quoteScore(r) {
    let s = 0;
    if (r.bid > 0 && r.ask > 0) s += 4;
    if (r.bid > 0) s += 1;
    if (r.ask > 0) s += 1;
    if (r.iv > 0) s += 1;
    return s;
  }
  function upsert(list, row) {
    const i = list.findIndex(r => Math.abs(r.strike - row.strike) < 1e-6);
    if (i < 0) list.push(row);
    else if (quoteScore(row) >= quoteScore(list[i])) list[i] = row;
  }

  /** bid/ask per share. mid only when both sides exist; one-sided quotes fall through as last. */
  function rowFromQuote(strike, bid, ask, iv, last) {
    strike = num(strike);
    bid = num(bid); ask = num(ask); last = num(last); iv = num(iv);
    if (!(strike > 0)) return null;
    if (!(bid > 0) && !(ask > 0) && !(last > 0)) return null;
    let viv = null;
    if (iv > 0.01 && iv < 5) viv = iv;
    else if (iv >= 5 && iv < 500) viv = iv / 100;
    const row = { strike: round4(strike) };
    if (bid > 0) row.bid = bid;
    if (ask > 0) row.ask = ask;
    if (last > 0) row.last = last;
    if (bid > 0 && ask > 0) row.mid = (bid + ask) / 2;
    else if (!(row.last > 0)) row.last = bid > 0 ? bid : ask;
    if (viv) row.iv = viv;
    return row;
  }

  function finish(symbol, asOf, spot, chains) {
    const expirations = Object.keys(chains).sort();
    if (!expirations.length) return null;
    for (const e of expirations) {
      chains[e].calls.sort((a, b) => a.strike - b.strike);
      chains[e].puts.sort((a, b) => a.strike - b.strike);
    }
    return {
      symbol: String(symbol || '').toUpperCase(),
      asOf: asOf || null,
      spot: num(spot) || null,
      expirations,
      chains,
    };
  }

  /** Stock-option expiry: weekday before the last weekday of contract month MMYYYY. */
  function expiryFromContractId(id) {
    if (!/^\d{6}$/.test(id || '')) return null;
    const month = +id.slice(0, 2);
    const year = +id.slice(2);
    if (month < 1 || month > 12 || year < 2000) return null;
    let last = new Date(year, month, 0);
    while (last.getDay() === 0 || last.getDay() === 6) last = new Date(last.getFullYear(), last.getMonth(), last.getDate() - 1);
    let exp = new Date(last.getFullYear(), last.getMonth(), last.getDate() - 1);
    while (exp.getDay() === 0 || exp.getDay() === 6) exp = new Date(exp.getFullYear(), exp.getMonth(), exp.getDate() - 1);
    return exp.getFullYear() + '-' + String(exp.getMonth() + 1).padStart(2, '0') + '-' + String(exp.getDate()).padStart(2, '0');
  }
  function commaNum(x) {
    if (typeof x === 'string') x = x.replace(/,/g, '').trim();
    if (x === '-' || x === '') return 0;
    return num(x);
  }

  /**
   * HKEX widget months: { symbol, asOf, spot, ats, months:[{ id, expiry, optionlist }] }.
   * optionlist rows are { strike, c:{bd,as,ls,iv}, p:{...} }. IV from HKEX is a percent.
   */
  function chainsFromHkex(bundle) {
    if (!bundle) return null;
    const chains = {};
    for (const month of bundle.months || []) {
      const expiry = (month && (month.expiry || expiryFromContractId(month.id))) || null;
      if (!expiry) continue;
      const bucket = chains[expiry] || (chains[expiry] = { calls: [], puts: [] });
      for (const row of (month && month.optionlist) || []) {
        const strike = commaNum(row.strike);
        for (const [type, key] of [['call', 'c'], ['put', 'p']]) {
          const q = row[key] || {};
          let iv = commaNum(q.iv);
          if (iv > 0) iv = iv / 100;
          const parsed = rowFromQuote(strike, commaNum(q.bd), commaNum(q.as), iv, commaNum(q.ls));
          if (!parsed) continue;
          upsert(type === 'call' ? bucket.calls : bucket.puts, parsed);
        }
      }
      if (!bucket.calls.length && !bucket.puts.length) delete chains[expiry];
    }
    const parsed = finish(bundle.symbol, bundle.asOf, bundle.spot, chains);
    if (!parsed) return null;
    parsed.source = 'HKEX delayed';
    if (bundle.ats) parsed.ats = bundle.ats;
    return parsed;
  }

  function chainsFromCboe(payload, symbol) {
    const data = payload && payload.data;
    const options = data && data.options;
    if (!Array.isArray(options) || !options.length) return null;
    const want = normRoot(symbol || data.symbol);
    if (!want) return null;
    const chains = {};
    for (const o of options) {
      const p = occParts(o.option || o.symbol);
      if (!p || normRoot(p.root) !== want) continue;
      const row = rowFromQuote(p.strike, o.bid, o.ask, o.iv, o.last_trade_price);
      if (!row) continue;
      const bucket = chains[p.expiry] || (chains[p.expiry] = { calls: [], puts: [] });
      upsert(p.type === 'call' ? bucket.calls : bucket.puts, row);
    }
    const parsed = finish(symbol || data.symbol, payload.timestamp, data.current_price, chains);
    if (parsed) parsed.source = 'CBOE delayed';
    return parsed;
  }

  function chainsFromCompact(j) {
    if (!j || !j.expiries || typeof j.expiries !== 'object') return null;
    const chains = {};
    for (const exp of Object.keys(j.expiries)) {
      const sides = j.expiries[exp] || {};
      const conv = arr => (Array.isArray(arr) ? arr : []).map(x => rowFromQuote(x[0], x[1], x[2], x[3], x[4])).filter(Boolean);
      const bucket = { calls: [], puts: [] };
      for (const row of conv(sides.c || sides.calls)) upsert(bucket.calls, row);
      for (const row of conv(sides.p || sides.puts)) upsert(bucket.puts, row);
      if (bucket.calls.length || bucket.puts.length) chains[exp] = bucket;
    }
    const parsed = finish(j.symbol, j.asOf, j.spot, chains);
    if (parsed) {
      parsed.via = j.via === 'live' ? 'live' : (j.via || 'baked');
      if (j.source) parsed.source = j.source;
      if (j.ats) parsed.ats = j.ats;
    }
    return parsed;
  }

  function toCompact(parsed) {
    const expiries = {};
    const pack = rows => rows.map(r => [
      round4(r.strike),
      r.bid > 0 ? round4(r.bid) : 0,
      r.ask > 0 ? round4(r.ask) : 0,
      r.iv > 0 ? round4(r.iv) : 0,
      r.last > 0 ? round4(r.last) : 0,
    ]);
    for (const e of parsed.expirations) {
      expiries[e] = { c: pack(parsed.chains[e].calls), p: pack(parsed.chains[e].puts) };
    }
    const out = {
      symbol: parsed.symbol,
      source: parsed.source || 'CBOE delayed',
      asOf: parsed.asOf,
      spot: parsed.spot || null,
      expiries,
    };
    if (parsed.ats) out.ats = parsed.ats;
    return out;
  }

  const api = {
    occParts, normRoot, expiryFromContractId,
    chainsFromCboe, chainsFromHkex, chainsFromCompact, toCompact, rowFromQuote,
  };
  root.OptChain = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
