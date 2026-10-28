/*! AlphaView Pro — browser LIVE quotes (Yahoo + Tencent). holdings.json = position snapshot only. */
(() => {
'use strict';

const PUBLIC_PROXIES = [
  ['corsproxy.io', u => 'https://corsproxy.io/?url=' + encodeURIComponent(u)],
  ['allorigins', u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u)],
  ['codetabs', u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u)],
];
const REFRESH_MS = 45000;
const BATCH = 6;

const state = {
  holdings: [],
  cash: null,
  syncedAt: '',
  fx: { USDHKD: 7.8447, CNYHKD: 1.177, JPYHKD: 0.04968 },
  quotes: {}, // yahooSym -> {price, prevClose, changePct, via, ts}
  filter: 'All',
  search: '',
  auto: true,
  lastQuoteAt: null,
  quoteOk: 0,
  quoteFail: 0,
  refreshing: false,
};

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (v, d = 0) => {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
};
const signed = (v, d = 0) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = (v > 0 ? '+' : '') + fmt(v, d);
  return s;
};
const clsPL = v => (v > 0.5 ? 'text-up' : v < -0.5 ? 'text-down' : 'text-gray-300');
const badgePL = v => (v > 0.5 ? 'badge-up' : v < -0.5 ? 'badge-down' : 'badge-neutral');

async function fetchWithTimeout(url, ms = 7000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r;
  } finally { clearTimeout(t); }
}
const fetchJSON = async (url, ms) => (await fetchWithTimeout(url, ms)).json();

function parseYahooChart(j) {
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res || !res.meta || !(res.meta.regularMarketPrice > 0 || res.meta.previousClose > 0))
    throw new Error('Yahoo invalid');
  const meta = res.meta;
  const price = meta.regularMarketPrice || meta.previousClose;
  const prevClose = meta.chartPreviousClose || meta.previousClose || price;
  return {
    price,
    prevClose,
    currency: meta.currency,
    name: meta.shortName || meta.longName,
    change: price - prevClose,
    changePct: prevClose ? (price - prevClose) / prevClose : 0,
  };
}

async function yahooQuote(sym) {
  const path = `/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`;
  const direct = ['https://query1.finance.yahoo.com' + path, 'https://query2.finance.yahoo.com' + path];
  for (const u of direct) {
    try { return { ...parseYahooChart(await fetchJSON(u, 4000)), _via: 'Yahoo直連' }; } catch (_) {}
  }
  const cand = PUBLIC_PROXIES.map(([n, f]) => [n, f(direct[0])]);
  return Promise.any(cand.map(async ([n, u]) => ({ ...parseYahooChart(await fetchJSON(u, 7000)), _via: 'Yahoo/' + n })))
    .catch(() => { throw new Error('Yahoo fail ' + sym); });
}

async function fetchGbkText(url) {
  const r = await fetchWithTimeout(url, 6000);
  const buf = await r.arrayBuffer();
  try { return new TextDecoder('gbk').decode(buf); } catch { return new TextDecoder().decode(buf); }
}

function loadScriptVar(url, varName) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.charset = 'gbk';
    s.src = url;
    const t = setTimeout(() => { s.remove(); rej(new Error('timeout')); }, 6000);
    s.onload = () => { clearTimeout(t); s.remove(); window[varName] != null ? res(window[varName]) : rej(new Error('no data')); };
    s.onerror = () => { clearTimeout(t); s.remove(); rej(new Error('load fail')); };
    document.head.appendChild(s);
  });
}

async function tencentQuote(tcCode) {
  if (!tcCode) throw new Error('no tencent code');
  let raw;
  try {
    const txt = await fetchGbkText('https://qt.gtimg.cn/q=' + tcCode);
    raw = (/="([^"]*)"/.exec(txt) || [])[1];
  } catch {
    raw = await loadScriptVar('https://qt.gtimg.cn/q=' + tcCode, 'v_' + tcCode);
  }
  if (!raw || raw.indexOf('~') < 0) throw new Error('Tencent empty');
  const f = raw.split('~');
  const price = parseFloat(f[3]);
  if (!(price > 0)) throw new Error('Tencent no price');
  const prevClose = parseFloat(f[4]) || price;
  return {
    price,
    prevClose,
    name: f[1],
    change: price - prevClose,
    changePct: prevClose ? (price - prevClose) / prevClose : 0,
    _via: '騰訊財經',
  };
}

