/* 多腳期權計算機 — 前端主程式（可配合 Python 後端，亦可純靜態網頁運行） */
(() => {
'use strict';
const M = window.OptMath;
const $ = id => document.getElementById(id);
const LS_KEY = 'optcalc.v1';
const POPULAR = [['AAPL', '蘋果'], ['TSLA', 'Tesla'], ['NVDA', 'Nvidia'], ['MSFT', '微軟'], ['AMZN', 'Amazon'], ['META', 'Meta'],
  ['GOOGL', 'Google'], ['AMD', 'AMD'], ['SPY', '標普 ETF'], ['QQQ', '納指 ETF'],
  ['0700.HK', '騰訊'], ['9988.HK', '阿里'], ['3690.HK', '美團'], ['1810.HK', '小米'], ['0005.HK', '匯豐'],
  ['0388.HK', '港交所'], ['1299.HK', '友邦'], ['1211.HK', '比亞迪'], ['0941.HK', '中移動'], ['2800.HK', '盈富']];
const PUBLIC_PROXIES = [
  ['allorigins', u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u)],
  ['corsproxy.io', u => 'https://corsproxy.io/?url=' + encodeURIComponent(u)],
  ['codetabs', u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u)],
  ['cors.lol', u => 'https://api.cors.lol/?url=' + encodeURIComponent(u)],
];

const state = {
  symbol: '', quote: null, spot: null, divYield: 0, rate: 4, mult: 100, currency: 'USD', ivDefault: 30,
  expiry: null, legs: [], lots: 1, width: 5, tpl: null, cat: 'short', evalDays: 0, ivShift: 0, range: 25,
  expirations: [], proxy: '', multManual: false,
};
let chainCache = {};
let chainMeta = null;       // { via:'live'|'baked'|'session'|null, asOf, transport, pending, failed }
const chainBook = {};       // symbol -> { parsed, pending, liveAt, failed }
let chainHoldSym = null;
let chainDirty = false;
let quoteGen = 0;
let backend = null;          // null = 未知, true / false
let legSeq = 1;
let chart = null;

// ================= 工具 =================
const todayISO = () => M.isoDate(new Date());
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const cur = () => (state.currency === 'HKD' ? 'HK$' : 'US$');
function fmt(v, d = 2) {
  if (v == null || Number.isNaN(v)) return '—';
  if (v === Infinity) return '無限 ∞'; if (v === -Infinity) return '−無限 ∞';
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function money(v, d = 2) {
  if (v == null || Number.isNaN(v)) return '—';
  if (!isFinite(v)) return v > 0 ? '無限 ∞' : '−無限 ∞';
  return (v < 0 ? '−' : '') + cur() + fmt(Math.abs(v), d);
}
const pct = (v, d = 2) => (v == null || !isFinite(v) ? '—' : (v * 100).toFixed(d) + '%');
const cls = v => (v > 1e-9 ? 'pos' : v < -1e-9 ? 'neg' : '');
const num = el => { const v = parseFloat(el.value); return Number.isFinite(v) ? v : null; };
const r4 = x => Math.round(x * 10000) / 10000;
let toastT;
function toast(msg, ms = 2600) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function normalizeSymbol(raw) {
  let s = (raw || '').trim().toUpperCase().replace(/\s+/g, '').replace(/^(HK|HKEX)[:.]/, '');
  let m;
  if (/^\d{1,5}$/.test(s)) return String(parseInt(s, 10)).padStart(4, '0') + '.HK';
  if ((m = /^(\d{1,5})\.HK$/.exec(s))) return String(parseInt(m[1], 10)).padStart(4, '0') + '.HK';
  return s;
}
const isHK = s => /\.HK$/.test(s);
function isUsEquity(sym) {
  if (!sym || isHK(sym) || /[\^=]/.test(sym)) return false;
  return /^[A-Z]{1,6}$/.test(sym) || /^[A-Z]{1,5}[.-][A-Z]$/.test(sym);
}
function hkAts(sym) {
  const spec = (window.HK_OPTION_SPECS || {})[sym];
  return spec ? spec[1] : null;
}
function hasListedChain(sym) {
  return !!(window.OptChain && (isUsEquity(sym) || hkAts(sym)));
}

async function fetchWithTimeout(url, ms = 7000, opts = {}) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { ...opts, signal: c.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return r; }
  finally { clearTimeout(t); }
}
const fetchJSON = async (url, ms, opts) => (await fetchWithTimeout(url, ms, opts || {})).json();

