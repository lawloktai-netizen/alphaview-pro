/*! Ricky's Investment — browser LIVE quotes (Yahoo + Tencent). Position snapshot loaded only after unlock. */
(() => {
'use strict';

const PASS_HASH = '21f3dc4db237caf55464ec97e07ecf20d5031b8e3a934436d00651b1e4b02614';
const SESSION_KEY = 'ricky_invest_unlocked_v1';
const HOLDINGS_URL = 'data/snap_a7f3e9c2.json';
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
  quotes: {}, // key -> {price, prevClose, changePct, via, ts, failed?}
  filter: 'All',
  search: '',
  sortKey: 'mvHKD',
  sortDir: 'desc',
  auto: true,
  lastQuoteAt: null,
  quoteOk: 0,
  quoteFail: 0,
  refreshing: false,
  quotesReady: false,
  unlocked: false,
  selectedId: null,
  prevPrices: {},
};

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (v, d = 0) => {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
};
const signed = (v, d = 0) => {
  if (v == null || !Number.isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + fmt(v, d);
};
const clsPL = v => (v > 0.5 ? 'text-up' : v < -0.5 ? 'text-down' : 'text-gray-300');
const badgePL = v => (v > 0.5 ? 'badge-up' : v < -0.5 ? 'badge-down' : 'badge-neutral');

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function showApp() {
  const gate = $('accessGate');
  const shell = $('appShell');
  if (gate) gate.style.display = 'none';
  if (shell) {
    // display:contents so sticky header / flex body layout stay intact
    shell.style.display = 'contents';
  }
}

function setupGate() {
  if (sessionStorage.getItem(SESSION_KEY) === PASS_HASH) {
    state.unlocked = true;
    showApp();
    boot();
    return;
  }
  const form = $('gateForm');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('gatePassword');
    const err = $('gateError');
    const btn = form.querySelector('button[type="submit"]');
    const pwd = (input && input.value) || '';
    if (btn) { btn.disabled = true; btn.textContent = '核對中…'; }
    try {
      const h = await sha256Hex(pwd);
      if (h === PASS_HASH) {
        sessionStorage.setItem(SESSION_KEY, PASS_HASH);
        state.unlocked = true;
        if (err) err.classList.add('hidden');
        showApp();
        boot();
      } else {
        if (err) err.classList.remove('hidden');
        if (input) { input.value = ''; input.focus(); }
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '解鎖儀表板'; }
    }
  });
}

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

async function coinGeckoBtc() {
  const urls = [
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true',
  ];
  for (const u of urls) {
    try {
      const j = await fetchJSON(u, 6000);
      const b = j && j.bitcoin;
      if (b && b.usd > 0) {
        const chg = (b.usd_24h_change || 0) / 100;
        const price = b.usd;
        const prevClose = chg !== -1 ? price / (1 + chg) : price;
        return { price, prevClose, change: price - prevClose, changePct: chg, _via: 'CoinGecko' };
      }
    } catch (_) {}
  }
  // cors proxies for coingecko
  for (const [n, f] of PUBLIC_PROXIES) {
    try {
      const j = await fetchJSON(f(urls[0]), 7000);
      const b = j && j.bitcoin;
      if (b && b.usd > 0) {
        const chg = (b.usd_24h_change || 0) / 100;
        const price = b.usd;
        const prevClose = price / (1 + chg);
        return { price, prevClose, change: price - prevClose, changePct: chg, _via: 'CoinGecko/' + n };
      }
    } catch (_) {}
  }
  throw new Error('BTC fail');
}