async function getQuoteForHolding(h) {
  // Prefer Yahoo; fall back to Tencent for equities
  if (h.yahoo) {
    try {
      const q = await yahooQuote(h.yahoo);
      return q;
    } catch (_) {}
  }
  if (h.tencent) {
    try {
      return await tencentQuote(h.tencent);
    } catch (_) {}
  }
  // Option without Yahoo (HK): keep seed price
  if (h.seedPrice > 0) {
    return {
      price: h.seedPrice,
      prevClose: h.seedPrice,
      change: 0,
      changePct: 0,
      _via: '券商快照',
      _seed: true,
    };
  }
  throw new Error('no quote');
}

async function getFx() {
  const pairs = [
    ['USDHKD', 'USDHKD=X'],
    ['CNYHKD', 'CNYHKD=X'],
    ['JPYHKD', 'JPYHKD=X'],
  ];
  await Promise.all(pairs.map(async ([k, sym]) => {
    try {
      const q = await yahooQuote(sym);
      if (q.price > 0) state.fx[k] = q.price;
    } catch (_) {
      // try alternate CNH
      if (k === 'CNYHKD') {
        try {
          const q = await yahooQuote('CNHHKD=X');
          if (q.price > 0) state.fx[k] = q.price;
        } catch (__) {}
      }
    }
  }));
}

function fxToHKD(currency) {
  const c = (currency || 'HKD').toUpperCase();
  if (c === 'HKD') return 1;
  if (c === 'USD') return state.fx.USDHKD;
  if (c === 'CNH' || c === 'CNY') return state.fx.CNYHKD;
  if (c === 'JPY') return state.fx.JPYHKD;
  return 1;
}

function enrich(h) {
  const key = h.yahoo || h.id;
  const q = state.quotes[key];
  const price = q ? q.price : h.seedPrice;
  const prevClose = q ? q.prevClose : h.seedPrice;
  const live = !!(q && !q._seed);
  const fx = fxToHKD(h.currency);
  const mult = h.multiplier || 1;
  const qty = h.qty;
  const cost = h.cost || 0;
  const mvNative = price * qty * mult;
  const mvHKD = mvNative * fx;
  const costNative = cost * qty * mult;
  const costHKD = costNative * fx;
  let plHKD;
  if (h.costUnknown || !(cost > 0) && h.quoteKind === 'crypto') {
    plHKD = null;
  } else {
    plHKD = (price - cost) * qty * mult * fx;
  }
  const todayHKD = (price - prevClose) * qty * mult * fx;
  const changePct = prevClose ? (price - prevClose) / prevClose : 0;
  return {
    ...h,
    price,
    prevClose,
    live,
    via: q ? q._via : 'seed',
    fx,
    mvNative,
    mvHKD,
    costHKD,
    plHKD,
    todayHKD,
    changePct,
  };
}

function cashHKD() {
  const c = state.cash || {};
  let total = 0;
  total += Number(c.futuSecuritiesCashHKD || 0);
  total += Number(c.futuFundsAssetsHKD || 0);
  for (const x of (c.futuCryptoCash || [])) {
    total += Number(x.amount || 0) * fxToHKD(x.currency);
  }
  for (const x of (c.ibkrCash || [])) {
    total += Number(x.amount || 0) * fxToHKD(x.currency);
  }
  return total;
}