// ================= 資料來源（瀏覽器端） =================
function hvFromCloses(closes, n = 30) {
  const c = closes.filter(x => x > 0); if (c.length < 7) return null;
  const s = c.slice(-Math.min(n + 1, c.length)); const r = [];
  for (let i = 1; i < s.length; i++) r.push(Math.log(s[i] / s[i - 1]));
  const mu = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - mu) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v * 252);
}
function parseYahooChart(j) {
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res || !res.meta || !res.meta.regularMarketPrice) throw new Error('Yahoo 回應無效');
  const meta = res.meta;
  const closes = ((res.indicators || {}).quote || [{}])[0].close || [];
  const divs = Object.values((res.events || {}).dividends || {}).sort((a, b) => a.date - b.date);
  const cutoff = Date.now() / 1000 - 365 * 86400;
  const ttm = divs.filter(d => d.date >= cutoff);
  return {
    price: meta.regularMarketPrice, currency: meta.currency, name: meta.shortName || meta.longName,
    prevClose: meta.chartPreviousClose || meta.previousClose, hv30: hvFromCloses(closes),
    annualDividend: ttm.reduce((a, d) => a + d.amount, 0),
    lastDividend: divs.length ? divs[divs.length - 1].amount : null,
    exDividendDate: divs.length ? M.isoDate(new Date(divs[divs.length - 1].date * 1000)) : null,
  };
}
function customProxyUrl(u) {
  const p = (state.proxy || '').trim(); if (!p) return null;
  return p.includes('{url}') ? p.replace('{url}', encodeURIComponent(u)) : p + encodeURIComponent(u);
}
/** Yahoo chart：直連 → 自訂 proxy → 公共 proxy（並行競賽） */
async function yahooClient(sym) {
  const path = `/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d&events=div`;
  const direct = ['https://query1.finance.yahoo.com' + path, 'https://query2.finance.yahoo.com' + path];
  for (const u of direct) {
    try { return { ...parseYahooChart(await fetchJSON(u, 4000)), _via: 'Yahoo Finance（瀏覽器直連）' }; } catch (e) { /* CORS 通常會擋 */ }
  }
  const cand = [];
  const cp = customProxyUrl(direct[0]); if (cp) cand.push(['自訂 Proxy', cp]);
  for (const [n, f] of PUBLIC_PROXIES) cand.push([n, f(direct[0])]);
  return Promise.any(cand.map(async ([n, u]) => ({ ...parseYahooChart(await fetchJSON(u, 6000)), _via: `Yahoo Finance（經 ${n}）` })))
    .catch(() => { throw new Error('Yahoo 直連被 CORS 擋，所有代理都失敗'); });
}
async function fetchGbkText(url) {
  const r = await fetchWithTimeout(url, 6000);
  const buf = await r.arrayBuffer();
  try { return new TextDecoder('gbk').decode(buf); } catch { return new TextDecoder().decode(buf); }
}
function loadScriptVar(url, varName) { // 後備：用 <script> 載入（唔受 CORS 限制）
  return new Promise((res, rej) => {
    const s = document.createElement('script'); s.charset = 'gbk'; s.src = url;
    const t = setTimeout(() => { s.remove(); rej(new Error('timeout')); }, 6000);
    s.onload = () => { clearTimeout(t); s.remove(); window[varName] ? res(window[varName]) : rej(new Error('無資料')); };
    s.onerror = () => { clearTimeout(t); s.remove(); rej(new Error('載入失敗')); };
    document.head.appendChild(s);
  });
}
/** 騰訊財經：qt.gtimg.cn（現價/股息/每手）+ ifzq K 線（歷史波幅），原生 CORS */
async function tencentClient(sym) {
  const code = isHK(sym) ? 'hk' + sym.slice(0, -3).padStart(5, '0') : 'us' + sym.replace('-', '.');
  let raw;
  try { const txt = await fetchGbkText('https://qt.gtimg.cn/q=' + code); raw = (/="([^"]*)"/.exec(txt) || [])[1]; }
  catch { raw = await loadScriptVar('https://qt.gtimg.cn/q=' + code, 'v_' + code); }
  if (!raw || raw.indexOf('~') < 0) throw new Error('騰訊無此代號');
  const f = raw.split('~'); const price = parseFloat(f[3]);
  if (!(price > 0)) throw new Error('騰訊無現價');
  const out = { price, prevClose: parseFloat(f[4]) || null, name: f[1], _via: '騰訊財經 qt.gtimg.cn' };
  if (isHK(sym)) {
    out.currency = 'HKD'; if (f[46]) out.name = f[46] + ' ' + f[1];
    const y = parseFloat(f[47]); if (Number.isFinite(y)) { out.dividendYield = y / 100; out.annualDividend = price * y / 100; }
    const lot = parseInt(f[60], 10); if (lot > 0) out.lotSize = lot;
  } else {
    out.currency = 'USD'; if (f[46]) out.name = f[46];
    const ad = parseFloat(f[66]); const y = parseFloat(f[52]);
    if (Number.isFinite(ad) && ad >= 0 && ad < price) out.annualDividend = ad;
    else if (Number.isFinite(y)) out.dividendYield = y / 100;
  }
  try { // 歷史波幅
    const kcode = isHK(sym) ? code : 'us' + f[2];
    const txt = await (await fetchWithTimeout(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${kcode},day,,,70,qfq`, 6000)).text();
    const j = JSON.parse(txt.slice(txt.indexOf('{')));
    const d = j.data[kcode] || j.data[Object.keys(j.data)[0]];
    const rows = d.qfqday || d.day || [];
    out.hv30 = hvFromCloses(rows.map(r => parseFloat(r[2])));
  } catch { /* 可無 */ }
  return out;
}
/** 試本地後端：回傳 JSON（包括錯誤 JSON）；唔係 JSON = 冇後端 */
async function backendJSON(url, ms) {
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
    const r = await fetch(url, { signal: c.signal }).finally(() => clearTimeout(t));
    if (!(r.headers.get('content-type') || '').includes('json')) { backend = false; return null; }
    backend = true; return await r.json();
  } catch { if (backend === null) backend = false; return null; }
}
async function getQuote(sym) {
  if (backend !== false) {
    const j = await backendJSON('api/quote?symbol=' + encodeURIComponent(sym), 25000);
    if (j && !j.error) { j.mode = 'backend'; return j; }
  }
  const tried = []; let y = null, t = null;
  await Promise.allSettled([
    yahooClient(sym).then(r => { y = r; tried.push({ source: r._via, ok: true }); }, e => tried.push({ source: 'Yahoo Finance（直連 + CORS 代理）', ok: false, error: e.message })),
    tencentClient(sym).then(r => { t = r; tried.push({ source: r._via, ok: true }); }, e => tried.push({ source: '騰訊財經', ok: false, error: e.message })),
  ]);
  if (!y && !t) { const err = new Error('所有資料來源都攞唔到 ' + sym + ' 嘅現價，請人手輸入'); err.tried = tried; throw err; }
  const q = { symbol: sym, mode: 'static', sourcesTried: tried };
  const a = y || t, b = y ? t : null;
  Object.assign(q, b || {}, Object.fromEntries(Object.entries(a).filter(([, v]) => v != null)));
  if (y && t && t.name && isHK(sym)) q.name = t.name;
  if (t && t.lotSize) q.lotSize = t.lotSize;
  q.priceSource = a._via;
  q.dividendSource = (y && y.annualDividend != null) ? y._via : (t ? t._via : null);
  if (y && y.annualDividend != null) { q.annualDividend = y.annualDividend; q.dividendYield = y.annualDividend / q.price; }
  else if (q.annualDividend != null) q.dividendYield = q.annualDividend / q.price;
  else if (q.dividendYield != null) q.annualDividend = q.dividendYield * q.price;
  if (q.hv30 == null && t && t.hv30) q.hv30 = t.hv30;
  if (q.prevClose) { q.change = q.price - q.prevClose; q.changePct = q.change / q.prevClose; }
  q.currency = q.currency || (isHK(sym) ? 'HKD' : 'USD');
  q.time = new Date().toLocaleString('zh-HK');
  return q;
}
async function getRate() {
  if (backend !== false) {
    const j = await backendJSON('api/rate', 8000); if (j && j.rate) return j;
  }
  try { const y = await yahooClient('^IRX'); return { rate: y.price / 100, source: '^IRX ' + y._via }; } catch { return null; }
}
const CHAIN_FRESH_MS = 10 * 60 * 1000;
const CHAIN_SESSION_MS = 12 * 60 * 60 * 1000;
function cboeUrl(sym) {
  return 'https://cdn-api.cboe.com/api/global/delayed_quotes/options/' + encodeURIComponent(sym) + '.json';
}
function cboeSymbolCandidates(sym) {
  const u = sym.toUpperCase();
  const flat = u.replace(/[.-]/g, '');
  return flat === u ? [u] : [u, flat];
}
async function fetchJinaJson(url, ms) {
  const r = await fetchWithTimeout('https://r.jina.ai/' + url, ms, {
    cache: 'no-store',
    headers: { Accept: 'text/plain', 'X-Return-Format': 'text' },
  });
  const text = (await r.text()).trim();
  const body = text.startsWith('{') ? text : text.slice(Math.max(0, text.indexOf('{')));
  const j = JSON.parse(body);
  if (!j || !j.data || !Array.isArray(j.data.options)) throw new Error('jina');
  return j;
}
async function raceCboe(sym) {
  const url = cboeUrl(sym);
  const take = async (transport, p) => {
    const j = await p;
    const parsed = window.OptChain.chainsFromCboe(j, sym);
    if (!parsed) throw new Error('empty chain');
    parsed.via = 'live';
    parsed.transport = transport;
    return parsed;
  };
  const jobs = [
    take('CBOE 直連', fetchJSON(url, 8000, { cache: 'no-store' })),
    take('Jina 讀取器', fetchJinaJson(url, 28000)),
  ];
  const custom = customProxyUrl(url);
  if (custom) jobs.push(take('自訂 Proxy', fetchJSON(custom, 10000, { cache: 'no-store' })));
  for (const [name, fn] of PUBLIC_PROXIES) jobs.push(take(name, fetchJSON(fn(url), 8000, { cache: 'no-store' })));
  try { return await Promise.any(jobs); } catch { return null; }
}
async function fetchLiveCboe(sym) {
  if (!window.OptChain) return null;
  for (const s of cboeSymbolCandidates(sym)) {
    const parsed = await raceCboe(s);
    if (parsed) { parsed.symbol = sym; return parsed; }
  }
  return null;
}
function parseJsonp(text) {
  const s = String(text || '');
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i < 0 || j <= i) throw new Error('jsonp');
  return JSON.parse(s.slice(i, j + 1));
}
function hkexAsOf(lastupd) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}:\d{2})/.exec(String(lastupd || '').trim());
  if (!m) return null;
  return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0') + ' ' + m[4] + ' HKT';
}
function hkexTokenFromHtml(html) {
  const re = /return\s+"([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1] && m[1] !== 'Base64-AES-Encrypted-Token' && m[1].length > 20) {
      try { return decodeURIComponent(m[1]); } catch { return m[1]; }
    }
  }
  return null;
}
function hkexJobs(url, ms) {
  const jobs = [['HKEX 直連', () => fetchWithTimeout(url, ms, { cache: 'no-store' }).then(r => r.text())]];
  const custom = customProxyUrl(url);
  if (custom) jobs.push(['自訂 Proxy', () => fetchWithTimeout(custom, ms, { cache: 'no-store' }).then(r => r.text())]);
  for (const [name, fn] of PUBLIC_PROXIES) jobs.push([name, () => fetchWithTimeout(fn(url), ms, { cache: 'no-store' }).then(r => r.text())]);
  return jobs;
}
async function hkexToken() {
  const page = 'https://www.hkex.com.hk/Market-Data/Securities-Prices/Equities/Equities-Quote?sym=700&sc_lang=en';
  const hit = await Promise.any(hkexJobs(page, 8000).map(async ([name, fn]) => {
    const token = hkexTokenFromHtml(await fn());
    if (!token) throw new Error('hkex token');
    return { name, token };
  }));
  return hit.token;
}
async function hkexData(token, api, params) {
  const q = new URLSearchParams();
  q.set('lang', 'eng');
  q.set('token', token);
  q.set('qid', String(Date.now()));
  q.set('callback', 'cb');
  for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') q.set(k, String(v));
  const url = 'https://www1.hkex.com.hk/hkexwidget/data/' + api + '?' + q.toString();
  const hit = await Promise.any(hkexJobs(url, 12000).map(async ([name, fn]) => {
    const payload = parseJsonp(await fn());
    const data = payload && (payload.data || payload);
    const rc = data && data.responsecode;
    if (!data || (rc && rc !== '000' && rc !== '0')) throw new Error('hkex ' + api);
    data._transport = name;
    return data;
  }));
  return hit;
}
async function hkexExpiryMap() {
  try {
    const j = await fetchJSON('data/hkex_calendar.json', 8000, { cache: 'no-cache' });
    return (j && j.expiries) || {};
  } catch { return {}; }
}
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i]); } catch { out[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
async function fetchLiveHkex(sym) {
  const ats = hkAts(sym);
  if (!ats || !window.OptChain) return null;
  try {
    const [token, cal] = await Promise.all([hkexToken(), hkexExpiryMap()]);
    const list = await hkexData(token, 'getoptioncontractlist', { ats, type: '1' });
    const cons = (list.conlist || []).filter(c => c && /^\d{6}$/.test(c.id));
    if (!cons.length) return null;
    const code = String(parseInt(sym, 10));
    const months = await mapPool(cons, 4, async con => {
      const probe = await hkexData(token, 'getderivativesoption', { ats, type: '1', con: con.id });
      const lo = String(probe.min || '').replace(/,/g, '');
      const hi = String(probe.max || '').replace(/,/g, '');
      const full = (lo && hi)
        ? await hkexData(token, 'getderivativesoption', { ats, type: '1', con: con.id, fr: lo, to: hi })
        : probe;
      return {
        id: con.id,
        expiry: cal[con.id] || window.OptChain.expiryFromContractId(con.id),
        lastupd: full.lastupd || probe.lastupd || '',
        optionlist: full.optionlist || [],
      };
    });
    let spot = null;
    try {
      const quote = (await hkexData(token, 'getequityquote', { sym: code })).quote || {};
      const px = parseFloat(String(quote.ls || quote.hc || '').replace(/,/g, ''));
      if (px > 0) spot = px;
    } catch { /* 正股報價另外由 Yahoo／騰訊提供 */ }
    const stamps = months.filter(Boolean).map(m => hkexAsOf(m.lastupd)).filter(Boolean).sort();
    const parsed = window.OptChain.chainsFromHkex({
      symbol: sym, ats, spot, asOf: stamps[stamps.length - 1] || null, months: months.filter(Boolean),
    });
    if (!parsed) return null;
    parsed.via = 'live';
    parsed.transport = (list && list._transport) || 'HKEX 直連';
    return parsed;
  } catch { return null; }
}
async function fetchLiveChain(sym) {
  if (hkAts(sym)) return fetchLiveHkex(sym);
  return fetchLiveCboe(sym);
}
function readChainSession(sym) {
  try {
    const raw = JSON.parse(sessionStorage.getItem('optcalc.chain.' + sym) || 'null');
    if (!raw || !raw.data || !raw.at || !window.OptChain) return null;
    const parsed = window.OptChain.chainsFromCompact(raw.data);
    if (!parsed) return null;
    const ageMs = Date.now() - raw.at;
    parsed.via = ageMs < CHAIN_FRESH_MS ? 'live' : 'session';
    parsed.transport = '瀏覽器快取';
    parsed.ageMs = ageMs;
    parsed.fetchedAt = raw.at;
    return parsed;
  } catch { return null; }
}
function writeChainSession(sym, parsed) {
  try {
    if (!window.OptChain) return;
    const blob = JSON.stringify({ at: Date.now(), data: window.OptChain.toCompact(parsed) });
    if (blob.length > 450000) return;
    sessionStorage.setItem('optcalc.chain.' + sym, blob);
  } catch { /* 快取額度用盡就唔存 */ }
}
async function loadBakedChain(sym) {
  try {
    const j = await fetchJSON('data/chains/' + encodeURIComponent(sym) + '.json', 8000, { cache: 'no-cache' });
    const parsed = window.OptChain && window.OptChain.chainsFromCompact(j);
    if (!parsed) return null;
    parsed.via = 'baked';
    parsed.transport = '內置快照';
    return parsed;
  } catch { return null; }
}
function chainSlot(sym) {
  return chainBook[sym] || (chainBook[sym] = { parsed: null, pending: null, liveAt: 0, failed: false });
}
function startLive(sym) {
  const slot = chainSlot(sym);
  if (slot.pending) return slot.pending;
  slot.pending = (async () => {
    const live = await fetchLiveChain(sym);
    slot.failed = !live;
    if (live) {
      slot.parsed = live;
      slot.liveAt = Date.now();
      writeChainSession(sym, live);
    }
    return slot.parsed;
  })().finally(() => {
    slot.pending = null;
    if (chainHoldSym) { if (sym === chainHoldSym) chainDirty = true; return; }
    if (state.symbol === sym) applyLiveUpdate();
  });
  return slot.pending;
}
async function ensureChain(sym, opts = {}) {
  const slot = chainSlot(sym);
  if (!slot.parsed) {
    const ses = readChainSession(sym);
    if (ses && ses.ageMs < CHAIN_SESSION_MS) {
      slot.parsed = ses;
      if (ses.via === 'live') slot.liveAt = ses.fetchedAt;
    } else {
      slot.parsed = await loadBakedChain(sym);
      if (!slot.parsed && ses) slot.parsed = ses;
    }
  }
  const fresh = !!(slot.parsed && slot.parsed.via === 'live' && Date.now() - slot.liveAt < CHAIN_FRESH_MS);
  if ((opts.refresh || !fresh) && !slot.pending) startLive(sym);
  if (slot.parsed) return slot.parsed;
  return slot.pending || null;
}
function applyParsed(parsed) {
  const slot = state.symbol ? chainBook[state.symbol] : null;
  chainCache = {};
  if (parsed) {
    for (const e of parsed.expirations) chainCache[e] = parsed.chains[e];
    state.expirations = parsed.expirations.slice();
  } else state.expirations = [];
  chainMeta = {
    via: parsed ? parsed.via : null,
    asOf: (parsed && parsed.asOf) || '',
    transport: (parsed && parsed.transport) || '',
    source: (parsed && parsed.source) || '',
    pending: !!(slot && slot.pending),
    failed: !!(slot && slot.failed),
  };
}
function applyLiveUpdate() {
  const slot = chainBook[state.symbol];
  const parsed = slot && slot.parsed;
  if (!parsed) { renderExpSelect(); return; }
  applyParsed(parsed);
  if (state.expiry && state.expirations.length && !state.expirations.includes(state.expiry)) {
    state.expiry = snapExpiry(state.expiry);
    updateLegExpiries();
  }
  state.legs.forEach(l => {
    if (l.type === 'stock' || l.locked) return;
    if (chainCache[l.expiry] && !chainRow(l)) l.strike = snapStrike(l.strike, l.expiry);
  });
  priceAll();
  renderExpSelect(); renderExpChips(); renderDte();
  if ($('expiry') && state.expiry) $('expiry').value = state.expiry;
  updateLegFields(true);
  recalc(true);
}
async function getExpirations(sym, opts = {}) {
  if (backend) {
    try {
      const j = await fetchJSON('api/expirations?symbol=' + encodeURIComponent(sym), 20000);
      chainMeta = null;
      return j.expirations || [];
    } catch { return []; }
  }
  if (!hasListedChain(sym)) return [];
  const parsed = await ensureChain(sym, opts);
  if (!parsed) {
    chainCache = {};
    chainMeta = { via: null, asOf: '', transport: '', pending: false, failed: true };
    return [];
  }
  applyParsed(parsed);
  return parsed.expirations.slice();
}
async function loadChains() {
  if (backend) {
    if (!state.expirations.length) return;
    const need = [...new Set(state.legs.filter(l => l.type !== 'stock').map(l => l.expiry))]
      .filter(e => state.expirations.includes(e) && !chainCache[e]);
    await Promise.all(need.map(async e => {
      try { const j = await fetchJSON(`api/chain?symbol=${encodeURIComponent(state.symbol)}&expiry=${e}`, 20000); if (j.calls) chainCache[e] = j; }
      catch { /* 冇鏈就用 BS */ }
    }));
    return;
  }
  if (!hasListedChain(state.symbol)) return;
  const parsed = await ensureChain(state.symbol);
  if (parsed) applyParsed(parsed);
}

// ================= 到期日工具 =================
function nextFriday(from) { const d = M.parseDate(from); const add = ((5 - d.getDay()) + 7) % 7 || 7; d.setDate(d.getDate() + add); return d; }
function thirdFriday(y, m) { const d = new Date(y, m, 1); const add = (5 - d.getDay() + 7) % 7; d.setDate(1 + add + 14); return d; }
function hkMonthly(y, m) { // 港股期權：月內最後一個營業日嘅前一個營業日（未計公眾假期）
  const d = new Date(y, m + 1, 0); const back = () => { do { d.setDate(d.getDate() - 1); } while (d.getDay() === 0 || d.getDay() === 6); };
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  back(); return d;
}
function monthlyExpiry(offset) {
  const t = M.parseDate(todayISO()); let y = t.getFullYear(), m = t.getMonth();
  const f = isHK(state.symbol) ? hkMonthly : thirdFriday;
  let d = f(y, m); if (d <= t) { m++; d = f(y, m); }
  for (let i = 0; i < offset; i++) { m++; d = f(y, m); }
  return d;
}
function snapExpiry(iso) {
  if (!state.expirations.length) { // 冇期權鏈：美股對齊最近嘅星期五；港股避開週末
    const d = M.parseDate(iso), w = d.getDay();
    if (isHK(state.symbol)) { if (w === 6) d.setDate(d.getDate() - 1); if (w === 0) d.setDate(d.getDate() - 2); }
    else { let k = 5 - w; if (k < -3) k += 7; if (k > 3) k -= 7; d.setDate(d.getDate() + k); }
    if (M.isoDate(d) <= todayISO()) return iso;
    return M.isoDate(d);
  }
  let best = state.expirations[0], bd = Infinity;
  for (const e of state.expirations) { const d = Math.abs(M.daysBetween(iso, e)); if (d < bd) { bd = d; best = e; } }
  return best;
}
function farExpiry(near, days) {
  const target = M.isoDate(M.addDays(near, days));
  if (state.expirations.length) { const e = state.expirations.find(x => x >= M.isoDate(M.addDays(near, Math.round(days * 0.85)))); if (e) return e; }
  return target;
}

// ================= 期權腳 =================
function ctx() {
  return { spot: state.spot || 0, r: state.rate / 100, q: state.divYield / 100, mult: state.mult || 1, today: todayISO(),
    ivShift: state.ivShift / 100, defaultIV: state.ivDefault / 100 };
}
function newLeg(o) {
  return Object.assign({ id: legSeq++, side: 1, type: 'call', strike: null, qty: 1, premium: 0, iv: state.ivDefault / 100,
    expiry: state.expiry, tag: 'near', farDays: 0, locked: false, src: 'bs' }, o);
}
function legT(l) { return Math.max(0, M.daysBetween(todayISO(), l.expiry)) / 365; }
function chainRow(l) {
  const c = chainCache[l.expiry]; if (!c || l.strike == null) return null;
  return (l.type === 'call' ? c.calls : c.puts).find(r => Math.abs(r.strike - l.strike) < 1e-6) || null;
}
function step() { return M.strikeStep(state.spot || 100); }
function snapStrike(x, exp) {
  const c = chainCache[exp];
  if (c) { const ks = [...new Set([...c.calls, ...c.puts].map(r => r.strike))]; if (ks.length) return ks.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a)); }
  const s = step(); return r4(Math.round(x / s) * s);
}
function priceLeg(l) {
  const c = ctx();
  if (l.type === 'stock') { if (!l.locked) { l.premium = r4(c.spot); l.src = 'spot'; } return; }
  const row = chainRow(l); l.bid = row ? row.bid : null; l.ask = row ? row.ask : null; l.chainIV = row ? row.iv : null;
  if (l.locked) return;
  if (row) {
    const p = row.mid || row.last;
    if (p > 0) {
      l.premium = r4(p);
      const solved = M.impliedVol(l.type, p, c.spot, l.strike, legT(l), c.r, c.q);
      l.iv = solved || (row.iv > 0.01 && row.iv < 5 ? row.iv : l.iv);
      l.src = 'chain'; return;
    }
  }
  if (!(l.strike > 0) || !(c.spot > 0)) return;
  l.premium = r4(M.bs(l.type, c.spot, l.strike, legT(l), c.r, c.q, Math.max(0.0001, l.iv)).price);
  l.src = 'bs';
}
const priceAll = () => state.legs.forEach(priceLeg);

function applyTemplate(id, silent) {
  const tpl = TEMPLATES.find(t => t.id === id); if (!tpl) return;
  if (!(state.spot > 0)) { toast('請先攞報價或者輸入現價'); return; }
  state.tpl = id;
  const w = (state.width || 5) / 100, lots = Math.max(1, state.lots | 0);
  const legs = tpl.legs.map(d => {
    if (d.t === 'stock') return newLeg({ side: d.s, type: 'stock', qty: state.mult * lots, premium: state.spot, strike: null });
    const exp = d.far ? farExpiry(state.expiry, d.far) : state.expiry;
    return newLeg({ side: d.s, type: d.t, qty: (d.n || 1) * lots, expiry: exp, tag: d.far ? 'far' : 'near', farDays: d.far || 0,
      _k: d.k, strike: snapStrike(state.spot * (1 + d.k * w), exp) });
  });
  // 確保唔同 k 嘅腳唔會撞同一行使價
  const opt = legs.filter(l => l.type !== 'stock').sort((a, b) => a._k - b._k);
  for (let i = 1; i < opt.length; i++) {
    const a = opt[i - 1], b = opt[i];
    if (b._k > a._k && b.strike <= a.strike) {
      if (b._k > 0) b.strike = r4(a.strike + step()); else a.strike = r4(b.strike - step());
    }
  }
  legs.forEach(l => delete l._k);
  state.legs = legs;
  priceAll(); renderTemplates(); renderLegs(); recalc(true);
  loadChains().then(() => {
    // 期權鏈載入後，將行使價對齊真實行使價，再用鏈報價
    state.legs.forEach(l => { if (l.type !== 'stock' && chainCache[l.expiry] && !chainRow(l)) l.strike = snapStrike(l.strike, l.expiry); });
    priceAll(); updateLegFields(true); recalc(true);
  });
  if (!silent) toast(`已套用：${tpl.name} ${tpl.en}`);
}

// ================= 介面：正股 =================
function renderPopular() {
  $('popChips').innerHTML = POPULAR.map(([s, n]) => `<button class="chip" data-sym="${s}">${s}<small>${n}</small></button>`).join('');
  const hkNames = Object.entries(window.HK_OPTION_SPECS || {}).map(([s, v]) => `<option value="${s}">${esc(v[2])}</option>`);
  $('tickerList').innerHTML = POPULAR.map(([s, n]) => `<option value="${s}">${n}</option>`).join('') + hkNames.join('');
}
function setMultFromSymbol(q) {
  const sym = state.symbol; let note = '';
  if (isHK(sym)) {
    const spec = (window.HK_OPTION_SPECS || {})[sym];
    if (spec) { state.mult = spec[0]; note = `港交所股票期權 ${spec[1]}：每張合約 ${spec[0].toLocaleString()} 股${q && q.lotSize ? `（每手 ${q.lotSize} 股）` : ''}`; }
    else { state.mult = (q && q.lotSize) || 100; note = `⚠️ 港交所期權名單搵唔到 ${sym}（可能冇期權），暫用每手 ${state.mult} 股，請自行修改`; }
  } else { state.mult = 100; note = '美股期權每張合約 100 股'; }
  $('multNote').textContent = note; $('multNote').className = 'note' + (note.startsWith('⚠️') ? ' warn' : '');
}
function renderQuote(q, err) {
  const box = $('quoteBox'); box.className = 'quotebox' + (err ? ' err' : '');
  if (err) {
    $('qName').textContent = '⚠️ ' + err.message; $('qPrice').textContent = state.spot ? cur() + fmt(state.spot) : '—';
    $('qChg').textContent = ''; $('qMeta').innerHTML = '';
    $('qSrc').innerHTML = (err.tried || []).map(t => `${t.ok ? '✅' : '❌'} ${esc(t.source)}${t.error ? '：' + esc(t.error) : ''}`).join('<br>');
    return;
  }
  if (!q) return;
  $('qName').textContent = `${q.symbol} · ${q.name || ''}`;
  $('qPrice').textContent = (q.currency === 'HKD' ? 'HK$' : 'US$') + fmt(q.price, q.price < 10 ? 3 : 2);
  const c = $('qChg');
  if (q.change != null) { c.textContent = `${q.change >= 0 ? '▲' : '▼'} ${fmt(Math.abs(q.change))} (${pct(q.changePct)})`; c.className = 'chg ' + (q.change >= 0 ? 'up' : 'down'); }
  else c.textContent = '';
  const meta = [];
  meta.push(`股息率 <b>${q.dividendYield != null ? pct(q.dividendYield) : '—'}</b>`);
  if (q.annualDividend != null) meta.push(`年度股息 (TTM) <b>${fmt(q.annualDividend, 3)}</b>`);
  if (q.exDividendDate) meta.push(`最近除息日 <b>${q.exDividendDate}</b>`);
  if (q.nextExDividendDate && q.nextExDividendDate > todayISO()) meta.push(`下次除息 <b>${q.nextExDividendDate}</b>`);
  if (q.hv30) meta.push(`30日歷史波幅 <b>${pct(q.hv30, 1)}</b>`);
  if (q.lotSize) meta.push(`每手 <b>${q.lotSize}</b> 股`);
  $('qMeta').innerHTML = meta.map(x => `<span>${x}</span>`).join('');
  const tried = (q.sourcesTried || []).map(t => `${t.ok ? '✅' : '❌'} ${esc(t.source)}`).join('　');
  $('qSrc').innerHTML = `現價來源：<b>${esc(q.priceSource || '—')}</b>　股息來源：<b>${esc(q.dividendSource || '—')}</b>　· ${esc(q.time || '')}<br>${tried}`;
}
async function loadQuote(raw, opts = {}) {
  const sym = normalizeSymbol(raw); if (!sym) { toast('請輸入股票代號'); return; }
  const gen = ++quoteGen;
  const changed = sym !== state.symbol;
  chainHoldSym = sym;
  chainDirty = false;
  $('ticker').value = sym; $('quoteBox').classList.add('loading'); $('qName').textContent = `⏳ 攞緊 ${sym} 報價…`;
  $('btnQuote').disabled = true;
  try {
    try {
      const q = await getQuote(sym);
      if (gen !== quoteGen) return;
      state.symbol = sym; state.quote = q; state.spot = r4(q.price);
      state.currency = q.currency === 'HKD' ? 'HKD' : 'USD';
      state.divYield = q.dividendYield != null ? r4(q.dividendYield * 100) : 0;
      if (q.hv30) state.ivDefault = Math.round(q.hv30 * 1000) / 10;
      if (changed || !state.multManual) { state.multManual = false; setMultFromSymbol(q); }
      renderQuote(q);
      $('modeLbl').textContent = q.mode === 'backend' ? '（目前：本地後端模式）' : '（目前：純網頁模式）';
    } catch (e) {
      if (gen !== quoteGen) return;
      if (changed) { state.symbol = sym; state.quote = null; setMultFromSymbol(null); }
      renderQuote(null, e); toast('攞唔到報價，請人手輸入現價');
    } finally {
      if (gen === quoteGen) { $('btnQuote').disabled = false; $('quoteBox').classList.remove('loading'); }
    }
    if (gen !== quoteGen) return;
    if (changed) { chainCache = {}; state.expirations = []; chainMeta = null; }
    if (hasListedChain(sym) && !backend) {
      const note = $('chainNote');
      note.className = 'dteline';
      note.textContent = hkAts(sym) ? '正在載入 HKEX 延遲期權鏈…' : '正在載入 CBOE 延遲期權鏈…';
    }
    state.expirations = await getExpirations(sym, { refresh: !opts.silent });
    if (gen !== quoteGen) return;
    if (!state.expiry || state.expiry <= todayISO()) state.expiry = snapExpiry(M.isoDate(M.addDays(todayISO(), 30)));
    else if (changed || (state.expirations.length && !state.expirations.includes(state.expiry))) state.expiry = snapExpiry(state.expiry);
    renderExpSelect();
    syncInputs();
    if (changed || !state.legs.length) { applyTemplate(state.tpl || 'short_put', true); }
    else { updateLegExpiries(); await loadChains(); priceAll(); renderLegs(); recalc(true); }
    if (!opts.silent && gen === quoteGen) toast(`${sym} 報價已更新`);
  } finally {
    if (gen !== quoteGen) return;
    const dirty = chainDirty && state.symbol === sym;
    chainHoldSym = null;
    chainDirty = false;
    if (dirty) applyLiveUpdate();
  }
}

// ================= 介面：到期日 =================
function renderExpChips() {
  const t = todayISO();
  const items = [['7 日', M.addDays(t, 7)], ['14 日', M.addDays(t, 14)], ['30 日', M.addDays(t, 30)], ['45 日', M.addDays(t, 45)],
    ['60 日', M.addDays(t, 60)], ['90 日', M.addDays(t, 90)], ['下個週五', nextFriday(t)],
    ['本月期', monthlyExpiry(0)], ['下月期', monthlyExpiry(1)], ['再下月', monthlyExpiry(2)]];
  $('expChips').innerHTML = items.map(([n, d]) => { const iso = snapExpiry(M.isoDate(d)); return `<button class="chip${iso === state.expiry ? ' on' : ''}" data-exp="${iso}">${n}<small>${iso.slice(5)}</small></button>`; }).join('');
}
function chainVendor() {
  const src = (chainMeta && chainMeta.source) || '';
  if (/HKEX/i.test(src)) return 'HKEX';
  if (/CBOE/i.test(src)) return 'CBOE';
  if (hkAts(state.symbol) && state.expirations.length) return 'HKEX';
  return 'CBOE';
}
function asOfText(asOf) {
  if (!asOf) return '';
  return /\b(UTC|HKT)\b/.test(asOf) ? asOf : asOf + ' UTC';
}
function chainStatusNote() {
  const n = state.expirations.length;
  if (!n) {
    const text = hkAts(state.symbol)
      ? '⚠️ 攞唔到港交所期權鏈。而家顯示嘅期權金係 Black-Scholes 理論價，唔係市場報價，落盤前請改成券商報價。'
      : (isHK(state.symbol)
        ? '⚠️ 港交所期權名單冇呢隻。期權金係 Black-Scholes 理論價，唔係市場報價。'
        : (backend
          ? '⚠️ 冇期權鏈。期權金係 Black-Scholes 理論價，唔係市場報價（可人手改）。'
          : '⚠️ 攞唔到市場期權鏈。而家顯示嘅期權金係 Black-Scholes 理論價，唔係市場報價，可人手改。'));
    return { bad: true, text };
  }
  const asOf = asOfText(chainMeta && chainMeta.asOf);
  const via = chainMeta && chainMeta.via;
  const vendor = chainVendor();
  let head = '✅ 期權鏈';
  if (backend && !via) head = '✅ Yahoo 期權鏈';
  else if (via === 'live') head = `✅ ${vendor} 延遲期權鏈`;
  else if (via === 'session') head = `✅ 快取 ${vendor} 期權鏈`;
  else if (via === 'baked') head = `✅ 內置 ${vendor} 延遲期權鏈`;
  const transport = chainMeta && chainMeta.transport ? '，' + chainMeta.transport : '';
  let text = `${head}${asOf ? '（截至 ' + asOf + transport + '）' : (transport ? '（' + chainMeta.transport + '）' : '')}：${n} 個到期日，未鎖定嘅腳用 Bid/Ask 中間價同 IV`;
  if (chainMeta && chainMeta.pending) text += ' · 正在更新';
  else if (chainMeta && chainMeta.failed && via !== 'live') text += ' · 即時更新失敗，用緊呢份鏈';
  return { bad: false, text };
}
function renderExpSelect() {
  const sel = $('expSelect');
  if (!state.expirations.length) {
    sel.innerHTML = `<option value="">${backend ? '— 冇期權鏈 —' : '— 冇市場期權鏈 —'}</option>`;
  } else {
    const t = todayISO();
    sel.innerHTML = state.expirations.map(e => `<option value="${e}"${e === state.expiry ? ' selected' : ''}>${e}（${M.daysBetween(t, e)} 日）</option>`).join('');
  }
  const st = chainStatusNote();
  const note = $('chainNote');
  note.className = 'dteline' + (st.bad ? ' bad' : '');
  note.textContent = st.text;
}
function renderDte() {
  const el = $('dteLine'); const e = state.expiry;
  if (!e) { el.className = 'dteline bad'; el.innerHTML = '請揀到期日'; return; }
  const d = M.daysBetween(todayISO(), e), td = M.tradingDaysBetween(todayISO(), e);
  const wk = '日一二三四五六'[M.parseDate(e).getDay()];
  el.className = 'dteline' + (d <= 0 ? ' bad' : '');
  el.innerHTML = d <= 0 ? `⚠️ 到期日要係未來日期（${e}）` : `距離今日 <b>${d}</b> 日（約 ${td} 個交易日）· 星期${wk}`;
}
function updateLegExpiries() {
  state.legs.forEach(l => { if (l.type === 'stock') return; if (l.tag === 'near') l.expiry = state.expiry; else if (l.tag === 'far') l.expiry = farExpiry(state.expiry, l.farDays || 28); });
}
async function setExpiry(iso) {
  if (!iso) return;
  if (state.expirations.length && !state.expirations.includes(iso)) iso = snapExpiry(iso);
  state.expiry = iso; updateLegExpiries();
  renderDte(); renderExpChips(); renderExpSelect(); $('expiry').value = iso;
  await loadChains(); priceAll(); renderLegs(); recalc(true);
}

// ================= 介面：模板 =================
function templateMatchesLegs() {
  const tpl = TEMPLATES.find(t => t.id === state.tpl);
  if (!tpl || tpl.legs.length !== state.legs.length) return false;
  for (let i = 0; i < tpl.legs.length; i++) {
    if (tpl.legs[i].t !== state.legs[i].type || tpl.legs[i].s !== state.legs[i].side) return false;
  }
  return true;
}
function renderTemplates() {
  const matched = templateMatchesLegs();
  $('tplTabs').innerHTML = TEMPLATE_CATS.map(c => `<button class="tab${c.id === state.cat ? ' on' : ''}" data-cat="${c.id}">${c.name}</button>`).join('');
  $('tplGrid').innerHTML = TEMPLATES.filter(t => t.cats.includes(state.cat)).map(t =>
    `<button class="tpl${matched && t.id === state.tpl ? ' on' : ''}" data-tpl="${t.id}"><b>${t.name}</b><span>${t.en}</span><br><span class="tag ${t.type}">${t.type === 'credit' ? '收錢 Credit' : '付錢 Debit'}</span></button>`).join('');
  const t = matched ? TEMPLATES.find(x => x.id === state.tpl) : null;
  $('tplDesc').className = 'tpldesc' + (t ? ' show' : '');
  $('tplDesc').innerHTML = t ? `<b>${t.name} ${t.en}</b>：${t.desc}` : '';
}

// ================= 介面：期權腳 =================
function legHTML(l) {
  const opt = l.type !== 'stock';
  return `<div class="leg ${l.side > 0 ? 'buy' : 'sell'} ${opt ? '' : 'hide-opt'}" data-id="${l.id}">
    <div class="row">
      <div><label>方向</label><div class="seg"><button data-f="side" data-v="1" class="b${l.side > 0 ? ' on' : ''}">買入</button><button data-f="side" data-v="-1" class="s${l.side < 0 ? ' on' : ''}">沽出</button></div></div>
      <div><label>類型</label><select data-f="type"><option value="call"${l.type === 'call' ? ' selected' : ''}>Call 認購</option><option value="put"${l.type === 'put' ? ' selected' : ''}>Put 認沽</option><option value="stock"${l.type === 'stock' ? ' selected' : ''}>正股</option></select></div>
      <div class="optonly"><label>行使價</label><input data-f="strike" type="number" step="any" inputmode="decimal"></div>
      <div><label>${opt ? '張數' : '股數'}</label><input data-f="qty" type="number" step="1" min="0" inputmode="numeric"></div>
      <div class="optonly"><label>到期日</label><input data-f="expiry" type="date"></div>
      <div class="optonly"><label>IV %</label><input data-f="iv" type="number" step="any" inputmode="decimal"></div>
      <div><label>${opt ? '期權金/股' : '買入價'}</label><input data-f="premium" type="number" step="any" inputmode="decimal"></div>
      <div class="acts"><button class="btn${l.locked ? ' locked' : ''}" data-act="lock" title="鎖定期權金（唔會自動更新）">${l.locked ? '🔒' : '🔓'}</button><button class="btn" data-act="del" title="刪除">✕</button></div>
    </div>
    <div class="info"></div></div>`;
}
function renderLegs() {
  $('legs').innerHTML = state.legs.length ? state.legs.map(legHTML).join('') : '<div class="note">未有期權腳 — 揀模板或者撳下面「＋」加腳</div>';
  $('legCount').textContent = state.legs.length ? `（${state.legs.length} 腳）` : '';
  updateLegFields(true);
  renderTemplates();
}
function setVal(el, v, force) { if (!el || (!force && document.activeElement === el)) return; el.value = v; }
function updateLegFields(force) {
  const c = ctx();
  for (const l of state.legs) {
    const root = document.querySelector(`.leg[data-id="${l.id}"]`); if (!root) continue;
    const q = f => root.querySelector(`[data-f="${f}"]`);
    setVal(q('strike'), l.strike ?? '', force); setVal(q('qty'), l.qty, force); setVal(q('expiry'), l.expiry || '', force);
    setVal(q('iv'), l.iv != null ? Math.round(l.iv * 10000) / 100 : '', force);
    setVal(q('premium'), l.premium != null ? l.premium : '', force);
    const info = [];
    const mult = l.type === 'stock' ? 1 : c.mult;
    const cash = -l.side * l.premium * l.qty * mult;
    if (l.type !== 'stock') {
      const T = legT(l); const g = M.bs(l.type, c.spot, l.strike, T, c.r, c.q, Math.max(0.0001, l.iv));
      const mny = l.type === 'call' ? (c.spot - l.strike) / c.spot : (l.strike - c.spot) / c.spot;
      const theo = !l.locked && l.src === 'bs';
      let srcTxt = '⚠️ 理論價 非市場';
      if (l.locked) srcTxt = '🔒 手動';
      else if (l.src === 'chain') {
        if (backend && !(chainMeta && chainMeta.via)) srcTxt = 'Yahoo 期權鏈';
        else {
          const vendor = chainVendor();
          const via = chainMeta && chainMeta.via;
          srcTxt = via === 'baked' ? `內置 ${vendor} 延遲鏈` : via === 'session' ? `快取 ${vendor} 鏈` : `${vendor} 延遲鏈`;
        }
      }
      info.push(`<span class="src${l.src === 'chain' && !l.locked ? ' mkt' : ''}${theo ? ' theo' : ''}">${srcTxt}</span>`);
      info.push(`理論價 <b>${fmt(g.price, 3)}</b>`);
      if (l.bid != null || l.ask != null) info.push(`Bid/Ask <b>${fmt(l.bid)} / ${fmt(l.ask)}</b>`);
      info.push(`${Math.abs(mny) < 0.005 ? '平價 ATM' : mny > 0 ? '價內 ITM' : '價外 OTM'} <b>${pct(Math.abs(mny), 1)}</b>`);
      info.push(`Δ <b>${(g.delta * l.side).toFixed(3)}</b>`);
      info.push(`Θ/日 <b class="${cls(g.theta * l.side)}">${money(g.theta * l.side * l.qty * mult)}</b>`);
      info.push(`${M.daysBetween(c.today, l.expiry)} 日`);
    }
    info.push(`${cash >= 0 ? '收' : '付'} <b class="${cls(cash)}">${money(Math.abs(cash))}</b>`);
    root.querySelector('.info').innerHTML = info.join('');
    root.querySelector('[data-act="lock"]').textContent = l.locked ? '🔒' : '🔓';
    root.querySelector('[data-act="lock"]').classList.toggle('locked', l.locked);
  }
}
function onLegInput(e) {
  const root = e.target.closest('.leg'); if (!root) return;
  const l = state.legs.find(x => x.id === +root.dataset.id); if (!l) return;
  const f = e.target.dataset.f; const v = e.target.value; const c = ctx();
  if (f === 'strike') { l.strike = parseFloat(v); priceLeg(l); }
  else if (f === 'qty') { l.qty = Math.max(0, parseFloat(v) || 0); }
  else if (f === 'expiry') { if (!v) return; l.expiry = v; l.tag = 'custom'; loadChains().then(() => { priceLeg(l); updateLegFields(); recalc(); }); priceLeg(l); }
  else if (f === 'iv') { const x = parseFloat(v); if (!(x > 0)) return; l.iv = x / 100; if (l.type !== 'stock') { l.premium = r4(M.bs(l.type, c.spot, l.strike, legT(l), c.r, c.q, l.iv).price); l.src = 'bs'; l.locked = false; } }
  else if (f === 'premium') {
    const x = parseFloat(v); if (!(x >= 0)) return; l.premium = x; l.locked = true; l.src = 'manual';
    if (l.type !== 'stock') { const iv = M.impliedVol(l.type, x, c.spot, l.strike, legT(l), c.r, c.q); if (iv) l.iv = iv; }
  } else if (f === 'type') {
    l.type = v; l.locked = false;
    if (v === 'stock') { l.qty = state.mult * Math.max(1, state.lots); l.strike = null; }
    else { if (!(l.strike > 0)) l.strike = snapStrike(c.spot, l.expiry || state.expiry); if (!l.expiry) l.expiry = state.expiry; if (l.qty >= state.mult && state.mult > 1) l.qty = Math.max(1, Math.round(l.qty / state.mult)); }
    priceLeg(l); renderLegs(); recalc(); return;
  }
  updateLegFields(); recalc();
}
function onLegClick(e) {
  const b = e.target.closest('button'); if (!b) return;
  const root = b.closest('.leg'); if (!root) return;
  const l = state.legs.find(x => x.id === +root.dataset.id); if (!l) return;
  if (b.dataset.f === 'side') { l.side = +b.dataset.v; renderLegs(); recalc(); }
  else if (b.dataset.act === 'del') { state.legs = state.legs.filter(x => x !== l); renderLegs(); recalc(); }
  else if (b.dataset.act === 'lock') { l.locked = !l.locked; if (!l.locked) priceLeg(l); updateLegFields(true); recalc(); }
}
function addLeg(type) {
  if (!(state.spot > 0)) { toast('請先輸入現價'); return; }
  const l = type === 'stock' ? newLeg({ type: 'stock', qty: state.mult, premium: state.spot })
    : newLeg({ type, strike: snapStrike(state.spot, state.expiry) });
  priceLeg(l); state.legs.push(l); state.tpl = null; renderTemplates(); renderLegs(); recalc();
}

// ================= 結果 =================
function profitRanges(f, lo, hi) {
  const N = 600, out = []; let start = null;
  for (let i = 0; i <= N; i++) {
    const x = lo + (hi - lo) * i / N, p = f(x) > 1e-9;
    if (p && start === null) start = x;
    if ((!p || i === N) && start !== null) { out.push([start, p ? Infinity : x]); start = null; }
  }
  return out;
}
let lastRes = null;
function recalc(rebuildChart) {
  renderDte();
  const c = ctx();
  const legs = state.legs.filter(l => l.qty > 0 && (l.type === 'stock' || (l.strike > 0 && l.expiry)));
  const res = (c.spot > 0 && legs.length) ? M.analyze(legs, c) : null;
  lastRes = res;
  const evalMax = res ? Math.max(0, res.dte) : 0;
  $('evalDays').max = evalMax; if (state.evalDays > evalMax) state.evalDays = evalMax; $('evalDays').value = state.evalDays;
  $('evalLbl').textContent = state.evalDays === 0 ? '今日 (T+0)' : `${M.isoDate(M.addDays(c.today, state.evalDays))}（T+${state.evalDays}，距到期 ${evalMax - state.evalDays} 日）`;
  $('ivShiftLbl').textContent = (state.ivShift > 0 ? '+' : '') + state.ivShift + '%';
  $('rangeLbl').textContent = '±' + state.range + '%';
  renderSummary(res, legs);
  renderChart(res, legs);
  renderTable(res, legs);
  save();
}
function kpi(k, v, s = '', klass = '') { return `<div class="kpi"><div class="k">${k}</div><div class="v ${klass}">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`; }
function renderSummary(res, legs) {
  if (!res) {
    $('heroLabel').textContent = '淨期權金'; $('heroVal').textContent = '—'; $('heroVal').className = 'hval';
    $('heroSub').textContent = state.spot > 0 ? '揀模板或者加期權腳即開始計算' : '請先攞報價或者輸入現價';
    $('kpis').innerHTML = ''; $('greeks').innerHTML = ''; $('insight').innerHTML = ''; return;
  }
  const c = ctx();
  const credit = res.credit;
  $('heroLabel').textContent = credit >= 0 ? '💰 淨收期權金 Net Credit' : '💸 淨付期權金 Net Debit';
  $('heroVal').textContent = money(Math.abs(credit)); $('heroVal').className = 'hval ' + (credit >= 0 ? 'pos' : 'neg');
  const nOpt = legs.filter(l => l.type !== 'stock').reduce((a, l) => a + l.qty, 0);
  $('heroSub').innerHTML = `${state.symbol || '自訂'} @ ${cur()}${fmt(c.spot)} ｜ 共 ${nOpt} 張期權 × ${c.mult} 股` +
    (res.stockCost ? ` ｜ 正股成本 ${money(res.stockCost)}` : '') + ` ｜ 到期 ${res.expiry}（${res.dte} 日）`;
  const be = res.breakevens.length ? res.breakevens.map(x => `${fmt(x)} <small>(${((x / c.spot - 1) * 100).toFixed(1)}%)</small>`).join('<br>') : '冇';
  const capLbl = res.capitalKind === 'margin' ? '估算保證金 (Reg-T)' : '所需本金 / 風險資金';
  const k = [];
  k.push(kpi('最大盈利', money(res.maxProfit), isFinite(res.maxProfit) ? `到期股價 ${res.maxProfitDir} 時` : '股價越升越賺', 'pos'));
  k.push(kpi('最大虧損', money(res.maxLoss), isFinite(res.maxLoss) ? `到期股價 ${res.maxLossDir} 時` : '⚠️ 股價大升時無上限', 'neg'));
  k.push(kpi('打和點 (到期)', be));
  k.push(kpi('獲利機率 POP', pct(res.pop, 1), `以 IV ${pct(res.popSigma, 1)} 估算`));
  k.push(kpi('回報 / 風險', res.rewardRisk != null ? fmt(res.rewardRisk, 2) + ' 倍' : '—', res.rewardRisk != null ? `最大盈利 ÷ 最大虧損（每蝕 1 搏賺 ${fmt(res.rewardRisk, 2)}）` : ''));
  k.push(kpi(capLbl, money(res.capital), res.capitalKind === 'margin' ? '粗略估算，以券商為準' : '最大虧損 + 期權金收入'));
  k.push(kpi('單筆回報率', pct(res.returnPct), credit > 0 ? '期權金收入 ÷ 本金' : '最大盈利 ÷ 本金'));
  k.push(kpi('年化回報 (單利)', pct(res.annualSimple, 1), `÷ ${res.dte} 日 × 365`, 'pos'));
  k.push(kpi('年化回報 (複利)', pct(res.annualCompound, 1), '(1+r)^(365/日數) − 1'));
  k.push(kpi('到期日數 DTE', `${res.dte} 日`, res.expiry));
  k.push(kpi('預期波幅 ±1σ', `±${fmt(res.expectedMove)}`, `${fmt(c.spot - res.expectedMove)} – ${fmt(c.spot + res.expectedMove)}`));
  k.push(kpi('股息率 / 利率', `${fmt(state.divYield, 2)}% / ${fmt(state.rate, 2)}%`, 'BSM 模型參數'));
  $('kpis').innerHTML = k.join('');
  const t = res.total;
  $('greeks').innerHTML = [
    kpi('Delta Δ', fmt(t.delta, 1), `≈ ${fmt(t.delta, 0)} 股正股 ｜ ${money(t.delta * c.spot, 0)}`, cls(t.delta)),
    kpi('Gamma Γ', fmt(t.gamma, 3), '股價每郁 1，Δ 變幾多'),
    kpi('Theta Θ / 日', money(t.theta), t.theta >= 0 ? '時間值每日幫你賺' : '時間值每日蝕', cls(t.theta)),
    kpi('Vega / 1% IV', money(t.vega), t.vega >= 0 ? 'IV 升有利' : 'IV 跌有利', cls(t.vega)),
    kpi('Rho / 1% 利率', money(t.rho)),
    kpi('今日理論盈虧', money(M.positionPL(legs, c.spot, c.today, c)), '用現時 IV 估值', cls(M.positionPL(legs, c.spot, c.today, c))),
  ].join('');
  // 解讀
  const ins = [];
  const f = S => M.positionPL(legs, S, res.expiry, c);
  const bes = res.breakevens, rng = [];
  const edges = [0, ...bes, Infinity];
  for (let i = 0; i < edges.length - 1; i++) {
    const a = edges[i], b = edges[i + 1];
    const mid = b === Infinity ? (a || c.spot) * 1.5 + 1 : (a + b) / 2;
    if (f(mid) > 1e-9) rng.push([a, b]);
  }
  if (rng.length) ins.push('✅ 到期時股價喺 ' + rng.map(([a, b]) => b === Infinity ? `<b>${fmt(a)} 以上</b>` : a === 0 ? `<b>${fmt(b)} 以下</b>` : `<b>${fmt(a)} – ${fmt(b)}</b>`).join('、') + ' 就有錢賺。');
  else ins.push('⚠️ 到期時喺任何股價都唔賺錢，請檢查期權金／行使價。');
  const shortPuts = legs.filter(l => l.type === 'put' && l.side < 0);
  if (legs.length === 1 && shortPuts.length === 1) {
    const l = shortPuts[0]; const cost = l.strike - l.premium;
    ins.push(`🏷 接貨後實際成本 = ${fmt(l.strike)} − ${fmt(l.premium)} = <b>${fmt(cost)}</b>（比現價${cost < c.spot ? '低' : '高'} ${pct(Math.abs(cost / c.spot - 1), 1)}）；準備接貨本金 <b>${money(l.strike * l.qty * c.mult, 0)}</b>。`);
  }
  if (!isFinite(res.maxLoss)) ins.push('<span class="w">⚠️ 呢個組合有無限虧損風險（沽出冇保護嘅 Call），需要孖展戶口並設好止蝕。</span>');
  const q = state.quote || {};
  const nextEx = q.nextExDividendDate && q.nextExDividendDate > c.today ? q.nextExDividendDate : null;
  if (nextEx && nextEx <= res.expiry && legs.some(l => l.type === 'call' && l.side < 0)) ins.push(`<span class="w">⚠️ 到期前有除息日（${nextEx}），價內嘅 Short Call 有機會被提早行使。</span>`);
  if (legs.some(l => l.type !== 'stock' && l.src === 'bs' && !l.locked)) ins.push('<span class="w">⚠️ 有期權金係 Black-Scholes 理論價，唔係市場 Bid/Ask。' + (!state.expirations.length ? '未有市場期權鏈。' : '呢隻腳嘅到期日或行使價唔喺期權鏈上。') + '落盤前請用券商報價修改（改完會自動 🔒 鎖定並反推 IV）。</span>');
  if (new Set(legs.filter(l => l.type !== 'stock').map(l => l.expiry)).size > 1) ins.push('⏳ 呢個係跨到期日組合：「到期盈虧」以最早到期日計，遠期腳用 BS 理論價（受 IV 影響）。');
  $('insight').innerHTML = ins.map(x => `<div>${x}</div>`).join('');
}
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
const vlinePlugin = {
  id: 'vlines',
  afterDatasetsDraw(ch, args, opts) {
    const { ctx: g, chartArea: a, scales: { x } } = ch; if (!opts.lines) return;
    g.save();
    for (const L of opts.lines) {
      const px = x.getPixelForValue(L.x); if (px < a.left || px > a.right) continue;
      g.strokeStyle = L.color; g.setLineDash(L.dash || [4, 4]); g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(px, a.top); g.lineTo(px, a.bottom); g.stroke();
      g.setLineDash([]); g.fillStyle = L.color; g.font = '11px sans-serif'; g.textAlign = 'center';
      g.fillText(L.label, px, L.bottom ? a.bottom - 5 : a.top + 10 + (L.row || 0) * 12);
    }
    g.restore();
  },
};
function renderChart(res, legs) {
  const canvas = $('chart');
  if (!window.Chart) { canvas.parentElement.innerHTML = '<div class="note">⚠️ Chart.js 載入失敗</div>'; return; }
  const c = ctx();
  const ds = [];
  let lines = [];
  if (res) {
    const ks = legs.filter(l => l.type !== 'stock').map(l => l.strike);
    let lo = c.spot * (1 - state.range / 100), hi = c.spot * (1 + state.range / 100);
    lo = Math.max(0, lo); 
    const N = 240; const xs = new Set();
    for (let i = 0; i <= N; i++) xs.add(lo + (hi - lo) * i / N);
    ks.forEach(k => { if (k > lo && k < hi) xs.add(k); });
    res.breakevens.forEach(b => { if (b > lo && b < hi) xs.add(b); });
    xs.add(c.spot);
    const X = [...xs].sort((a, b) => a - b);
    const pos = cssVar('--pos'), neg = cssVar('--neg');
    ds.push({ label: `到期盈虧 (${res.expiry})`, data: X.map(x => ({ x, y: M.positionPL(legs, x, res.expiry, c) })),
      borderColor: pos, borderWidth: 2.5, pointRadius: 0, tension: 0,
      segment: { borderColor: s => ((s.p0.parsed.y + s.p1.parsed.y) / 2 >= 0 ? pos : neg) },
      fill: { target: 'origin', above: pos + '22', below: neg + '22' } });
    const c0 = { ...c };
    ds.push({ label: '今日 T+0', data: X.map(x => ({ x, y: M.positionPL(legs, x, c.today, c0) })),
      borderColor: cssVar('--blue'), borderDash: [6, 4], borderWidth: 2, pointRadius: 0, fill: false });
    if (state.evalDays > 0 && state.evalDays < res.dte) {
      const ed = M.isoDate(M.addDays(c.today, state.evalDays));
      ds.push({ label: `評估日 ${ed}`, data: X.map(x => ({ x, y: M.positionPL(legs, x, ed, c) })),
        borderColor: cssVar('--orange'), borderWidth: 2, pointRadius: 0, fill: false });
    }
    lines.push({ x: c.spot, color: cssVar('--muted'), label: `現價 ${fmt(c.spot)}`, bottom: true });
    res.breakevens.forEach((b, i) => lines.push({ x: b, color: cssVar('--purple'), label: `打和 ${fmt(b)}`, row: 1 + (i % 2), dash: [2, 3] }));
  }
  const ink = cssVar('--muted'), grid = cssVar('--line');
  if (!chart) {
    chart = new Chart(canvas, {
      type: 'line', data: { datasets: ds }, plugins: [vlinePlugin],
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { type: 'linear', title: { display: true, text: '到期股價', color: ink }, ticks: { color: ink, maxTicksLimit: 9 }, grid: { color: grid } },
          y: { title: { display: true, text: '盈虧', color: ink }, ticks: { color: ink, callback: v => fmt(v, 0) }, grid: { color: s => (s.tick.value === 0 ? ink : grid) } },
        },
        plugins: {
          legend: { labels: { color: ink, boxWidth: 14, font: { size: 11 } } },
          vlines: { lines },
          tooltip: { callbacks: {
            title: it => { const x = it[0].parsed.x; return `股價 ${fmt(x)}（${((x / ctx().spot - 1) * 100).toFixed(1)}%）`; },
            label: it => `${it.dataset.label}: ${money(it.parsed.y)}` } },
        },
      },
    });
  } else {
    chart.data.datasets = ds; chart.options.plugins.vlines.lines = lines; chart.update();
  }
}
function renderTable(res, legs) {
  const tb = $('plTable');
  if (!res) { tb.innerHTML = ''; return; }
  const c = ctx(); const ed = state.evalDays > 0 && state.evalDays < res.dte ? M.isoDate(M.addDays(c.today, state.evalDays)) : null;
  const steps = [-30, -20, -15, -10, -7.5, -5, -2.5, 0, 2.5, 5, 7.5, 10, 15, 20, 30].filter(p => Math.abs(p) <= Math.max(state.range, 10) + 0.01);
  const rows = steps.map(p => ({ S: c.spot * (1 + p / 100), kind: p === 0 ? 'spot' : '' }));
  res.breakevens.forEach(b => rows.push({ S: b, kind: 'be' }));
  rows.sort((a, b) => b.S - a.S);
  const cap = res.capital > 0 ? res.capital : null;
  let h = `<tr><th>股價</th><th>變動</th><th>到期盈虧</th>${cap ? '<th>回報%</th>' : ''}<th>今日 T+0</th>${ed ? `<th>${ed.slice(5)}</th>` : ''}</tr>`;
  for (const r of rows) {
    const pe = M.positionPL(legs, r.S, res.expiry, c), p0 = M.positionPL(legs, r.S, c.today, c);
    const pd = ed ? M.positionPL(legs, r.S, ed, c) : null;
    h += `<tr class="${r.kind}"><td>${fmt(r.S)}${r.kind === 'spot' ? ' 現價' : r.kind === 'be' ? ' 打和' : ''}</td><td>${((r.S / c.spot - 1) * 100).toFixed(1)}%</td>` +
      `<td class="${cls(pe)}">${money(pe, 0)}</td>${cap ? `<td class="${cls(pe)}">${pct(pe / cap, 1)}</td>` : ''}<td class="${cls(p0)}">${money(p0, 0)}</td>${ed ? `<td class="${cls(pd)}">${money(pd, 0)}</td>` : ''}</tr>`;
  }
  tb.innerHTML = h;
}

// ================= 儲存 / 同步 =================
let saveT;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try { const { quote, ...rest } = state; localStorage.setItem(LS_KEY, JSON.stringify({ ...rest, quote, legSeq })); } catch { }
  }, 300);
}
function load() {
  try { const s = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); if (!s) return false; Object.assign(state, s); legSeq = s.legSeq || 100; return true; } catch { return false; }
}
function syncInputs() {
  setVal($('spot'), state.spot ?? ''); setVal($('divYield'), state.divYield ?? 0); setVal($('rate'), state.rate);
  setVal($('mult'), state.mult); setVal($('ivDefault'), state.ivDefault); $('currency').value = state.currency;
  setVal($('lots'), state.lots); setVal($('width'), state.width); setVal($('proxy'), state.proxy || '');
  if (state.expiry) $('expiry').value = state.expiry;
  $('hvHint').textContent = state.quote && state.quote.hv30 ? `HV30 ${pct(state.quote.hv30, 1)}` : '';
  $('evalDays').value = state.evalDays; $('ivShift').value = state.ivShift; $('range').value = state.range;
  renderDte(); renderExpChips();
}

// ================= 事件 =================
function bind() {
  $('btnQuote').onclick = () => loadQuote($('ticker').value);
  $('ticker').addEventListener('keydown', e => { if (e.key === 'Enter') loadQuote($('ticker').value); });
  $('ticker').addEventListener('change', () => { const v = $('ticker').value; if (v && normalizeSymbol(v) !== state.symbol && /^[\w.^-]+$/.test(v.trim())) loadQuote(v); });
  let st;
  $('ticker').addEventListener('input', () => {
    clearTimeout(st); const q = $('ticker').value.trim(); if (!backend || q.length < 2 || /^\d+$/.test(q)) return;
    st = setTimeout(async () => { try { const r = await fetchJSON('api/search?q=' + encodeURIComponent(q), 6000);
      if (r.length) $('tickerList').innerHTML = r.map(x => `<option value="${esc(x.symbol)}">${esc(x.name)} · ${esc(x.exchange)}</option>`).join(''); } catch { } }, 350);
  });
  $('popChips').onclick = e => { const b = e.target.closest('[data-sym]'); if (b) loadQuote(b.dataset.sym); };
  const onNum = (id, key, after) => $(id).addEventListener('input', () => { const v = num($(id)); if (v == null) return; state[key] = v; after && after(); });
  onNum('spot', 'spot', () => { priceAll(); updateLegFields(); recalc(); });
  onNum('divYield', 'divYield', () => { priceAll(); updateLegFields(); recalc(); });
  onNum('rate', 'rate', () => { priceAll(); updateLegFields(); recalc(); });
  onNum('mult', 'mult', () => { state.multManual = true; updateLegFields(); recalc(); });
  onNum('ivDefault', 'ivDefault', () => { state.legs.forEach(l => { if (!l.locked && l.src !== 'chain') l.iv = state.ivDefault / 100; }); priceAll(); updateLegFields(); recalc(); });
  onNum('lots', 'lots'); onNum('width', 'width');
  $('lots').addEventListener('change', () => state.tpl && applyTemplate(state.tpl, true));
  $('width').addEventListener('change', () => state.tpl && applyTemplate(state.tpl, true));
  $('currency').onchange = () => { state.currency = $('currency').value; updateLegFields(); recalc(); };
  $('proxy').addEventListener('change', () => { state.proxy = $('proxy').value.trim(); save(); toast('已儲存 Proxy 設定'); });
  $('expiry').addEventListener('change', () => setExpiry($('expiry').value));
  $('expSelect').onchange = () => $('expSelect').value && setExpiry($('expSelect').value);
  $('expChips').onclick = e => { const b = e.target.closest('[data-exp]'); if (b) setExpiry(b.dataset.exp); };
  $('tplTabs').onclick = e => { const b = e.target.closest('[data-cat]'); if (b) { state.cat = b.dataset.cat; renderTemplates(); } };
  $('tplGrid').onclick = e => { const b = e.target.closest('[data-tpl]'); if (b) applyTemplate(b.dataset.tpl); };
  $('btnReapply').onclick = () => state.tpl ? applyTemplate(state.tpl) : toast('未揀模板');
  $('legs').addEventListener('input', onLegInput);
  $('legs').addEventListener('change', e => { if (e.target.tagName === 'SELECT') onLegInput(e); });
  $('legs').addEventListener('click', onLegClick);
  document.querySelectorAll('[data-add]').forEach(b => b.onclick = () => addLeg(b.dataset.add));
  $('btnReprice').onclick = async () => { await loadChains(); priceAll(); updateLegFields(true); recalc(); toast('已重新計算未鎖定嘅腳'); };
  $('btnClear').onclick = () => { state.legs = []; state.tpl = null; renderTemplates(); renderLegs(); recalc(); };
  $('evalDays').oninput = () => { state.evalDays = +$('evalDays').value; recalc(); };
  $('ivShift').oninput = () => { state.ivShift = +$('ivShift').value; recalc(); };
  $('range').oninput = () => { state.range = +$('range').value; recalc(); };
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (chart) { chart.destroy(); chart = null; } recalc(); });
}

// ================= 啟動 =================
async function init() {
  const had = load();
  if (!state.expiry || state.expiry <= todayISO()) state.expiry = M.isoDate(M.addDays(todayISO(), 30));
  renderPopular(); renderTemplates(); bind(); syncInputs();
  if (state.quote) renderQuote(state.quote);
  if (state.symbol) { $('ticker').value = state.symbol; setMultFromSymbol(state.quote); if (state.multManual) $('mult').value = state.mult; }
  renderLegs(); recalc(true);
  const params = new URLSearchParams(location.search);
  const sym = params.get('s') || params.get('symbol') || state.symbol || 'AAPL';
  if (params.get('t')) state.tpl = params.get('t');
  getRate().then(r => { if (r && r.rate) { state.rate = Math.round(r.rate * 10000) / 100; setVal($('rate'), state.rate); $('rate').title = r.source; priceAll(); updateLegFields(); recalc(); } });
  await loadQuote(sym, { silent: true });
}
init();
})();