async function getQuoteForHolding(h) {
  // BTC: Yahoo BTC-USD then CoinGecko
  if (h.market === 'BTC' || h.quoteKind === 'crypto' || (h.yahoo && /^BTC-/i.test(h.yahoo))) {
    const syms = [h.yahoo || 'BTC-USD', 'BTC-USD', 'BTCUSD=X'];
    for (const sym of syms) {
      if (!sym) continue;
      try {
        const q = await yahooQuote(sym);
        if (q.price > 0) return q;
      } catch (_) {}
    }
    try { return await coinGeckoBtc(); } catch (_) {}
  }

  if (h.yahoo) {
    try {
      const q = await yahooQuote(h.yahoo);
      if (q.price > 0) return q;
    } catch (_) {}
  }
  if (h.tencent) {
    try {
      return await tencentQuote(h.tencent);
    } catch (_) {}
  }
  // JP ETFs sometimes need bare code
  if (h.yahoo && /\.T$/.test(h.yahoo)) {
    try {
      const q = await yahooQuote(h.yahoo.replace('.T', '.T'));
      if (q.price > 0) return q;
    } catch (_) {}
  }
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
  const failed = !!(q && q._failed);
  const seedOk = h.seedPrice > 0;
  const price = q && q.price > 0 ? q.price : (seedOk ? h.seedPrice : null);
  const prevClose = q && q.prevClose > 0 ? q.prevClose : (price != null ? price : null);
  const live = !!(q && !q._seed && !q._failed && q.price > 0);
  const fx = fxToHKD(h.currency);
  const mult = h.multiplier || 1;
  const qty = h.qty;
  const cost = h.cost || 0;
  const mvNative = price != null ? price * qty * mult : null;
  const mvHKD = mvNative != null ? mvNative * fx : null;
  const costNative = cost * qty * mult;
  const costHKD = costNative * fx;
  let plHKD = null;
  if (!(h.costUnknown || (!(cost > 0) && h.quoteKind === 'crypto')) && price != null) {
    plHKD = (price - cost) * qty * mult * fx;
  }
  const todayHKD = (price != null && prevClose != null) ? (price - prevClose) * qty * mult * fx : 0;
  const changePct = (price != null && prevClose) ? (price - prevClose) / prevClose : null;
  return {
    ...h,
    price,
    prevClose,
    live,
    failed: failed || (price == null),
    via: q ? q._via : (seedOk ? 'seed' : '—'),
    fx,
    mvNative,
    mvHKD: mvHKD == null ? 0 : mvHKD,
    mvHKDRaw: mvHKD,
    costHKD,
    plHKD,
    todayHKD,
    changePct,
    quoteTs: q ? q.ts : null,
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
  let optPremium = 0;
  let optPl = 0;
  let optToday = 0;
  let optOpen = 0;

  for (const r of rows) {
    mv += r.mvHKD || 0;
    if (r.plHKD != null) {
      pl += r.plHKD;
      costBasis += Math.abs(r.costHKD);
    }
    today += r.todayHKD || 0;
    const bucket = r.type === 'OPT' ? 'OPT'
      : r.market === 'JP' ? 'JP'
      : r.market === 'BTC' ? 'BTC'
      : (attr[r.type] != null ? r.type : 'Other');
    attr[bucket] = (attr[bucket] || 0) + (r.todayHKD || 0);

    if (r.type === 'OPT') {
      optOpen++;
      const prem = Math.abs((r.cost || 0) * r.qty * (r.multiplier || 1) * r.fx);
      optPremium += prem;
      if (r.plHKD != null) optPl += r.plHKD;
      optToday += r.todayHKD || 0;
    }
  }

  const cash = cashHKD();
  const net = cash + mv;
  const plPct = costBasis > 0 ? pl / costBasis : 0;
  const todayPct = (net - today) !== 0 ? today / (net - today) : 0;

  return { rows, mv, pl, today, cash, net, plPct, todayPct, attr, optPremium, optPl, optToday, optOpen };
}

function updateLiveBadge() {
  const badge = $('liveBadge');
  if (!badge) return;
  if (!state.quotesReady) {
    badge.textContent = '同步中';
    badge.className = 'text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20';
  } else {
    badge.textContent = '報價即時';
    badge.className = 'text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
  }
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
    if (!state.quotesReady) {
      mode.textContent = `報價同步中 · 持倉上次同步 ${state.syncedAt || '—'}`;
    } else {
      mode.textContent = state.auto
        ? `報價即時 · 持倉上次同步 ${state.syncedAt || '—'}`
        : `報價已暫停 · 持倉上次同步 ${state.syncedAt || '—'}`;
    }
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
    qStat.textContent = state.quotesReady
      ? `報價成功 ${state.quoteOk} · 失敗 ${state.quoteFail}`
      : '報價拉取中…';
  }
  updateLiveBadge();
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

  set('optPremium', signed(c.optPremium, 0), 'text-emerald-400 font-num');
  const optOpen = $('optOpenCount');
  if (optOpen) optOpen.textContent = '· ' + c.optOpen + ' 張未平倉';

  const lev = $('ibkrLeverage');
  if (lev && state.cash) lev.textContent = (state.cash.ibkrLeverage || 0.98).toFixed(2) + 'x';

  const diff = $('netAssetDiff');
  if (diff) {
    // Never show quote count as P&L — clarify as quote status only after ready
    if (!state.quotesReady) {
      diff.textContent = '拉取中';
      diff.className = 'text-[10px] text-amber-400 font-num';
    } else {
      diff.textContent = '報價就緒';
      diff.className = 'text-[10px] text-emerald-400 font-num';
    }
  }

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

  const ibkrMV = c.rows.filter(r => r.broker === 'IBKR').reduce((a, r) => a + (r.mvHKD || 0), 0);
  const ibkrCash = (state.cash?.ibkrCash || []).reduce((a, x) => a + Number(x.amount) * fxToHKD(x.currency), 0);
  const btcRow = c.rows.find(r => r.market === 'BTC');
  const futuCash = Number(state.cash?.futuSecuritiesCashHKD || 0) + Number(state.cash?.futuFundsAssetsHKD || 0)
    + (state.cash?.futuCryptoCash || []).reduce((a, x) => a + Number(x.amount) * fxToHKD(x.currency), 0);

  set('futuNet', fmt(futuCash + c.rows.filter(r => r.broker === 'Futu').reduce((a, r) => a + (r.mvHKD || 0), 0), 0));
  set('ibkrNet', fmt(ibkrCash + ibkrMV, 0));
  const btcCash = (state.cash?.futuCryptoCash || []).reduce((a, x) => a + Number(x.amount) * fxToHKD(x.currency), 0);
  set('btcNet', fmt((btcRow?.mvHKD || 0) + btcCash, 0));
  const btcTodayVal = btcRow?.todayHKD || 0;
  set('btcToday', signed(btcTodayVal, 0), `font-bold font-num ${clsPL(btcTodayVal)}`);

  renderAllocation(c);
  renderWinnersLosers(c);
}