function compute() {
  const rows = state.holdings.map(enrich);
  let mv = 0, pl = 0, today = 0, costBasis = 0;
  const attr = { US: 0, HK: 0, A: 0, JP: 0, BTC: 0, OPT: 0, Other: 0 };
  let optPremium = 0; // premium received on shorts = cost * |qty| * mult (native→HKD)
  let optPl = 0;
  let optToday = 0;
  let optOpen = 0;

  for (const r of rows) {
    mv += r.mvHKD;
    if (r.plHKD != null) {
      pl += r.plHKD;
      costBasis += Math.abs(r.costHKD);
    }
    today += r.todayHKD;
    const bucket = r.type === 'OPT' ? 'OPT'
      : r.market === 'JP' ? 'JP'
      : r.market === 'BTC' ? 'BTC'
      : (attr[r.type] != null ? r.type : 'Other');
    attr[bucket] = (attr[bucket] || 0) + r.todayHKD;

    if (r.type === 'OPT') {
      optOpen++;
      const prem = Math.abs(r.cost * r.qty * (r.multiplier || 1) * r.fx);
      optPremium += prem;
      if (r.plHKD != null) optPl += r.plHKD;
      optToday += r.todayHKD;
    }
  }

  const cash = cashHKD();
  const net = cash + mv;
  const plPct = costBasis > 0 ? pl / costBasis : 0;
  const todayPct = (net - today) !== 0 ? today / (net - today) : 0;

  return { rows, mv, pl, today, cash, net, plPct, todayPct, attr, optPremium, optPl, optToday, optOpen };
}

function renderStatus(c) {
  const syncEl = $('posSyncTime');
  if (syncEl) syncEl.textContent = state.syncedAt || '—';
  const qEl = $('quoteUpdateTime');
  if (qEl) qEl.textContent = state.lastQuoteAt
    ? state.lastQuoteAt.toLocaleTimeString('zh-HK', { hour12: false })
    : '載入中…';
  const mode = $('liveModeLabel');
  if (mode) {
    mode.textContent = state.auto
      ? `報價即時 · 持倉上次同步 ${state.syncedAt || '—'}`
      : `報價已暫停 · 持倉上次同步 ${state.syncedAt || '—'}`;
  }
  const fxBar = $('fxBar');
  if (fxBar) {
    fxBar.innerHTML = `
      <span>USD/HKD <strong class="text-gray-300">${state.fx.USDHKD.toFixed(4)}</strong></span>
      <span>CNY/HKD <strong class="text-gray-300">${state.fx.CNYHKD.toFixed(4)}</strong></span>
      <span>JPY/HKD <strong class="text-gray-300">${state.fx.JPYHKD.toFixed(5)}</strong></span>`;
  }
  const qStat = $('quoteStat');
  if (qStat) {
    qStat.textContent = `報價成功 ${state.quoteOk} / 失敗 ${state.quoteFail}`;
  }
}

