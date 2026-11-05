/*! Ricky's Investment — holdings P&L from Futu/IBKR broker snapshot on page load; TradingView widgets stay live. */
(() => {
'use strict';

const PASS_HASH = '21f3dc4db237caf55464ec97e07ecf20d5031b8e3a934436d00651b1e4b02614';
const SESSION_KEY = 'ricky_invest_unlocked_v2';
const HOLDINGS_URL = 'data/snap_a7f3e9c2.json';
const REPORTS_INDEX_URL = 'reports/index.json';
const SYNC_TRIGGER_LS_KEY = 'alphaview.syncTrigger';
const SYNC_TRIGGER_FILE = 'data/sync-trigger.json';
const BROKER_SYNC_TIMEOUT_MS = 140000;
const BROKER_SYNC_POLL_MS = 4000;
const PAGES_HOST = 'lawloktai-netizen.github.io';
const PUBLIC_PROXIES = [
  // corsproxy.io keyless requires API key now — omitted
  ['allorigins', u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u)],
  ['codetabs', u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u)],
  ['corslol', u => 'https://api.cors.lol/?url=' + encodeURIComponent(u)],
];
const REFRESH_MS = 45000;
const BATCH = 6;

const state = {
  holdings: [],
  cash: null,
  syncedAt: '',
  syncedAtISO: '',
  brokerSyncing: false,
  syncPhase: 'idle',
  fx: { USDHKD: 7.8447, CNYHKD: 1.177, JPYHKD: 0.04968 },
  quotes: {}, // key -> {price, prevClose, changePct, via, ts, failed?}
  filter: 'All',
  search: '',
  sortKey: 'mvHKD',
  sortDir: 'desc',
  auto: false, // holdings use broker snapshot; no continuous Yahoo poll
  lastQuoteAt: null,
  quoteOk: 0,
  quoteFail: 0,
  refreshing: false,
  quotesReady: false,
  unlocked: false,
  selectedId: null,
  prevPrices: {},
  view: 'portfolio',
  reports: [],
  activeReportId: null,
  reportsLoaded: false,
  charts: { nav: null, alloc: null, wl: null, sparks: {} },
  indexSeries: {},
  navSeries: null,
  chartBusy: false,
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
const clsPL = v => (v > 0.5 ? 'text-up' : v < -0.5 ? 'text-down' : 'text-slate-600');
const badgePL = v => (v > 0.5 ? 'badge-up' : v < -0.5 ? 'badge-down' : 'badge-neutral');

async function sha256Hex(text) {
  const normalized = String(text ?? '').normalize('NFKC').trim();
  if (globalThis.crypto && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  throw new Error('secure-hash-unavailable');
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
        if (err) { err.classList.add('hidden'); err.textContent = '密碼不正確，請再試。'; }
        showApp();
        boot();
      } else {
        if (err) { err.textContent = '密碼不正確，請再試。'; err.classList.remove('hidden'); }
        if (input) { input.value = ''; input.focus(); }
      }
    } catch (ex) {
      if (err) { err.textContent = '此瀏覽器無法驗證密碼，請用最新 Chrome／Safari（需 HTTPS）。'; err.classList.remove('hidden'); }
      console.error(ex);
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchSnap(ms = 10000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(HOLDINGS_URL + '?t=' + Date.now(), { cache: 'no-store', signal: c.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function holdingsSubtitle() {
  const n = state.holdings.filter(h => h.type !== 'OPT').length;
  const o = state.holdings.filter(h => h.type === 'OPT').length;
  return `${n} 項證券持倉 + ${o} 期權 | 富途證券・富途加密・IBKR · 券商快照價`;
}

function applySnapPayload(data) {
  if (!data || data.error) return false;
  if (Array.isArray(data.holdings)) state.holdings = data.holdings;
  if (data.cash) state.cash = data.cash;
  if (data.syncedAt) state.syncedAt = String(data.syncedAt);
  if (data.syncedAtISO) state.syncedAtISO = String(data.syncedAtISO);
  if (data.fxSeed) Object.assign(state.fx, data.fxSeed);
  const sub = $('subtitleCount');
  if (sub) sub.textContent = holdingsSubtitle();
  return true;
}

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

async function yahooQuote(sym, opts = {}) {
  // range=1d is smaller/faster through flaky CORS proxies (JP .T especially).
  const range = opts.range || '1d';
  const skipDirect = !!opts.skipDirect;
  const path = `/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d`;
  const direct = ['https://query1.finance.yahoo.com' + path, 'https://query2.finance.yahoo.com' + path];
  if (!skipDirect) {
    for (const u of direct) {
      try { return { ...parseYahooChart(await fetchJSON(u, 2500)), _via: 'Yahoo直連' }; } catch (_) {}
    }
  }
  const urls = [];
  for (const base of direct) {
    for (const [n, f] of PUBLIC_PROXIES) urls.push([n, f(base)]);
  }
  return Promise.any(urls.map(async ([n, u]) => ({ ...parseYahooChart(await fetchJSON(u, 10000)), _via: 'Yahoo/' + n })))
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

function brokerSeedQuote(h) {
  const price = Number(h.seedPrice);
  if (!(price > 0)) return null;
  let prevClose = price;
  let change = 0;
  let changePct = 0;
  const qty = Number(h.qty);
  const mult = Number(h.multiplier) || 1;
  const todayPl = Number(h.seedTodayPl);
  if (Number.isFinite(qty) && qty !== 0 && Number.isFinite(todayPl) && todayPl !== 0) {
    change = todayPl / (qty * mult);
    prevClose = price - change;
    changePct = prevClose ? change / prevClose : 0;
  }
  return {
    price,
    prevClose,
    change,
    changePct,
    _via: '券商快照',
    _seed: true,
  };
}

function applyBrokerSnapshotQuotes() {
  let ok = 0, miss = 0;
  for (const h of state.holdings) {
    const key = h.yahoo || h.id;
    const q = brokerSeedQuote(h);
    if (q) {
      state.quotes[key] = { ...q, ts: Date.now() };
      ok++;
    } else {
      miss++;
    }
  }
  state.quoteOk = ok;
  state.quoteFail = miss;
  state.lastQuoteAt = new Date();
  state.quotesReady = true;
  return { ok, miss };
}

async function getQuoteForHolding(h) {
  // Prefer Futu/IBKR broker snapshot baked into holdings JSON (page-load path).
  const seed = brokerSeedQuote(h);
  if (seed) return seed;

  // Soft fallback only when snapshot has no price (e.g. crypto with costUnknown).
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
    badge.className = 'text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200';
  } else {
    badge.textContent = '券商快照';
    badge.className = 'text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200';
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
      mode.textContent = `載入券商快照中 · 同步 ${state.syncedAt || '—'}`;
    } else {
      mode.textContent = `持倉券商快照 · 同步 ${state.syncedAt || '—'}`;
    }
  }
  const fxBar = $('fxBar');
  if (fxBar) {
    fxBar.innerHTML = `
      <span>USD/HKD <strong class="text-slate-800">${state.fx.USDHKD.toFixed(4)}</strong></span>
      <span>CNY/HKD <strong class="text-slate-800">${state.fx.CNYHKD.toFixed(4)}</strong></span>
      <span>JPY/HKD <strong class="text-slate-800">${state.fx.JPYHKD.toFixed(5)}</strong></span>`;
  }
  const qStat = $('quoteStat');
  if (qStat) {
    qStat.textContent = state.quotesReady
      ? `快照價 ${state.quoteOk} · 缺價 ${state.quoteFail}`
      : '載入快照中…';
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

  set('optPremium', signed(c.optPremium, 0), 'text-emerald-700 font-num');
  const optOpen = $('optOpenCount');
  if (optOpen) optOpen.textContent = '· ' + c.optOpen + ' 張未平倉';

  const lev = $('ibkrLeverage');
  if (lev && state.cash) lev.textContent = (state.cash.ibkrLeverage || 0.98).toFixed(2) + 'x';

  const diff = $('netAssetDiff');
  if (diff) {
    // Never show quote count as P&L — clarify as quote status only after ready
    if (!state.quotesReady) {
      diff.textContent = '拉取中';
      diff.className = 'text-[10px] text-amber-700 font-num';
    } else {
      diff.textContent = '報價就緒';
      diff.className = 'text-[10px] text-emerald-700 font-num';
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
        <span class="flex items-center gap-1.5 text-slate-700"><span class="w-2 h-2 rounded-sm ${colors[k]}"></span>${esc(k)}</span>
        <span class="text-ink font-semibold">${pct}% <span class="text-muted text-[10px]">(${fmt(v / 1000, 0)}k)</span></span>
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
      <button type="button" class="text-left truncate text-slate-800 hover:text-ink font-num" onclick="openHoldingDetail('${esc(r.id)}')" title="${esc(r.name)}">
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
        <div class="font-bold text-ink font-num flex items-center">${liveDot}${esc(r.display)}</div>
        <div class="text-[11px] text-muted truncate max-w-[140px]">${esc(r.name)} · ${esc(r.broker)}</div>
      </td>
      <td class="text-right font-num whitespace-nowrap">
        <div class="font-semibold text-slate-800">${priceStr}</div>
        <div class="text-[10px] text-muted">${esc(r.currency)} × ${fmt(r.qty, r.qty % 1 ? 4 : 0)}</div>
      </td>
      <td class="text-right font-num whitespace-nowrap">${chg}</td>
      <td class="text-right font-num whitespace-nowrap">
        <div class="text-slate-800">${mvStr}</div>
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
          ? `<span class="text-emerald-700">價外 ${signed(-pct, 1)}%</span>`
          : `<span class="text-amber-700">價內 ${signed(pct, 1)}%</span>`;
      } else {
        moneyness = pct > 0
          ? `<span class="text-emerald-700">價外 ${signed(pct, 1)}%</span>`
          : `<span class="text-amber-700">價內 ${signed(-pct, 1)}%</span>`;
      }
    }
    const premNative = Math.abs((r.cost || 0) * r.qty * (r.multiplier || 1));
    const nowNative = r.price != null ? Math.abs(r.price * r.qty * (r.multiplier || 1)) : null;
    const recovered = premNative > 0 && nowNative != null
      ? Math.max(0, Math.min(100, (1 - nowNative / premNative) * 100)) : 0;
    const side = r.right === 'P' ? 'SHORT PUT' : 'SHORT CALL';
    const sideCls = r.right === 'P'
      ? 'bg-amber-50 text-amber-800 border-amber-200'
      : 'bg-purple-50 text-purple-800 border-purple-200';
    const undStr = undPrice != null
      ? `${fmt(undPrice, 2)} / ${fmt(strike, 2)}`
      : `— / ${fmt(strike, 2)}`;
    const quoteLabel = r.failed
      ? '<span class="text-rose-700">報價失敗</span>'
      : (r.live ? '即時' : '快照') + ' · ' + esc(r.via || '');
    const plCell = r.plHKD == null ? '—' : signed(r.plHKD, 0);

    return `<tr class="hover:bg-panelHover/50">
      <td class="whitespace-nowrap">
        <div class="font-bold text-ink">${esc(r.display)}</div>
        <div class="text-[11px] text-muted">${esc(r.broker)} · 乘數 ${r.multiplier}</div>
      </td>
      <td class="whitespace-nowrap">
        <span class="px-1.5 py-0.5 rounded border text-[10px] ${sideCls}">${side}</span>
        <div class="text-[11px] text-muted mt-0.5">${esc(r.expiry || '')}</div>
      </td>
      <td class="text-right whitespace-nowrap">
        <div class="text-slate-800">${undStr}</div>
        <div class="text-[11px]">${moneyness}</div>
      </td>
      <td class="text-right font-num whitespace-nowrap">${fmt(premNative, 0)} → ${nowNative == null ? '—' : fmt(nowNative, 0)}</td>
      <td class="text-right font-num font-bold whitespace-nowrap ${clsPL(r.plHKD || 0)}">${plCell}</td>
      <td class="whitespace-nowrap">
        <div class="flex justify-between text-[11px] mb-1"><span>已賺 ${fmt(recovered, 0)}%</span></div>
        <div class="w-full bg-slate-200 rounded-full h-1.5"><div class="bg-emerald-600 h-1.5 rounded-full" style="width:${recovered.toFixed(0)}%"></div></div>
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
  updateLiveCharts(c);
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
      <span class="text-slate-800 text-right font-num text-xs break-all">${esc(String(v))}</span>
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
  if (btn && !state.brokerSyncing) btn.disabled = true;
  try {
    const before = {};
    for (const h of state.holdings) {
      const key = h.yahoo || h.id;
      const q = state.quotes[key];
      if (q && q.price > 0) before[h.id] = q.price;
    }

    // Re-load broker snapshot (cache-busted) so refresh stays point-in-time.
    try {
      const data = await fetchSnap(10000);
      applySnapPayload(data);
    } catch (_) {}

    await getFx();
    applyBrokerSnapshotQuotes();

    // Soft fallback only for names still missing a broker price.
    const missing = state.holdings.filter(h => {
      const key = h.yahoo || h.id;
      const q = state.quotes[key];
      return !(q && q.price > 0);
    });
    if (missing.length) {
      await mapPool(missing, BATCH, async (h) => {
        const key = h.yahoo || h.id;
        try {
          const q = await getQuoteForHolding(h);
          if (q && q.price > 0) {
            state.quotes[key] = { ...q, ts: Date.now() };
            if (!q._seed) state.quoteOk++;
          }
        } catch (_) {
          state.quotes[key] = {
            price: 0, prevClose: 0, change: 0, changePct: 0,
            _via: '失敗', _failed: true, ts: Date.now(),
          };
          state.quoteFail++;
        }
      });
    }

    state.prevPrices = before;
    renderAll();
    refreshChartSeries();
  } finally {
    state.refreshing = false;
    if (btn && !state.brokerSyncing) btn.disabled = false;
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
    if (text) text.textContent = '自動補拉缺價: 開啟';
    btn.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded bg-emerald-50 border border-emerald-200 text-emerald-800 hover:bg-emerald-100 transition text-xs font-medium cursor-pointer';
    if (sys) sys.className = 'status-dot live-pulse';
  } else {
    if (dot) dot.className = 'w-1.5 h-1.5 rounded-full bg-gray-500';
    if (text) text.textContent = '自動補拉缺價: 關閉';
    btn.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-100 border border-slate-300 text-slate-600 hover:bg-slate-200 transition text-xs font-medium cursor-pointer';
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

/* ===== On-demand Futu/IBKR sync (webhook routine → poll snap → apply snapshot) ===== */

function syncStampFrom(data) {
  return {
    at: data && data.syncedAt != null ? String(data.syncedAt) : '',
    iso: data && data.syncedAtISO != null ? String(data.syncedAtISO) : '',
  };
}

function currentSyncStamp() {
  return { at: state.syncedAt || '', iso: state.syncedAtISO || '' };
}

function syncStampChanged(prev, next) {
  if (!next) return false;
  const prevIso = prev && prev.iso ? String(prev.iso) : '';
  const nextIso = next.iso ? String(next.iso) : '';
  const prevAt = prev && prev.at ? String(prev.at) : '';
  const nextAt = next.at ? String(next.at) : '';
  if (!nextIso && !nextAt) return false;
  if (nextIso && nextIso !== prevIso) {
    const a = Date.parse(prevIso);
    const b = Date.parse(nextIso);
    if (Number.isFinite(a) && Number.isFinite(b)) return b !== a;
    return true;
  }
  return !!(nextAt && nextAt !== prevAt);
}

function normalizeSyncTrigger(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = String(raw.url || '').trim();
  if (!url) return null;
  let parsed;
  try { parsed = new URL(url); } catch (_) { return null; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const headers = {};
  if (raw.headers && typeof raw.headers === 'object') {
    for (const [k, v] of Object.entries(raw.headers)) {
      if (!k || v == null) continue;
      const value = String(v).trim();
      if (value) headers[String(k)] = value;
    }
  }
  if (raw.headerName && raw.headerValue != null) {
    const name = String(raw.headerName).trim();
    const value = String(raw.headerValue).trim();
    if (name && value && !headers[name]) headers[name] = value;
  }
  const method = String(raw.method || 'POST').trim().toUpperCase() || 'POST';
  if (!['POST', 'PUT', 'GET'].includes(method)) return null;
  return { url, method, headers };
}

function readLocalSyncTrigger() {
  try {
    const raw = localStorage.getItem(SYNC_TRIGGER_LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

async function resolveSyncTrigger() {
  const local = normalizeSyncTrigger(readLocalSyncTrigger());
  if (local) return local;
  try {
    const data = await fetchJSON(SYNC_TRIGGER_FILE + '?t=' + Date.now(), 4000);
    return normalizeSyncTrigger(data);
  } catch (_) {
    return null;
  }
}

function bearerFromKey(key) {
  const k = String(key || '').trim();
  if (!k) return '';
  return /^bearer\s+/i.test(k) ? k : 'Bearer ' + k;
}

function keyFromStored(raw) {
  if (!raw || typeof raw !== 'object') return '';
  const headers = raw.headers && typeof raw.headers === 'object' ? raw.headers : null;
  let value = '';
  if (headers) value = headers.Authorization || headers.authorization || '';
  if (!value && String(raw.headerName || '').toLowerCase() === 'authorization') value = raw.headerValue || '';
  return String(value || '').trim().replace(/^bearer\s+/i, '');
}

let syncModalIntent = 'config';
let syncSuccessTimer = null;

function setModalError(msg) {
  const el = $('syncModalError');
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
}

function openSyncModal(intent) {
  syncModalIntent = intent === 'sync' ? 'sync' : 'config';
  const modal = $('syncModal');
  if (!modal) return;
  const raw = readLocalSyncTrigger();
  const norm = normalizeSyncTrigger(raw);
  const urlEl = $('syncWebhookUrl');
  const keyEl = $('syncSenderKey');
  const toggle = $('syncKeyToggle');
  if (urlEl) urlEl.value = norm ? norm.url : (raw && raw.url ? String(raw.url) : '');
  if (keyEl) {
    keyEl.value = keyFromStored(raw);
    keyEl.type = 'password';
  }
  if (toggle) toggle.textContent = '顯示';
  setModalError('');
  modal.hidden = false;
  if (urlEl) urlEl.focus();
}

function closeSyncModal() {
  const modal = $('syncModal');
  if (modal) modal.hidden = true;
  syncModalIntent = 'config';
}

function saveSyncModal(e) {
  if (e) e.preventDefault();
  const url = ($('syncWebhookUrl')?.value || '').trim();
  const key = ($('syncSenderKey')?.value || '').trim();
  if (!url || !key) {
    setModalError('請填寫 Webhook URL 同 Sender key。');
    return;
  }
  let parsed;
  try { parsed = new URL(url); } catch (_) { parsed = null; }
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    setModalError('Webhook URL 唔正確，請貼上完整 http(s) 網址。');
    return;
  }
  const prev = readLocalSyncTrigger() || {};
  const headers = {};
  if (prev.headers && typeof prev.headers === 'object') {
    for (const [k, v] of Object.entries(prev.headers)) {
      if (k && v != null && String(v).trim()) headers[k] = String(v);
    }
  }
  if (prev.headerName && prev.headerValue != null) {
    const name = String(prev.headerName).trim();
    const value = String(prev.headerValue).trim();
    if (name && value && !headers[name]) headers[name] = value;
  }
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'authorization') delete headers[k];
  }
  headers.Authorization = bearerFromKey(key);
  const method = String(prev.method || 'POST').trim().toUpperCase() || 'POST';
  const cfg = { url, method, headers };
  try {
    localStorage.setItem(SYNC_TRIGGER_LS_KEY, JSON.stringify(cfg));
  } catch (_) {
    setModalError('無法寫入瀏覽器儲存，請檢查是否封鎖 localStorage。');
    return;
  }
  const thenSync = syncModalIntent === 'sync';
  closeSyncModal();
  if (thenSync) requestBrokerSync();
}

function clearSyncConfig() {
  try { localStorage.removeItem(SYNC_TRIGGER_LS_KEY); } catch (_) {}
  const urlEl = $('syncWebhookUrl');
  const keyEl = $('syncSenderKey');
  if (urlEl) urlEl.value = '';
  if (keyEl) keyEl.value = '';
  setModalError('已清除呢部瀏覽器嘅設定。可以重新貼上。');
  syncModalIntent = 'config';
}

function setSyncUi(phase, detail) {
  state.syncPhase = phase;
  if (syncSuccessTimer) {
    clearTimeout(syncSuccessTimer);
    syncSuccessTimer = null;
  }
  const btn = $('refreshBtn');
  const gear = $('syncConfigBtn');
  const label = $('syncStatusLabel');
  const icon = $('syncIcon');
  if (btn) {
    btn.disabled = phase === 'syncing';
    btn.classList.toggle('is-syncing', phase === 'syncing');
    btn.classList.toggle('is-ok', phase === 'success');
    btn.classList.toggle('is-err', phase === 'error');
    btn.setAttribute('aria-busy', phase === 'syncing' ? 'true' : 'false');
    const aria = phase === 'syncing' ? '同步中…'
      : phase === 'success' ? '已更新'
      : phase === 'error' ? (detail || '同步失敗')
      : '更新券商持倉';
    btn.setAttribute('aria-label', aria);
  }
  if (gear) gear.disabled = phase === 'syncing';
  if (icon) icon.classList.toggle('sync-spin', phase === 'syncing');
  if (label) {
    label.classList.remove('is-sync', 'is-ok', 'is-err');
    if (phase === 'syncing') {
      label.textContent = '同步中…';
      label.classList.add('is-sync');
    } else if (phase === 'success') {
      label.textContent = '已更新';
      label.classList.add('is-ok');
    } else if (phase === 'error') {
      label.textContent = detail || '同步失敗';
      label.classList.add('is-err');
    } else {
      label.textContent = '';
    }
  }
  const mode = $('liveModeLabel');
  if (mode && phase === 'syncing') {
    mode.textContent = `同步中… · 持倉上次同步 ${state.syncedAt || '—'}`;
  }
}

function syncFailText(err) {
  const code = err && err.code;
  if (code === 'http') {
    const status = err.status;
    if (status === 401 || status === 403) return `同步失敗：金鑰被拒 (HTTP ${status})`;
    return `同步失敗：HTTP ${status}`;
  }
  if (code === 'timeout') return '同步失敗：連線逾時';
  return '同步失敗：跨域被拒或無法連線';
}

async function postSyncWebhook(cfg) {
  const headers = { Accept: 'application/json, text/plain, */*' };
  for (const [k, v] of Object.entries(cfg.headers || {})) headers[k] = v;
  const method = String(cfg.method || 'POST').toUpperCase();
  if (method !== 'GET' && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), BROKER_SYNC_TIMEOUT_MS);
  try {
    const r = await fetch(cfg.url, {
      method,
      mode: 'cors',
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers,
      body: method === 'GET' ? undefined : JSON.stringify({ source: 'alphaview', action: 'sync' }),
      signal: c.signal,
    });
    if (!r.ok) {
      const err = new Error('HTTP ' + r.status);
      err.code = 'http';
      err.status = r.status;
      throw err;
    }
    return true;
  } catch (e) {
    if (e && e.code === 'http') throw e;
    if (e && e.name === 'AbortError') {
      const err = new Error('timeout');
      err.code = 'timeout';
      throw err;
    }
    const err = new Error('network');
    err.code = 'network';
    throw err;
  } finally {
    clearTimeout(t);
  }
}

async function requestBrokerSync() {
  if (state.brokerSyncing || !state.unlocked) return;
  const cfg = await resolveSyncTrigger();
  if (!cfg) {
    openSyncModal('sync');
    return;
  }
  state.brokerSyncing = true;
  try {
  setSyncUi('syncing');
  const baseline = currentSyncStamp();
  const deadline = Date.now() + BROKER_SYNC_TIMEOUT_MS;
  let postResult = null;
  const postPromise = postSyncWebhook(cfg).then(
    () => ({ ok: true }),
    (err) => ({ ok: false, err })
  );
  const watchPost = postPromise.then((r) => { postResult = r; return r; });
  let changed = false;
  let freshSnap = null;
  try {
    await Promise.race([watchPost, sleep(2500)]);
    if (!(postResult && !postResult.ok)) {
      while (Date.now() < deadline) {
        if (postResult && !postResult.ok) break;
        try {
          const snap = await fetchSnap(8000);
          if (syncStampChanged(baseline, syncStampFrom(snap))) {
            changed = true;
            freshSnap = snap;
            break;
          }
        } catch (_) {}
        if (postResult && !postResult.ok) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        // Keep the poll interval even after a fast 200. Wake early only when the webhook fails.
        const slice = Math.min(BROKER_SYNC_POLL_MS, remaining);
        await Promise.race([
          sleep(slice),
          watchPost.then((r) => (r && r.ok ? sleep(slice) : undefined)),
        ]);
      }
    }
    if (freshSnap) applySnapPayload(freshSnap);
    while (state.refreshing) await sleep(200);
    await refreshQuotes();
  } catch (_) {}
  const applied = syncStampChanged(baseline, currentSyncStamp());
  if (changed || applied) {
    setSyncUi('success');
    syncSuccessTimer = setTimeout(() => {
      if (state.syncPhase === 'success') setSyncUi('idle');
    }, 2800);
  } else if (postResult && !postResult.ok) {
    setSyncUi('error', syncFailText(postResult.err));
  } else {
    setSyncUi('error', '逾時：後台可能仍在同步，請稍後再按');
  }
  } finally {
    state.brokerSyncing = false;
  }
}

function setupBrokerSyncUi() {
  const btn = $('refreshBtn');
  const gear = $('syncConfigBtn');
  const form = $('syncModalForm');
  const cancel = $('syncModalCancel');
  const clearBtn = $('syncModalClear');
  const modal = $('syncModal');
  const keyToggle = $('syncKeyToggle');
  let pressTimer = null;
  let longPressed = false;
  if (btn) {
    const cancelPress = () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    };
    btn.addEventListener('pointerdown', () => {
      if (btn.disabled) return;
      longPressed = false;
      cancelPress();
      pressTimer = setTimeout(() => {
        pressTimer = null;
        longPressed = true;
        openSyncModal('config');
      }, 650);
    });
    btn.addEventListener('pointerup', cancelPress);
    btn.addEventListener('pointerleave', cancelPress);
    btn.addEventListener('pointercancel', cancelPress);
    btn.addEventListener('click', (e) => {
      cancelPress();
      if (longPressed) {
        e.preventDefault();
        longPressed = false;
        return;
      }
      requestBrokerSync();
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!btn.disabled) openSyncModal('config');
    });
  }
  if (gear) gear.addEventListener('click', () => openSyncModal('config'));
  if (form) form.addEventListener('submit', saveSyncModal);
  if (cancel) cancel.addEventListener('click', () => closeSyncModal());
  if (clearBtn) clearBtn.addEventListener('click', () => clearSyncConfig());
  if (keyToggle) {
    keyToggle.addEventListener('click', () => {
      const input = $('syncSenderKey');
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      keyToggle.textContent = show ? '隱藏' : '顯示';
    });
  }
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeSyncModal();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const m = $('syncModal');
    if (m && !m.hidden) {
      e.preventDefault();
      e.stopPropagation();
      closeSyncModal();
    }
  }, true);
}

window.refreshQuotesNow = () => requestBrokerSync();

async function boot() {
  if (!state.unlocked) return;
  try {
    const data = await fetchSnap(10000);
    if (!applySnapPayload(data)) throw new Error((data && data.message) || 'locked');
    // Instant P&L from broker snapshot on first paint (page open).
    applyBrokerSnapshotQuotes();
    renderAll();
    // FX + soft fallback for any name without seedPrice (e.g. BTC).
    await getFx();
    const missing = state.holdings.filter(h => !(Number(h.seedPrice) > 0));
    if (missing.length) {
      await mapPool(missing, BATCH, async (h) => {
        const key = h.yahoo || h.id;
        try {
          const q = await getQuoteForHolding(h);
          if (q && q.price > 0) state.quotes[key] = { ...q, ts: Date.now() };
        } catch (_) {}
      });
      renderAll();
      refreshChartSeries();
    } else {
      refreshChartSeries();
    }
    stopAuto();
    updateToggleUI();
  } catch (e) {
    console.error(e);
    const mode = $('liveModeLabel');
    if (mode) mode.textContent = '無法載入持倉快照: ' + e.message;
  }
}

/* ===== Charts (Chart.js) + multi-source series (Stooq / Tencent / Sina / CoinGecko; Yahoo last) ===== */
const CHART_COLORS = {
  up: '#047857', down: '#be123c', accent: '#2563eb', muted: '#5B677A',
  grid: 'rgba(148, 163, 184, 0.35)', text: '#1e293b',
  alloc: {
    '收益型': '#3b82f6', '現金': '#10b981', '港股': '#a855f7', '美股': '#f59e0b',
    '日本': '#06b6d4', 'A股': '#f43f5e', 'BTC': '#fb923c', '期權': '#818cf8',
  },
};
/* Main indices now shown via TradingView Tickers embed in index.html — no custom quote strip. */
const INDEX_DEFS = [];


function chartDefaults() {
  if (typeof Chart === 'undefined') return;
  Chart.defaults.color = CHART_COLORS.text;
  Chart.defaults.borderColor = CHART_COLORS.grid;
  Chart.defaults.font.family = "'Noto Sans TC', Inter, system-ui, sans-serif";
}

async function fetchTextAny(url, ms = 8000) {
  try {
    const r = await fetchWithTimeout(url, ms);
    return await r.text();
  } catch (_) {
    return null;
  }
}

async function fetchViaProxiesText(url, ms = 10000) {
  for (const [, f] of PUBLIC_PROXIES) {
    try {
      const r = await fetchWithTimeout(f(url), ms);
      const t = await r.text();
      if (t && t.length > 20 && !/^\s*<!DOCTYPE/i.test(t) && !/AuthenticationRequired|captcha|Just a moment/i.test(t)) {
        return t;
      }
    } catch (_) {}
  }
  return null;
}

async function fetchJSONAny(url, ms = 8000) {
  try { return await fetchJSON(url, ms); } catch (_) { return null; }
}

async function fetchJSONViaProxies(url, ms = 10000) {
  for (const [, f] of PUBLIC_PROXIES) {
    try {
      const j = await fetchJSON(f(url), ms);
      if (j) return j;
    } catch (_) {}
  }
  return null;
}

/** Smooth synthetic path from prevClose → price (only when live series unavailable). */
function synthesizeSeries(price, prevClose, n = 18, sourceLabel = '估算') {
  const start = (prevClose > 0 ? prevClose : price) || 0;
  const end = (price > 0 ? price : start) || 0;
  if (!(end > 0) && !(start > 0)) throw new Error('no price for synthetic');
  const now = Date.now();
  const span = 6.5 * 60 * 60 * 1000;
  const pts = [];
  const delta = end - start;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 1 : i / (n - 1);
    const eased = t * t * (3 - 2 * t);
    const wobble = Math.sin(i * 1.7) * 0.12 * Math.abs(delta || end * 0.002) * (1 - Math.abs(2 * t - 1));
    pts.push({ t: now - span + span * t, c: start + delta * eased + wobble });
  }
  // pin ends
  pts[0].c = start;
  pts[pts.length - 1].c = end;
  return {
    pts,
    price: end,
    prevClose: start,
    changePct: start ? (end - start) / start : 0,
    _via: sourceLabel,
    _fallback: true,
  };
}

function parseStooqCsv(text, maxPts = 28) {
  if (!text || !/Date[,;]/i.test(text)) throw new Error('stooq not csv');
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 3) throw new Error('stooq short');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 5) continue;
    const d = parts[0].trim();
    const close = parseFloat(parts[4]);
    if (!(close > 0) || !/^\d{4}-\d{2}-\d{2}/.test(d)) continue;
    const t = Date.parse(d + 'T16:00:00Z');
    if (!Number.isFinite(t)) continue;
    rows.push({ t, c: close });
  }
  if (rows.length < 2) throw new Error('stooq empty');
  rows.sort((a, b) => a.t - b.t);
  const pts = rows.slice(-maxPts);
  const price = pts[pts.length - 1].c;
  const prevClose = pts.length >= 2 ? pts[pts.length - 2].c : price;
  return {
    pts,
    price,
    prevClose,
    changePct: prevClose ? (price - prevClose) / prevClose : 0,
    _via: 'Stooq',
  };
}

async function stooqDailySeries(sym) {
  if (!sym) throw new Error('no stooq sym');
  const url = 'https://stooq.com/q/d/l/?s=' + encodeURIComponent(sym) + '&i=d';
  let text = await fetchTextAny(url, 6000);
  if (!text || !/Date[,;]/i.test(text)) text = await fetchViaProxiesText(url, 12000);
  return parseStooqCsv(text);
}

async function coinGeckoBtcSeries() {
  const urls = [
    'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=1',
    'https://api.coingecko.com/api/v3/coins/bitcoin/ohlc?vs_currency=usd&days=1',
  ];
  // market_chart
  let j = await fetchJSONAny(urls[0], 8000);
  if (!j) j = await fetchJSONViaProxies(urls[0], 10000);
  if (j && Array.isArray(j.prices) && j.prices.length >= 2) {
    const pts = j.prices
      .filter(p => p && p[1] > 0)
      .map(p => ({ t: p[0], c: p[1] }));
    if (pts.length >= 2) {
      const price = pts[pts.length - 1].c;
      // approx prev as first point of window or 24h-ago style
      const prevClose = pts[0].c;
      const chg = prevClose ? (price - prevClose) / prevClose : 0;
      return { pts, price, prevClose, changePct: chg, _via: 'CoinGecko' };
    }
  }
  // ohlc fallback [[t,o,h,l,c],...]
  let ohlc = await fetchJSONAny(urls[1], 8000);
  if (!ohlc) ohlc = await fetchJSONViaProxies(urls[1], 10000);
  if (Array.isArray(ohlc) && ohlc.length >= 2) {
    const pts = ohlc.filter(r => r && r[4] > 0).map(r => ({ t: r[0], c: r[4] }));
    if (pts.length >= 2) {
      const price = pts[pts.length - 1].c;
      const prevClose = pts[0].c;
      return {
        pts, price, prevClose,
        changePct: prevClose ? (price - prevClose) / prevClose : 0,
        _via: 'CoinGecko OHLC',
      };
    }
  }
  throw new Error('CoinGecko series fail');
}

async function sinaScriptQuote(listCode) {
  // JSONP-style: hq_str_<code>
  const varName = 'hq_str_' + listCode;
  const url = 'https://hq.sinajs.cn/list=' + listCode;
  let raw;
  try {
    raw = await loadScriptVar(url, varName);
  } catch (_) {
    // fetch + parse (may need Referer — often blocked cross-origin)
    const txt = await fetchTextAny(url, 5000);
    if (txt) {
      const m = new RegExp(varName + '="([^"]*)"').exec(txt);
      if (m) raw = m[1];
    }
  }
  if (raw == null || raw === '') throw new Error('sina empty');
  const f = String(raw).split(',');
  // int_*: name, price, change, changePct
  if (listCode.startsWith('int_')) {
    const price = parseFloat(f[1]);
    const chgPct = (parseFloat(f[3]) || 0) / 100;
    if (!(price > 0)) throw new Error('sina no price');
    const prevClose = chgPct !== -1 ? price / (1 + chgPct) : price;
    return { price, prevClose, change: price - prevClose, changePct: chgPct, _via: '新浪' };
  }
  // rt_hkHSI: HSI,name,open,prev,high,low,price,change,changePct,...
  if (listCode.startsWith('rt_')) {
    const price = parseFloat(f[6]);
    const prevClose = parseFloat(f[3]) || price;
    if (!(price > 0)) throw new Error('sina rt no price');
    return {
      price, prevClose, change: price - prevClose,
      changePct: prevClose ? (price - prevClose) / prevClose : 0,
      _via: '新浪',
    };
  }
  throw new Error('sina format');
}

async function tencentIndexQuote(tcCode) {
  if (!tcCode) throw new Error('no tc');
  // Prefer full quote codes (usIXIC / r_hkHSI) over short s_* 
  try {
    const q = await tencentQuote(tcCode);
    if (q.price > 0) return { ...q, _via: '騰訊財經' };
  } catch (_) {}
  // short s_ format: 200~name~code~price~change~changePct~
  let raw;
  try {
    const txt = await fetchGbkText('https://qt.gtimg.cn/q=' + tcCode);
    raw = (/="([^"]*)"/.exec(txt) || [])[1];
  } catch (_) {
    try { raw = await loadScriptVar('https://qt.gtimg.cn/q=' + tcCode, 'v_' + tcCode); } catch (__) {}
  }
  if (!raw || raw.indexOf('~') < 0) throw new Error('tencent empty');
  const f = raw.split('~');
  const price = parseFloat(f[3]);
  if (!(price > 0)) throw new Error('tencent no price');
  // detect short vs full: if f[5] looks like pct and f[4] is small relative change
  const a = parseFloat(f[4]);
  const b = parseFloat(f[5]);
  let prevClose, changePct;
  if (Number.isFinite(b) && Math.abs(b) < 30 && Number.isFinite(a) && Math.abs(a) < price * 0.2) {
    // short: change + changePct
    changePct = b / 100;
    prevClose = changePct !== -1 ? price / (1 + changePct) : price;
  } else {
    prevClose = a > 0 ? a : price;
    changePct = prevClose ? (price - prevClose) / prevClose : 0;
  }
  return { price, prevClose, change: price - prevClose, changePct, _via: '騰訊財經' };
}

async function yahooIntraday(sym, range = '1d', interval = '5m') {
  const path = `/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}&includePrePost=false`;
  const directs = [
    'https://query1.finance.yahoo.com' + path,
    'https://query2.finance.yahoo.com' + path,
  ];
  let j = null;
  for (const u of directs) {
    j = await fetchJSONAny(u, 4500);
    if (j && j.chart && j.chart.result) break;
    j = null;
  }
  if (!j) j = await fetchJSONViaProxies(directs[0], 9000);
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res || !res.timestamp) throw new Error('no chart');
  const meta = res.meta || {};
  const closes = (res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [];
  const pts = [];
  for (let i = 0; i < res.timestamp.length; i++) {
    const c = closes[i];
    if (c == null || !(c > 0)) continue;
    pts.push({ t: res.timestamp[i] * 1000, c });
  }
  if (!pts.length) throw new Error('empty series');
  const price = meta.regularMarketPrice || pts[pts.length - 1].c;
  const prevClose = meta.chartPreviousClose || meta.previousClose || pts[0].c;
  return {
    pts, price, prevClose,
    changePct: prevClose ? (price - prevClose) / prevClose : 0,
    currency: meta.currency,
    _via: 'Yahoo ' + interval,
  };
}

async function yahooIntradayHardened(sym) {
  const attempts = [
    ['1d', '5m'], ['1d', '15m'], ['5d', '1h'], ['5d', '1d'],
  ];
  let lastErr;
  for (const [range, interval] of attempts) {
    try {
      return await yahooIntraday(sym, range, interval);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('yahoo hardened fail');
}

function destroyChart(ref) {
  if (ref && typeof ref.destroy === 'function') {
    try { ref.destroy(); } catch (_) {}
  }
  return null;
}

function textPL(v) {
  return v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-muted';
}

function updateIndexStripUI() {
  /* no-op: #indexStrip is TradingView Tickers embed */
}

async function loadOneIndexQuote() {
  return null;
}

async function loadIndexSeries() {
  /* no-op: indices come from TradingView widget */
}

function pickNavHoldings(rows) {
  return rows
    .filter(r => r.type !== 'OPT' && r.yahoo && r.mvHKD > 0 && r.live !== false)
    .slice()
    .sort((a, b) => Math.abs(b.mvHKD) - Math.abs(a.mvHKD))
    .slice(0, 12);
}

function synthesizeNavPath(c, sourceLabel) {
  const end = Number(c.net) || 0;
  const today = Number(c.today) || 0;
  const start = end - today;
  if (!(end > 0) && !(start > 0)) return null;
  const now = Date.now();
  const span = 6.5 * 60 * 60 * 1000;
  const n = 24;
  const path = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const eased = t * t * (3 - 2 * t);
    const wobble = Math.sin(i * 0.9) * Math.abs(today || end * 0.001) * 0.08 * (1 - Math.abs(2 * t - 1));
    path.push({ t: now - span + span * t, nav: start + (end - start) * eased + wobble });
  }
  path[0].nav = start;
  path[path.length - 1].nav = end;
  state.navSeries = path;
  state.navSeriesVia = sourceLabel || '報價估算';
  return path;
}

async function buildNavPath(c) {
  const picks = pickNavHoldings(c.rows);
  const meta = $('navChartMeta');
  const setMeta = (t) => { if (meta) meta.textContent = t; };

  // Prefer weighted Yahoo intraday when available
  if (picks.length) {
    setMeta(`加權 ${picks.length} 隻主要持倉…`);
    const seriesList = [];
    await mapPool(picks, 3, async (h) => {
      try {
        const s = await yahooIntradayHardened(h.yahoo);
        if (s && s.pts && s.pts.length >= 2) seriesList.push({ h, s });
      } catch (_) {}
    });
    if (seriesList.length) {
      const allTs = [...new Set(seriesList.flatMap(x => x.s.pts.map(p => p.t)))].sort((a, b) => a - b);
      if (allTs.length >= 2) {
        const cash = c.cash || 0;
        const path = [];
        const cursors = seriesList.map(x => ({ ...x, i: 0, last: x.s.pts[0].c }));
        for (const t of allTs) {
          let mv = 0;
          for (const cur of cursors) {
            while (cur.i < cur.s.pts.length && cur.s.pts[cur.i].t <= t) {
              cur.last = cur.s.pts[cur.i].c;
              cur.i++;
            }
            const h = cur.h;
            const px = cur.last;
            const ratio = h.price > 0 ? px / h.price : 1;
            mv += (h.mvHKD || 0) * ratio;
          }
          const sampleMvNow = seriesList.reduce((a, x) => a + (x.h.mvHKD || 0), 0) || 1;
          const fullMv = c.mv || sampleMvNow;
          const scaledMv = mv * (fullMv / sampleMvNow);
          path.push({ t, nav: cash + scaledMv });
        }
        setMeta(`加權 ${seriesList.length}/${picks.length} 隻 · Yahoo 盤中`);
        state.navSeries = path;
        state.navSeriesVia = 'Yahoo';
        return path;
      }
    }
  }

  // Fallback: synthesize from KPI today change so chart never stays empty
  if (Number.isFinite(c.net) && (Number.isFinite(c.today) || c.net > 0)) {
    const path = synthesizeNavPath(c, '報價估算（Yahoo盤中暫不可用）');
    if (path) {
      setMeta('報價估算（Yahoo盤中暫不可用）');
      return path;
    }
  }
  setMeta('等待持倉報價…');
  return null;
}

function renderNavChart(path) {
  const canvas = $('navChart');
  if (!canvas || typeof Chart === 'undefined' || !path || path.length < 2) return;
  const labels = path.map(p => new Date(p.t).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit', hour12: false }));
  const data = path.map(p => p.nav);
  const up = data[data.length - 1] >= data[0];
  const color = up ? CHART_COLORS.up : CHART_COLORS.down;
  const cfg = {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: '估算 NAV (HKD)',
        data, borderColor: color, backgroundColor: color + '18',
        borderWidth: 2, pointRadius: 0, fill: true, tension: 0.3,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => 'NAV ' + fmt(ctx.parsed.y, 0) + ' HKD',
          },
        },
      },
      scales: {
        x: {
          ticks: { maxTicksLimit: 8, color: CHART_COLORS.muted, font: { size: 10 } },
          grid: { color: CHART_COLORS.grid },
        },
        y: {
          ticks: {
            color: CHART_COLORS.muted, font: { size: 10 },
            callback: (v) => (v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : fmt(v, 0)),
          },
          grid: { color: CHART_COLORS.grid },
        },
      },
    },
  };
  if (state.charts.nav) {
    state.charts.nav.data.labels = labels;
    state.charts.nav.data.datasets[0].data = data;
    state.charts.nav.data.datasets[0].borderColor = color;
    state.charts.nav.data.datasets[0].backgroundColor = color + '18';
    state.charts.nav.update('none');
  } else {
    state.charts.nav = new Chart(canvas, cfg);
  }
}

function allocGroupsFrom(c) {
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
    else groups['美股'] += absMv;
  }
  return Object.entries(groups).filter(([, v]) => v > 0);
}

function renderAllocDonut(c) {
  const canvas = $('allocDonut');
  if (!canvas || typeof Chart === 'undefined') return;
  // Ensure parent has layout size (Chart.js needs non-zero box)
  const wrap = canvas.parentElement;
  if (wrap && wrap.clientHeight < 40) {
    wrap.style.minHeight = '220px';
  }
  const entries = allocGroupsFrom(c);
  if (!entries.length) return;
  const labels = entries.map(([k]) => k);
  const data = entries.map(([, v]) => v);
  const colors = labels.map(k => CHART_COLORS.alloc[k] || '#64748b');
  if (state.charts.alloc) {
    state.charts.alloc.data.labels = labels;
    state.charts.alloc.data.datasets[0].data = data;
    state.charts.alloc.data.datasets[0].backgroundColor = colors;
    state.charts.alloc.update('none');
    try { state.charts.alloc.resize(); } catch (_) {}
    return;
  }
  state.charts.alloc = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data, backgroundColor: colors, borderColor: '#ffffff', borderWidth: 2,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '62%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { boxWidth: 10, boxHeight: 10, font: { size: 10 }, color: CHART_COLORS.text, padding: 10 },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0) || 1;
              const pct = (ctx.parsed / total * 100).toFixed(1);
              return ` ${ctx.label}: ${pct}% (${fmt(ctx.parsed / 1000, 0)}k)`;
            },
          },
        },
      },
    },
  });
}

function renderWlBar(c) {
  const canvas = $('wlBarChart');
  if (!canvas || typeof Chart === 'undefined') return;
  const ranked = c.rows.filter(r => Number.isFinite(r.todayHKD)).slice().sort((a, b) => b.todayHKD - a.todayHKD);
  const winners = ranked.filter(r => r.todayHKD > 0).slice(0, 5);
  const losers = ranked.filter(r => r.todayHKD < 0).sort((a, b) => a.todayHKD - b.todayHKD).slice(0, 5);
  const mix = [...winners, ...losers.reverse()];
  const seen = new Set();
  const items = [];
  for (const r of mix) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    items.push(r);
  }
  items.sort((a, b) => a.todayHKD - b.todayHKD);
  const labels = items.map(r => r.display);
  const data = items.map(r => r.todayHKD);
  const colors = data.map(v => v >= 0 ? CHART_COLORS.up : CHART_COLORS.down);
  if (state.charts.wl) {
    state.charts.wl.data.labels = labels;
    state.charts.wl.data.datasets[0].data = data;
    state.charts.wl.data.datasets[0].backgroundColor = colors;
    state.charts.wl.update('none');
    return;
  }
  state.charts.wl = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: '今日盈虧 HKD',
        data, backgroundColor: colors, borderRadius: 4, maxBarThickness: 22,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: (ctx) => signed(ctx.parsed.x, 0) + ' HKD' },
        },
      },
      scales: {
        x: {
          grid: { color: CHART_COLORS.grid },
          ticks: {
            color: CHART_COLORS.muted, font: { size: 10 },
            callback: (v) => (Math.abs(v) >= 1000 ? signed(v / 1000, 1) + 'k' : signed(v, 0)),
          },
        },
        y: {
          grid: { display: false },
          ticks: { color: CHART_COLORS.text, font: { size: 10, family: 'JetBrains Mono, monospace' } },
        },
      },
    },
  });
}

function updateLiveCharts(c) {
  chartDefaults();
  renderAllocDonut(c);
  renderWlBar(c);
  if (state.navSeries) renderNavChart(state.navSeries);
  else {
    // Ensure NAV never blank once KPIs exist
    const path = synthesizeNavPath(c, '報價估算');
    if (path) {
      const meta = $('navChartMeta');
      if (meta) meta.textContent = '報價估算（Yahoo盤中暫不可用）';
      renderNavChart(path);
    }
  }
}

async function refreshChartSeries() {
  if (state.chartBusy || !state.unlocked) return;
  state.chartBusy = true;
  try {
    chartDefaults();
    const c = compute();
    const path = await buildNavPath(c);
    if (path) renderNavChart(path);
    renderAllocDonut(c);
    renderWlBar(c);
  } catch (e) {
    console.warn('charts', e);
    // last-ditch: still show synthetic NAV + alloc
    try {
      const c = compute();
      updateLiveCharts(c);
    } catch (_) {}
  } finally {
    state.chartBusy = false;
  }
}

function monthLabel(ym) {
  const m = String(ym || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return ym || '—';
  return m[1] + '年' + Number(m[2]) + '月';
}

function reportPdfUrl(file) {
  return 'reports/' + encodeURIComponent(file) + '?v=20261028d';
}

function selectReport(id) {
  const list = state.reports || [];
  const r = list.find(x => x.id === id) || list[0];
  if (!r) return;
  state.activeReportId = r.id;
  const title = $('reportFeatureTitle');
  const meta = $('reportFeatureMeta');
  const frame = $('reportFrame');
  const dl = $('reportDownload');
  if (title) title.textContent = (r.title || '美國宏觀經濟與跨資產配置月報') + ' · ' + monthLabel(r.month);
  if (meta) meta.textContent = monthLabel(r.month) + (r.pages ? (' · ' + r.pages + ' 頁') : '') + ' · PDF';
  const url = reportPdfUrl(r.file);
  if (frame) frame.src = url;
  if (dl) {
    dl.href = url;
    dl.setAttribute('download', r.file);
    dl.classList.remove('pointer-events-none', 'opacity-50');
  }
  const arch = $('reportArchive');
  if (arch) {
    arch.querySelectorAll('.report-archive-item').forEach(el => {
      el.classList.toggle('active', el.getAttribute('data-id') === r.id);
    });
  }
}

async function loadReports() {
  if (state.reportsLoaded) return;
  const arch = $('reportArchive');
  try {
    const data = await fetchJSON(REPORTS_INDEX_URL + '?t=' + Date.now(), 8000);
    const list = Array.isArray(data && data.reports) ? data.reports.slice() : [];
    list.sort((a, b) => String(b.month || '').localeCompare(String(a.month || '')));
    state.reports = list;
    state.reportsLoaded = true;
    if (arch) {
      if (!list.length) {
        arch.innerHTML = '<p class="text-xs text-muted">暫未有月報。</p>';
      } else {
        arch.innerHTML = list.map(r => (
          '<button type="button" class="report-archive-item w-full text-left" data-id="' + esc(r.id) + '" onclick="selectReport(\'' + esc(r.id) + '\')">' +
            '<div><div class="text-sm text-ink font-medium">' + esc(monthLabel(r.month)) + '</div>' +
            '<div class="text-[11px] text-muted mt-0.5">' + esc(r.title || '宏觀月報') + (r.pages ? (' · ' + r.pages + '頁') : '') + '</div></div>' +
            '<span class="text-[10px] text-blue-700 shrink-0">開啓</span>' +
          '</button>'
        )).join('');
      }
    }
    if (list.length) selectReport(list[0].id);
  } catch (e) {
    console.warn('reports load failed', e);
    if (arch) arch.innerHTML = '<p class="text-xs text-rose-700">月報目錄載入失敗，請稍後再試。</p>';
  }
}

window.selectReport = selectReport;

window.switchAppView = function(view) {
  const allowed = { portfolio: 1, calc: 1, reports: 1 };
  state.view = allowed[view] ? view : 'portfolio';
  const port = $('viewPortfolio');
  const calc = $('viewCalc');
  const reports = $('viewReports');
  const frame = $('calcFrame');
  document.querySelectorAll('.top-nav-btn').forEach(btn => {
    const t = (btn.textContent || '').trim();
    let active = false;
    if (state.view === 'calc') active = t.includes('期權');
    else if (state.view === 'reports') active = t.includes('月報');
    else active = t === '組合';
    btn.classList.toggle('active', active);
  });
  if (port) port.classList.toggle('hidden-view', state.view !== 'portfolio');
  if (calc) calc.classList.toggle('active', state.view === 'calc');
  if (reports) reports.classList.toggle('active', state.view === 'reports');
  if (state.view === 'calc') {
    if (frame && (!frame.src || frame.src === 'about:blank' || frame.getAttribute('src') === 'about:blank')) {
      frame.src = 'calc/index.html';
    }
  } else if (state.view === 'reports') {
    loadReports();
  } else {
    setTimeout(() => {
      try {
        state.charts.nav && state.charts.nav.resize();
        state.charts.alloc && state.charts.alloc.resize();
        state.charts.wl && state.charts.wl.resize();
      } catch (_) {}
    }, 50);
  }
};

setupBrokerSyncUi();
setupGate();
})();