function renderAllocation(c) {
  const groups = {
    '收益型': 0, '現金': c.cash, '港股': 0, '美股': 0, '日本': 0, 'A股': 0, 'BTC': 0, '期權': 0,
  };
  const income = new Set(['PFN', 'PCN', 'TLT', 'JEPI', '03419', '02823', '02806']);
  for (const r of c.rows) {
    const absMv = Math.abs(r.mvHKD || 0);
    if (r.type === 'OPT') groups['期權'] += absMv;
    else if (r.market === 'BTC') groups['BTC'] += absMv;
    else if (r.market === 'JP') groups['日本'] += absMv;
    else if (r.type === 'A') groups['A股'] += absMv;
    else if (r.type === 'HK') groups['港股'] += absMv;
    else if (income.has(String(r.symbol).replace('.T', ''))) groups['收益型'] += absMv;
    else if (r.type === 'US') groups['美股'] += absMv;
    else groups['美股'] += absMv;
  }
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

function renderWinnersLosers(c) {
  const ranked = c.rows
    .filter(r => Number.isFinite(r.todayHKD))
    .slice()
    .sort((a, b) => b.todayHKD - a.todayHKD);
  const winners = ranked.filter(r => r.todayHKD > 0).slice(0, 5);
  const losers = ranked.filter(r => r.todayHKD < 0).sort((a, b) => a.todayHKD - b.todayHKD).slice(0, 5);

  const rowHtml = (r, emptyMsg) => {
    if (!r) return `<li class="text-muted">${emptyMsg}</li>`;
    return `<li class="flex items-center justify-between gap-2 py-1 border-b border-borderDark/40">
      <button type="button" class="text-left truncate text-gray-200 hover:text-white font-num" onclick="openHoldingDetail('${esc(r.id)}')" title="${esc(r.name)}">
        ${esc(r.display)} <span class="text-muted font-sans text-[10px]">${esc(r.name)}</span>
      </button>
      <span class="font-num shrink-0 ${clsPL(r.todayHKD)}">${signed(r.todayHKD, 0)}</span>
    </li>`;
  };

  const wEl = $('winnersList');
  const lEl = $('losersList');
  if (wEl) {
    wEl.innerHTML = winners.length
      ? winners.map(r => rowHtml(r)).join('')
      : rowHtml(null, state.quotesReady ? '暫無正貢獻' : '等待報價…');
  }
  if (lEl) {
    lEl.innerHTML = losers.length
      ? losers.map(r => rowHtml(r)).join('')
      : rowHtml(null, state.quotesReady ? '暫無負貢獻' : '等待報價…');
  }
}

function filteredRows(c) {
  let rows;
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
  return rows;
}

function sortRows(rows) {
  const key = state.sortKey;
  const dir = state.sortDir === 'asc' ? 1 : -1;
  const val = (r) => {
    if (key === 'display') return String(r.display || '').toLowerCase();
    if (key === 'changePct') return r.changePct == null || r.failed ? -Infinity : r.changePct;
    if (key === 'mvHKD') return Math.abs(r.mvHKD || 0);
    if (key === 'plHKD') return r.plHKD == null ? -Infinity : r.plHKD;
    if (key === 'todayHKD') return r.todayHKD || 0;
    return Math.abs(r.mvHKD || 0);
  };
  return rows.slice().sort((a, b) => {
    const va = val(a), vb = val(b);
    if (typeof va === 'string') return va < vb ? -dir : va > vb ? dir : 0;
    return (va - vb) * dir;
  });
}

function updateSortIndicators() {
  document.querySelectorAll('th.sortable').forEach(th => {
    const k = th.getAttribute('data-sort');
    const ind = th.querySelector('.sort-ind');
    const active = k === state.sortKey;
    th.classList.toggle('sort-active', active);
    if (ind) ind.textContent = active ? (state.sortDir === 'asc' ? '↑' : '↓') : '↕';
  });
}

function renderHoldings(c) {
  let rows = sortRows(filteredRows(c));
  const count = $('totalHoldingCount');
  if (count) count.textContent = String(rows.length);
  updateSortIndicators();

  const tbody = $('holdingsBody');
  if (!tbody) return;
  const net = c.net || 1;

  tbody.innerHTML = rows.map(r => {
    const flashed = state.prevPrices[r.id] != null && r.price != null && state.prevPrices[r.id] !== r.price;
    const chg = r.failed || r.changePct == null
      ? '<span class="px-2 py-0.5 rounded text-[10px] font-semibold badge-neutral" title="報價失敗或未更新">報價失敗</span>'
      : `<span class="px-2 py-0.5 rounded text-xs font-semibold ${badgePL(r.changePct)}">${signed(r.changePct * 100, 2)}%</span>`;
    const plStr = r.plHKD == null ? '—' : signed(r.plHKD, 0);
    const mvStr = r.mvHKDRaw == null ? '—' : fmt(r.mvHKD, 0);
    const liveDot = r.failed
      ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-rose-400 mr-1" title="報價失敗"></span>'
      : r.live
        ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1" title="即時報價"></span>'
        : '<span class="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 mr-1" title="券商快照"></span>';
    const priceStr = r.price == null ? '—' : fmt(r.price, r.price < 10 ? 3 : 2);
    return `<tr class="interactive-row ${flashed ? 'quote-flash' : ''}" data-id="${esc(r.id)}" onclick="openHoldingDetail('${esc(r.id)}')">
      <td>
        <div class="font-bold text-white font-num flex items-center">${liveDot}${esc(r.display)}</div>
        <div class="text-[11px] text-muted truncate max-w-[140px]">${esc(r.name)} · ${esc(r.broker)}</div>
      </td>
      <td class="text-right font-num whitespace-nowrap">
        <div class="font-semibold text-gray-100">${priceStr}</div>
        <div class="text-[10px] text-muted">${esc(r.currency)} × ${fmt(r.qty, r.qty % 1 ? 4 : 0)}</div>
      </td>
      <td class="text-right font-num whitespace-nowrap">${chg}</td>
      <td class="text-right font-num whitespace-nowrap">
        <div class="text-gray-100">${mvStr}</div>
        <div class="text-[10px] ${clsPL(r.plHKD || 0)}">${plStr}</div>
      </td>
    </tr>`;
  }).join('');

  // clear flash class after paint
  setTimeout(() => {
    tbody.querySelectorAll('.quote-flash').forEach(el => el.classList.remove('quote-flash'));
  }, 700);
}

function renderOptions(c) {
  const tbody = $('optionsBody');
  if (!tbody) return;
  const opts = c.rows.filter(r => r.type === 'OPT');
  tbody.innerHTML = opts.map(r => {
    let undPrice = null;
    const uSym = r.underlying;
    if (uSym) {
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
    const premNative = Math.abs((r.cost || 0) * r.qty * (r.multiplier || 1));
    const nowNative = r.price != null ? Math.abs(r.price * r.qty * (r.multiplier || 1)) : null;
    const recovered = premNative > 0 && nowNative != null
      ? Math.max(0, Math.min(100, (1 - nowNative / premNative) * 100)) : 0;
    const side = r.right === 'P' ? 'SHORT PUT' : 'SHORT CALL';
    const sideCls = r.right === 'P'
      ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
      : 'bg-purple-500/15 text-purple-300 border-purple-500/30';
    const undStr = undPrice != null
      ? `${fmt(undPrice, 2)} / ${fmt(strike, 2)}`
      : `— / ${fmt(strike, 2)}`;
    const quoteLabel = r.failed
      ? '<span class="text-rose-400">報價失敗</span>'
      : (r.live ? '即時' : '快照') + ' · ' + esc(r.via || '');
    const plCell = r.plHKD == null ? '—' : signed(r.plHKD, 0);

    return `<tr class="hover:bg-panelHover/50">
      <td class="whitespace-nowrap">
        <div class="font-bold text-white">${esc(r.display)}</div>
        <div class="text-[11px] text-muted">${esc(r.broker)} · 乘數 ${r.multiplier}</div>
      </td>
      <td class="whitespace-nowrap">
        <span class="px-1.5 py-0.5 rounded border text-[10px] ${sideCls}">${side}</span>
        <div class="text-[11px] text-muted mt-0.5">${esc(r.expiry || '')}</div>
      </td>
      <td class="text-right whitespace-nowrap">
        <div class="text-gray-200">${undStr}</div>
        <div class="text-[11px]">${moneyness}</div>
      </td>
      <td class="text-right font-num whitespace-nowrap">${fmt(premNative, 0)} → ${nowNative == null ? '—' : fmt(nowNative, 0)}</td>
      <td class="text-right font-num font-bold whitespace-nowrap ${clsPL(r.plHKD || 0)}">${plCell}</td>
      <td class="whitespace-nowrap">
        <div class="flex justify-between text-[11px] mb-1"><span>已賺 ${fmt(recovered, 0)}%</span></div>
        <div class="w-full bg-gray-800 rounded-full h-1.5"><div class="bg-emerald-500 h-1.5 rounded-full" style="width:${recovered.toFixed(0)}%"></div></div>
      </td>
      <td class="text-right text-[11px] text-muted whitespace-nowrap">${quoteLabel}</td>
    </tr>`;
  }).join('');
}

function renderAll() {
  const c = compute();
  renderStatus(c);
  renderKPIs(c);
  renderHoldings(c);
  renderOptions(c);
  if (state.selectedId) {
    // refresh open drawer numbers
    const overlay = $('detailOverlay');
    if (overlay && overlay.classList.contains('open')) fillDetail(c.rows.find(r => r.id === state.selectedId), c);
  }
}

function fillDetail(r, c) {
  if (!r) return;
  const net = (c && c.net) || compute().net || 1;
  $('detailTitle').textContent = r.display;
  $('detailSubtitle').textContent = `${r.name} · ${r.broker}`;
  const pctPort = r.mvHKDRaw == null ? '—' : ((Math.abs(r.mvHKD) / net) * 100).toFixed(2) + '%';
  const updated = r.quoteTs
    ? new Date(r.quoteTs).toLocaleString('zh-HK', { hour12: false })
    : '—';
  const rows = [
    ['代碼', r.display],
    ['名稱', r.name],
    ['券商', r.broker],
    ['市場 / 類型', `${r.market || '—'} / ${r.type || '—'}`],
    ['數量', fmt(r.qty, r.qty % 1 ? 6 : 0)],
    ['幣種', r.currency],
    ['成本', r.costUnknown ? '未知' : fmt(r.cost, r.cost < 10 ? 4 : 2)],
    ['現價', r.price == null ? '—' : fmt(r.price, r.price < 10 ? 4 : 2)],
    ['市值 (HKD)', r.mvHKDRaw == null ? '—' : fmt(r.mvHKD, 0)],
    ['未實現盈虧', r.plHKD == null ? '—' : `${signed(r.plHKD, 0)} HKD`],
    ['盈虧%', (r.plHKD != null && r.costHKD) ? signed((r.plHKD / Math.abs(r.costHKD)) * 100, 2) + '%' : '—'],
    ['今日盈虧 (HKD)', signed(r.todayHKD, 0)],
    ['日變%', r.changePct == null ? '—' : signed(r.changePct * 100, 2) + '%'],
    ['佔組合%', pctPort],
    ['報價來源', r.failed ? '報價失敗' : (r.via || '—')],
    ['上次報價', updated],
  ];
  $('detailBody').innerHTML = rows.map(([k, v]) => `
    <div class="flex justify-between gap-3 py-2 border-b border-borderDark/50">
      <span class="text-muted text-xs shrink-0">${esc(k)}</span>
      <span class="text-gray-100 text-right font-num text-xs break-all">${esc(String(v))}</span>
    </div>`).join('');
}

window.openHoldingDetail = function(id) {
  state.selectedId = id;
  const c = compute();
  const r = c.rows.find(x => x.id === id);
  if (!r) return;
  fillDetail(r, c);
  const overlay = $('detailOverlay');
  if (overlay) overlay.classList.add('open');
};
window.closeHoldingDetail = function() {
  state.selectedId = null;
  const overlay = $('detailOverlay');
  if (overlay) overlay.classList.remove('open');
};

window.sortHoldings = function(key) {
  if (state.sortKey === key) {
    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    state.sortKey = key;
    state.sortDir = key === 'display' ? 'asc' : 'desc';
  }
  renderHoldings(compute());
};

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
  if (!state.unlocked || state.refreshing) return;
  state.refreshing = true;
  const btn = $('refreshBtn');
  if (btn) btn.disabled = true;
  try {
    // snapshot previous prices for flash
    const before = {};
    for (const h of state.holdings) {
      const key = h.yahoo || h.id;
      const q = state.quotes[key];
      if (q && q.price > 0) before[h.id] = q.price;
    }

    await getFx();
    const targets = [];
    const seen = new Set();
    for (const h of state.holdings) {
      const key = h.yahoo || h.id;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(h);
    }
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
        if (!(q.price > 0) && !q._seed) throw new Error('zero');
        state.quotes[key] = { ...q, ts: Date.now() };
        if (!q._seed) ok++; else fail++;
      } catch (_) {
        fail++;
        if (h.seedPrice > 0) {
          state.quotes[key] = {
            price: h.seedPrice, prevClose: h.seedPrice, change: 0, changePct: 0,
            _via: '券商快照', _seed: true, ts: Date.now(),
          };
        } else {
          state.quotes[key] = {
            price: 0, prevClose: 0, change: 0, changePct: 0,
            _via: '失敗', _failed: true, ts: Date.now(),
          };
        }
      }
    });
    state.quoteOk = ok;
    state.quoteFail = fail;
    state.lastQuoteAt = new Date();
    state.quotesReady = true;
    state.prevPrices = before;
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
  const sys = $('systemDot');
  if (!btn) return;
  if (state.auto) {
    if (dot) dot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-400';
    if (text) text.textContent = '報價自動刷新: 開啟';
    btn.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 transition text-xs font-medium cursor-pointer';
    if (sys) sys.className = 'status-dot live-pulse';
  } else {
    if (dot) dot.className = 'w-1.5 h-1.5 rounded-full bg-gray-500';
    if (text) text.textContent = '報價自動刷新: 暫停';
    btn.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded bg-gray-800 border border-gray-700 text-gray-400 hover:bg-gray-700 transition text-xs font-medium cursor-pointer';
    if (sys) sys.className = 'status-dot paused';
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
  if (!state.unlocked) return;
  try {
    const data = await fetchJSON(HOLDINGS_URL + '?t=' + Date.now(), 10000);
    if (data.error) throw new Error(data.message || 'locked');
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
    if (mode) mode.textContent = '無法載入持倉快照: ' + e.message;
  }
}

setupGate();
})();