function renderKPIs(c) {
  const set = (id, text, className) => {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    if (className) el.className = className;
  };

  set('totalNetAsset', fmt(c.net, 0));
  set('todayChangeAmt', signed(c.today, 0), `text-lg font-bold font-num ${clsPL(c.today)}`);
  const pctEl = $('todayChangePct');
  if (pctEl) {
    pctEl.textContent = signed(c.todayPct * 100, 2) + '%';
    pctEl.className = `text-xs font-num px-1.5 py-0.2 rounded ${badgePL(c.today)}`;
  }
  set('totalUnrealizedPL', signed(c.pl, 0), `text-lg font-bold font-num ${clsPL(c.pl)}`);
  const plPct = $('totalUnrealizedPct');
  if (plPct) {
    plPct.textContent = signed(c.plPct * 100, 1) + '%';
    plPct.className = `text-xs font-num px-1.5 py-0.2 rounded ${badgePL(c.pl)}`;
  }
  set('totalCash', fmt(c.cash, 0));
  const cashPct = $('totalCashPct');
  if (cashPct) cashPct.textContent = c.net ? (c.cash / c.net * 100).toFixed(1) + '%' : '—';

  set('optPremium', signed(c.optPremium, 0), 'text-lg font-bold text-emerald-400 font-num');
  const optOpen = $('optOpenCount');
  if (optOpen) optOpen.textContent = c.optOpen + '張未平倉';

  const lev = $('ibkrLeverage');
  if (lev && state.cash) lev.textContent = (state.cash.ibkrLeverage || 0.98).toFixed(2) + 'x';

  // net asset diff vs broker seed (optional)
  const seedNet = (state.cash?.futuTotalAssetsHKD || 0) + (state.cash?.ibkrNetLiquidationHKD || 0)
    + (c.rows.find(r => r.market === 'BTC')?.mvHKD || 0)
    + (state.cash?.futuCryptoCash || []).reduce((a, x) => a + Number(x.amount) * fxToHKD(x.currency), 0);
  // Better: just show live vs previous quote cycle — skip or show quote count
  const diff = $('netAssetDiff');
  if (diff) {
    diff.textContent = state.quoteOk ? `LIVE×${state.quoteOk}` : '…';
    diff.className = 'text-[10px] text-emerald-400 font-num';
  }

  // attribution
  const map = [
    ['contribUS', '美股', c.attr.US],
    ['contribHK', '港股', c.attr.HK],
    ['contribA', 'A股', c.attr.A],
    ['contribJP', '日股', c.attr.JP],
    ['contribBTC', 'BTC', c.attr.BTC],
    ['contribOPT', '期權', c.attr.OPT],
  ];
  for (const [id, label, v] of map) {
    const el = $(id);
    if (!el) continue;
    el.textContent = `${label} ${signed(v, 0)}`;
    el.className = `px-2 py-0.5 rounded font-num ${badgePL(v)}`;
  }

  const optTodayEl = $('optTodayPL');
  if (optTodayEl) {
    optTodayEl.innerHTML = `今日期權盈虧: <strong class="${clsPL(c.optToday)}">${signed(c.optToday, 0)} HKD</strong>`;
  }

  // broker cards
  const futuMV = c.rows.filter(r => r.broker === 'Futu' || r.broker === 'Futu Crypto').reduce((a, r) => a + r.mvHKD, 0);
  const futuCash = Number(state.cash?.futuSecuritiesCashHKD || 0) + Number(state.cash?.futuFundsAssetsHKD || 0)
    + (state.cash?.futuCryptoCash || []).reduce((a, x) => a + Number(x.amount) * fxToHKD(x.currency), 0);
  const ibkrMV = c.rows.filter(r => r.broker === 'IBKR').reduce((a, r) => a + r.mvHKD, 0);
  const ibkrCash = (state.cash?.ibkrCash || []).reduce((a, x) => a + Number(x.amount) * fxToHKD(x.currency), 0);
  const btcRow = c.rows.find(r => r.market === 'BTC');

  set('futuNet', fmt(futuCash + c.rows.filter(r => r.broker === 'Futu').reduce((a, r) => a + r.mvHKD, 0), 0));
  set('ibkrNet', fmt(ibkrCash + ibkrMV, 0));
  set('btcNet', fmt((btcRow?.mvHKD || 0) + (state.cash?.futuCryptoCash || []).reduce((a, x) => a + Number(x.amount) * fxToHKD(x.currency), 0), 0));
  set('btcToday', signed(btcRow?.todayHKD || 0, 0), `font-bold font-num ${clsPL(btcRow?.todayHKD || 0)}`);

  // allocation bar
  renderAllocation(c);
}

function renderAllocation(c) {
  const groups = {
    '收益型': 0, '現金': c.cash, '港股': 0, '美股': 0, '日本': 0, 'A股': 0, 'BTC': 0, '期權': 0,
  };
  const income = new Set(['PFN', 'PCN', 'TLT', 'JEPI', '03419', '02823', '02806']);
  for (const r of c.rows) {
    const absMv = Math.abs(r.mvHKD);
    if (r.type === 'OPT') groups['期權'] += absMv;
    else if (r.market === 'BTC') groups['BTC'] += absMv;
    else if (r.market === 'JP') groups['日本'] += absMv;
    else if (r.type === 'A') groups['A股'] += absMv;
    else if (r.type === 'HK') groups['港股'] += absMv;
    else if (income.has(String(r.symbol).replace('.T', ''))) groups['收益型'] += absMv;
    else if (r.type === 'US') groups['美股'] += absMv;
    else groups['美股'] += absMv;
  }
  // move funds into 現金 already counted via futuFundsAssets
  const total = Object.values(groups).reduce((a, b) => a + b, 0) || 1;
  const colors = {
    '收益型': 'bg-blue-500', '現金': 'bg-emerald-500', '港股': 'bg-purple-500',
    '美股': 'bg-amber-500', '日本': 'bg-cyan-500', 'A股': 'bg-rose-500',
    'BTC': 'bg-orange-400', '期權': 'bg-indigo-400',
  };
  const bar = $('allocBar');
  const list = $('allocList');
  if (bar) {
    bar.innerHTML = Object.entries(groups).filter(([, v]) => v > 0).map(([k, v], i, arr) => {
      const w = (v / total * 100).toFixed(1);
      const round = i === 0 ? 'rounded-l-full' : (i === arr.length - 1 ? 'rounded-r-full' : '');
      return `<div class="${colors[k]} h-full ${round}" style="width:${w}%" title="${k} ${w}%"></div>`;
    }).join('');
  }
  if (list) {
    list.innerHTML = Object.entries(groups).filter(([, v]) => v > 0).map(([k, v]) => {
      const pct = (v / total * 100).toFixed(1);
      return `<div class="flex justify-between items-center py-1 border-b border-borderDark/50">
        <span class="flex items-center gap-1.5 text-gray-300"><span class="w-2 h-2 rounded-sm ${colors[k]}"></span>${esc(k)}</span>
        <span class="text-white font-semibold">${pct}% <span class="text-muted text-[10px]">(${fmt(v / 1000, 0)}k)</span></span>
      </div>`;
    }).join('');
  }
  const allocTitle = $('allocTitle');
  if (allocTitle) allocTitle.textContent = `資產配置結構 (HK$ ${(c.net / 1e6).toFixed(2)}M)`;
}

function renderHoldings(c) {
  let rows = c.rows.filter(r => r.type !== 'OPT'); // options in separate book; still in totals
  // Actually user wants holdings table to show all including options? Original showed 41 stocks+BTC without options detail in side table.
  // Keep stocks+BTC in side table; options in options book. Also allow filter OPT.
  if (state.filter === 'OPT') {
    rows = c.rows.filter(r => r.type === 'OPT');
  } else if (state.filter === 'CNHK') {
    rows = c.rows.filter(r => r.type === 'HK' || r.type === 'A');
  } else if (state.filter === 'Other') {
    rows = c.rows.filter(r => r.type === 'Other' || r.market === 'JP' || r.market === 'BTC');
  } else if (state.filter !== 'All') {
    rows = c.rows.filter(r => r.type === state.filter);
  } else {
    rows = c.rows.slice();
  }

  if (state.search.trim()) {
    const q = state.search.trim().toLowerCase();
    rows = rows.filter(r =>
      String(r.display).toLowerCase().includes(q) ||
      String(r.name).toLowerCase().includes(q) ||
      String(r.symbol).toLowerCase().includes(q) ||
      String(r.broker).toLowerCase().includes(q)
    );
  }

  rows.sort((a, b) => Math.abs(b.mvHKD) - Math.abs(a.mvHKD));

  const count = $('totalHoldingCount');
  if (count) count.textContent = String(rows.length);

  const tbody = $('holdingsBody');
  if (!tbody) return;
  tbody.innerHTML = rows.map(r => {
    const chg = signed(r.changePct * 100, 2) + '%';
    const plStr = r.plHKD == null ? '—' : signed(r.plHKD, 0);
    const liveDot = r.live
      ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1" title="即時報價"></span>'
      : '<span class="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 mr-1" title="券商快照"></span>';
    return `<tr class="interactive-row">
      <td>
        <div class="font-bold text-white font-num flex items-center">${liveDot}${esc(r.display)}</div>
        <div class="text-[11px] text-muted truncate max-w-[140px]">${esc(r.name)} · ${esc(r.broker)}</div>
      </td>
      <td class="text-right font-num">
        <div class="font-semibold text-gray-100">${fmt(r.price, r.price < 10 ? 3 : 2)}</div>
        <div class="text-[10px] text-muted">${esc(r.currency)} × ${fmt(r.qty, r.qty % 1 ? 4 : 0)}</div>
      </td>
      <td class="text-right font-num">
        <span class="px-2 py-0.5 rounded text-xs font-semibold ${badgePL(r.changePct)}">${chg}</span>
      </td>
      <td class="text-right font-num hidden sm:table-cell">
        <div class="text-gray-100">${fmt(r.mvHKD, 0)}</div>
        <div class="text-[10px] ${clsPL(r.plHKD || 0)}">${plStr}</div>
      </td>
    </tr>`;
  }).join('');
}

function renderOptions(c) {
  const tbody = $('optionsBody');
  if (!tbody) return;
  const opts = c.rows.filter(r => r.type === 'OPT');
  tbody.innerHTML = opts.map(r => {
    const und = c.rows.find(x => x.yahoo === r.underlying || x.display === r.underlying?.replace('.HK','').padStart(5,'0') ||
      (r.underlying && (x.yahoo === r.underlying || x.symbol === r.underlying.replace('.HK',''))));
    // better underlying lookup
    let undPrice = null;
    const uSym = r.underlying;
    if (uSym) {
      const uq = state.quotes[uSym] || state.quotes[uSym.replace('.HK', '')];
      // find by yahoo match
      const match = c.rows.find(x => x.yahoo === uSym || (uSym.endsWith('.HK') && x.yahoo === uSym));
      undPrice = match ? match.price : (state.quotes[uSym]?.price ?? null);
    }
    const strike = r.strike;
    let moneyness = '—';
    if (undPrice && strike) {
      const pct = (undPrice - strike) / strike * 100;
      if (r.right === 'C') {
        moneyness = pct < 0
          ? `<span class="text-emerald-400">價外 ${signed(-pct, 1)}%</span>`
          : `<span class="text-amber-400">價內 ${signed(pct, 1)}%</span>`;
      } else {
        moneyness = pct > 0
          ? `<span class="text-emerald-400">價外 ${signed(pct, 1)}%</span>`
          : `<span class="text-amber-400">價內 ${signed(-pct, 1)}%</span>`;
      }
    }
    const premNative = Math.abs(r.cost * r.qty * (r.multiplier || 1));
    const nowNative = Math.abs(r.price * r.qty * (r.multiplier || 1));
    const recovered = premNative > 0 ? Math.max(0, Math.min(100, (1 - nowNative / premNative) * 100)) : 0;
    const side = r.right === 'P' ? 'SHORT PUT' : 'SHORT CALL';
    const sideCls = r.right === 'P'
      ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
      : 'bg-purple-500/15 text-purple-300 border-purple-500/30';
    const undStr = undPrice != null
      ? `${fmt(undPrice, undPrice > 100 ? 2 : 2)} / ${fmt(strike, 2)}`
      : `— / ${fmt(strike, 2)}`;

    return `<tr class="hover:bg-panelHover/50">
      <td>
        <div class="font-bold text-white">${esc(r.display)}</div>
        <div class="text-[11px] text-muted">${esc(r.broker)} · 乘數 ${r.multiplier}</div>
      </td>
      <td>
        <span class="px-1.5 py-0.5 rounded border text-[10px] ${sideCls}">${side}</span>
        <div class="text-[11px] text-muted mt-0.5">${esc(r.expiry || '')}</div>
      </td>
      <td class="text-right">
        <div class="text-gray-200">${undStr}</div>
        <div class="text-[11px]">${moneyness}</div>
      </td>
      <td class="text-right font-num">${fmt(premNative, 0)} → ${fmt(nowNative, 0)}</td>
      <td class="text-right font-num font-bold ${clsPL(r.plHKD || 0)}">${signed(r.plHKD, 0)}</td>
      <td>
        <div class="flex justify-between text-[11px] mb-1"><span>已賺 ${fmt(recovered, 0)}%</span></div>
        <div class="w-full bg-gray-800 rounded-full h-1.5"><div class="bg-emerald-500 h-1.5 rounded-full" style="width:${recovered.toFixed(0)}%"></div></div>
      </td>
      <td class="text-right text-[11px] text-muted">${r.live ? '即時' : '快照'} · ${esc(r.via || '')}</td>
    </tr>`;
  }).join('');
}

function renderAll() {
  const c = compute();
  renderStatus(c);
  renderKPIs(c);
  renderHoldings(c);
  renderOptions(c);
}

async function mapPool(items, limit, fn) {
  const ret = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      ret[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return ret;
}

async function refreshQuotes() {
  if (state.refreshing) return;
  state.refreshing = true;
  const btn = $('refreshBtn');
  if (btn) btn.disabled = true;
  try {
    await getFx();
    // unique quote keys
    const targets = [];
    const seen = new Set();
    for (const h of state.holdings) {
      const key = h.yahoo || h.id;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(h);
    }
    // also fetch underlyings for options
    for (const h of state.holdings) {
      if (h.underlying && !seen.has(h.underlying)) {
        seen.add(h.underlying);
        targets.push({
          id: 'und-' + h.underlying,
          yahoo: h.underlying,
          tencent: h.underlying.endsWith('.HK')
            ? 'hk' + h.underlying.replace('.HK', '').padStart(5, '0')
            : (h.underlying.includes('.') ? null : 'us' + h.underlying),
          seedPrice: 0,
        });
      }
    }

    let ok = 0, fail = 0;
    await mapPool(targets, BATCH, async (h) => {
      const key = h.yahoo || h.id;
      try {
        const q = await getQuoteForHolding(h);
        state.quotes[key] = { ...q, ts: Date.now() };
        if (!q._seed) ok++; else fail++;
      } catch (_) {
        fail++;
        if (h.seedPrice > 0 && !state.quotes[key]) {
          state.quotes[key] = {
            price: h.seedPrice, prevClose: h.seedPrice, change: 0, changePct: 0, _via: '券商快照', _seed: true, ts: Date.now(),
          };
        }
      }
    });
    state.quoteOk = ok;
    state.quoteFail = fail;
    state.lastQuoteAt = new Date();
    renderAll();
  } finally {
    state.refreshing = false;
    if (btn) btn.disabled = false;
  }
}

let timer = null;
function startAuto() {
  stopAuto();
  state.auto = true;
  timer = setInterval(() => { if (state.auto) refreshQuotes(); }, REFRESH_MS);
  updateToggleUI();
}
function stopAuto() {
  if (timer) clearInterval(timer);
  timer = null;
}
function toggleAuto() {
  state.auto = !state.auto;
  if (state.auto) startAuto();
  else { stopAuto(); updateToggleUI(); }
  renderStatus(compute());
}
function updateToggleUI() {
  const dot = $('simDot'), text = $('simText'), btn = $('simToggleBtn');
  if (!btn) return;
  if (state.auto) {
    if (dot) dot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping';
    if (text) text.textContent = '報價自動刷新: 開啟';
    btn.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 transition text-xs font-medium cursor-pointer';
  } else {
    if (dot) dot.className = 'w-1.5 h-1.5 rounded-full bg-gray-500';
    if (text) text.textContent = '報價自動刷新: 暫停';
    btn.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded bg-gray-800 border border-gray-700 text-gray-400 hover:bg-gray-700 transition text-xs font-medium cursor-pointer';
  }
}

window.filterHoldings = function(type, btn) {
  state.filter = type;
  if (btn) {
    const tabs = btn.parentElement.children;
    for (let i = 0; i < tabs.length; i++) tabs[i].className = 'tab-btn tab-inactive shrink-0';
    btn.className = 'tab-btn tab-active shrink-0';
  }
  renderHoldings(compute());
};
window.handleSearchHoldings = function() {
  state.search = ($('holdingSearch')?.value) || '';
  renderHoldings(compute());
};
window.toggleRealtimeSim = toggleAuto;
window.refreshQuotesNow = () => refreshQuotes();

async function boot() {
  try {
    const data = await fetchJSON('holdings.json?t=' + Date.now(), 10000);
    state.holdings = data.holdings || [];
    state.cash = data.cash || {};
    state.syncedAt = data.syncedAt || '';
    if (data.fxSeed) Object.assign(state.fx, data.fxSeed);
    const sub = $('subtitleCount');
    if (sub) {
      const n = state.holdings.filter(h => h.type !== 'OPT').length;
      const o = state.holdings.filter(h => h.type === 'OPT').length;
      sub.textContent = `${n} 項證券持倉 + ${o} 期權 | 富途證券・富途加密・IBKR · 報價瀏覽器即時`;
    }
    renderAll();
    await refreshQuotes();
    startAuto();
  } catch (e) {
    console.error(e);
    const mode = $('liveModeLabel');
    if (mode) mode.textContent = '無法載入 holdings.json: ' + e.message;
  }
}

boot();
})();
