/* 個人讀圖草稿。只呈現資料檔，不落單、不讀持倉、不收集金鑰。 */

const FIELD_LABEL = {
  price: "價格",
  movingAverages: "均線",
  avwap: "AVWAP",
  atr: "ATR",
  structure: "結構",
  flow: "資金流",
  connectFlow: "南北向",
  alerts: "背離",
  commentary: "短評",
};

const KIND_LABEL = {
  demo: "示範",
  public_ohlcv: "公開行情",
  model_commentary: "模型短評",
  manual: "人手",
};

const MARKET_LABEL = { US: "美股", HK: "港股", CN: "中國" };
const INSTRUMENT_LABEL = { index: "指數", future: "期貨", stock: "股票", fund: "基金", custom: "自訂" };
const CCY_LABEL = { USD: "美元", HKD: "港元", CNY: "人民幣", point: "點" };
const FRAME_LABEL = { daily: "日線", h4: "4小時", h1: "1小時" };
const FRAME_CODE = { daily: "1D", h4: "4H", h1: "1H" };

/* TradingView 官方 Advanced Chart（tv.js）符號。先用官方 widget 實測可否開圖，再對公開代號頁及可用市場清單核對。不是資金流來源。 */
/* 2026-11-28 以官方 widgetembed 逐隻開圖核對。美股 ETF 用交易所前綴；MCHI 在 NASDAQ 不在 AMEX。510300 用 SSE:510300 可開圖。HKEX 基金顯示「此商品僅在 TradingView 上可用」。 */
const TV_SYMBOL = {
  SPX: "CAPITALCOM:US500",
  MES: "CAPITALCOM:US500",
  NVDA: "NASDAQ:NVDA",
  "0700.HK": "OTC:TCEHY",
  "0883.HK": "SSE:600938",
  SPY: "AMEX:SPY",
  VOO: "AMEX:VOO",
  QQQ: "NASDAQ:QQQ",
  DIA: "AMEX:DIA",
  VTI: "AMEX:VTI",
  IWM: "AMEX:IWM",
  MCHI: "NASDAQ:MCHI",
  FXI: "AMEX:FXI",
  "2800.HK": null,
  "2828.HK": "OTC:HSXUF",
  "3033.HK": null,
  "2823.HK": "OTC:IFXAF",
  "510300.SH": "SSE:510300",
};
const TV_REQUESTED = {
  SPX: "SP:SPX",
  MES: "CME_MINI:MES1!",
  NVDA: "NASDAQ:NVDA",
  "0700.HK": "HKEX:700",
  "0883.HK": "HKEX:883",
  SPY: "AMEX:SPY",
  VOO: "AMEX:VOO",
  QQQ: "NASDAQ:QQQ",
  DIA: "AMEX:DIA",
  VTI: "AMEX:VTI",
  IWM: "AMEX:IWM",
  MCHI: "NASDAQ:MCHI",
  FXI: "AMEX:FXI",
  "2800.HK": "HKEX:2800",
  "2828.HK": "HKEX:2828",
  "3033.HK": "HKEX:3033",
  "2823.HK": "HKEX:2823",
  "510300.SH": "SSE:510300",
};
const TV_SYMBOL_NOTE = {
  SPX: "官方嵌入元件不能顯示建議代號 SP:SPX（TradingView 說明「此商品僅在 TradingView 上可用」，即不允許在 widget 顯示；官方 widget 可用市場清單亦沒有該指數授權來源）。圖表改為顯示同一指數的 CAPITALCOM:US500（Capital.com 指示性數據，屬官方 widget「全球外匯／指數 CFD」可用市場）。不要使用裸代號 SPX，因 widget 會錯配到其他公司。",
  MES: "官方嵌入元件不能顯示建議代號 CME_MINI:MES1!（CME 微型期貨不在官方 widget 可用市場，元件顯示「此商品僅在 TradingView 上可用」）。圖表改為顯示 S&P 500 指數 CAPITALCOM:US500，這不是 MES 期貨合約本身。",
  "0700.HK": "官方嵌入元件不能顯示港交所代號 HKEX:700（此商品僅在 TradingView 網站提供；官方 widget 可用市場清單沒有 HKEX 股票）。圖表改為顯示同一公司的美國 OTC 預託證券 OTC:TCEHY（OTC Markets，延遲行情）。貨幣與價格與港股上市不同，不是港股資金流。",
  "0883.HK": "官方嵌入元件不能顯示港交所代號 HKEX:883（原因同上）。TradingView 上沒有可用的中海油美國 OTC／ADR 代號（例如 OTC:CEOHY、OTC:CEOHF、NYSE:CEO 均無法開圖）。圖表改為顯示同一公司的上交所 A 股 SSE:600938（日終數據，屬官方 widget 亞太可用市場）。貨幣與價格與港股上市不同，不是港股資金流。",
  "2800.HK": "官方嵌入元件不能顯示港交所代號 HKEX:2800（盈富基金，ISIN HK2800008867）。此商品僅在 TradingView 網站提供，官方 widget 沒有 HKEX 基金。同一基金沒有其他能夠開圖的上市（人民幣櫃檯 HKEX:82800 同樣開不到）。不會改用 EWH、恒指差價合約或其他產品代替。官方 widget 不能顯示這隻港交所報價。",
  "2828.HK": "官方嵌入元件不能顯示港交所代號 HKEX:2828（恒生中國企業指數ETF）。圖表改為顯示同一基金的美國場外報價 OTC:HSXUF（ISIN 同為 HK2828013055，官方 widget 圖例為 Hang Seng China Enterprises Index ETF）。貨幣與價格與港股上市不同，場外成交疏落，不是港股報價，也不是港股資金流。沒有改用其他指數產品。",
  "3033.HK": "官方嵌入元件不能顯示港交所代號 HKEX:3033（南方東英恒生科技指數ETF，ISIN HK0000642568）。此商品僅在 TradingView 網站提供。同一基金沒有其他能夠開圖的上市。不會改用 KWEB、CQQQ 或其他中國互聯網或科技產品代替。官方 widget 不能顯示這隻港交所報價。",
  "2823.HK": "官方嵌入元件不能顯示港交所代號 HKEX:2823（安碩富時中國A50 ETF）。圖表改為顯示同一基金的美國場外報價 OTC:IFXAF（ISIN 同為 HK2823028546，官方 widget 圖例為 iShares FTSE China A50 ETF）。貨幣與價格與港股上市不同，場外成交疏落，不是港股報價，也不是港股資金流。沒有改用 ASHR 或其他 A 股基金。",
};
const TV_INTERVAL = { daily: "D", h4: "240", h1: "60" };
const TV_SCRIPT = "https://s3.tradingview.com/tv.js";

const ATR_MIN = 0.5;
const ATR_MAX = 1.6;

let doc = null;
let market = "US";
let symbolId = "SPX";
let chartInterval = "daily";
let tvScriptPromise = null;
let chartMountId = 0;
let activeCustom = null;
const picker = { open: false, active: 0 };

document.getElementById("symbol-picker").addEventListener("focusin", (event) => {
  if (!doc || event.target.id !== "symbol-query") return;
  openPicker();
});

document.getElementById("symbol-picker").addEventListener("input", (event) => {
  if (!doc || event.target.id !== "symbol-query") return;
  picker.open = true;
  picker.active = 0;
  paintMenu();
});

document.getElementById("symbol-picker").addEventListener("keydown", (event) => {
  if (!doc || event.target.id !== "symbol-query") return;
  if (event.isComposing) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    movePicker(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    movePicker(-1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    choosePicker();
  } else if (event.key === "Escape") {
    event.preventDefault();
    closePicker();
    event.target.blur();
  }
});

document.getElementById("symbol-picker").addEventListener("mousedown", (event) => {
  const option = event.target.closest("[data-pick]");
  if (option) {
    event.preventDefault();
    choosePicker(Number(option.dataset.pick));
    return;
  }
  if (event.target.closest(".symbol-toggle")) {
    event.preventDefault();
    if (picker.open) closePicker();
    else openPicker();
  }
});

document.addEventListener("mousedown", (event) => {
  if (!picker.open) return;
  if (event.target.closest("#symbol-picker")) return;
  closePicker();
});

document.getElementById("symbol-picker").addEventListener("focusout", () => {
  setTimeout(() => {
    const host = document.getElementById("symbol-picker");
    if (!host || host.contains(document.activeElement)) return;
    closePicker();
  }, 120);
});

document.getElementById("market-switch").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-market]");
  if (!button || !doc) return;
  const next = firstSymbol(button.dataset.market);
  if (!next) return;
  location.hash = `#${next.market}/${encodeURIComponent(next.symbol)}`;
});

window.addEventListener("hashchange", () => {
  if (!doc) return;
  applyHash();
  render();
});

document.getElementById("main").addEventListener("click", (event) => {
  const button = event.target.closest("[data-chart-frame]");
  if (!button || !doc) return;
  setChartInterval(button.dataset.chartFrame);
});

document.getElementById("main").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const card = event.target.closest("article[data-chart-frame]");
  if (!card || event.target !== card) return;
  event.preventDefault();
  setChartInterval(card.dataset.chartFrame);
});

boot();

async function boot() {
  try {
    const response = await fetch(resolveDataUrl(), { cache: "no-store" });
    if (!response.ok) {
      throw new Error("無法讀取數據（HTTP " + response.status + "）");
    }
    doc = await response.json();
    const problems = clientProblems(doc);
    if (problems.length) throw new Error(problems.join("；"));
    if (!location.hash) {
      const first = firstSymbol("US") || doc.symbols[0];
      history.replaceState(null, "", `#${first.market}/${encodeURIComponent(first.symbol)}`);
    }
    applyHash();
    render();
  } catch (error) {
    showError(error);
  }
}

function resolveDataUrl() {
  const raw = new URLSearchParams(location.search).get("data");
  if (!raw) return "data/demo.json";
  if (!/^[A-Za-z0-9_./-]+\.json$/.test(raw) || raw.includes("..") || raw.startsWith("/")) {
    throw new Error("數據路徑不接受。只可讀取本站內的 .json 檔。");
  }
  return raw;
}

function clientProblems(data) {
  const problems = [];
  if (!data || typeof data !== "object" || !data.meta || !Array.isArray(data.symbols) || !Array.isArray(data.sources)) {
    problems.push("數據文件缺少 meta、sources 或 symbols");
    return problems;
  }
  if (!data.sources.length) problems.push("缺少數據來源");
  if (!data.symbols.length) problems.push("沒有任何代號");
  return problems;
}

function firstSymbol(nextMarket) {
  const order = Array.isArray(doc.meta.watchlist) ? doc.meta.watchlist : [];
  const list = doc.symbols.filter((item) => item.market === nextMarket);
  list.sort((a, b) => {
    const ai = order.indexOf(a.symbol);
    const bi = order.indexOf(b.symbol);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  return list[0] || null;
}

function applyHash() {
  const raw = decodeURIComponent((location.hash || "").replace(/^#/, ""));
  const slash = raw.indexOf("/");
  const nextMarket = slash === -1 ? "" : raw.slice(0, slash);
  const nextSymbol = slash === -1 ? "" : raw.slice(slash + 1);
  const found = doc.symbols.find((item) => item.market === nextMarket && item.symbol === nextSymbol)
    || (nextSymbol ? doc.symbols.find((item) => item.symbol === nextSymbol) : null);
  if (found) {
    activeCustom = null;
    market = found.market;
    symbolId = found.symbol;
    return;
  }
  const resolved = resolveFreeText(nextSymbol, nextMarket);
  if (resolved && resolved.type === "catalog") {
    activeCustom = null;
    market = resolved.item.market;
    symbolId = resolved.item.symbol;
    return;
  }
  if (resolved && resolved.type === "custom") {
    activeCustom = buildCustom(resolved);
    market = activeCustom.market;
    symbolId = activeCustom.symbol;
    return;
  }
  activeCustom = null;
  const fallback = firstSymbol("US") || doc.symbols[0];
  market = fallback.market;
  symbolId = fallback.symbol;
}

function currentView() {
  const found = doc.symbols.find((item) => item.market === market && item.symbol === symbolId);
  if (found) return found;
  if (activeCustom && activeCustom.market === market && activeCustom.symbol === symbolId) return activeCustom;
  return doc.symbols[0];
}

function render() {
  picker.open = false;
  const symbol = currentView();
  market = symbol.market;
  symbolId = symbol.symbol;
  const plan = chartPlan(symbol);
  fillChrome();
  document.getElementById("main").innerHTML = renderMain(symbol);
  document.title = `資金流與價格行為 · ${symbol.symbol}`;
  document.body.dataset.ready = "1";
  document.body.dataset.symbol = symbol.symbol;
  document.body.dataset.market = symbol.market;
  document.body.dataset.tv = plan.mode === "unavailable" ? "unavailable" : plan.tv;
  document.body.dataset.chartMode = plan.mode;
  mountChart(symbol);
}

function fillChrome() {
  const time = document.getElementById("updated-time");
  time.innerHTML = `<time datetime="${esc(doc.meta.asOf || "")}">${esc(formatHkt(doc.meta.asOf))}</time>`;
  const zone = doc.meta.timezone === "Asia/Shanghai" ? "Asia/Shanghai" : "Asia/Hong_Kong";
  document.getElementById("updated-tz").textContent = `HKT · ${zone}（與 Asia/Shanghai 同為 UTC+8）`;
  document.getElementById("data-label").textContent = doc.meta.label || "未標明";

  const markets = ["US", "HK", "CN"].filter((code) => doc.symbols.some((item) => item.market === code));
  document.getElementById("market-switch").innerHTML =
    `<span class="switch-label">市場</span>` +
    markets.map((code) => {
      const pressed = code === market ? "true" : "false";
      return `<button type="button" data-market="${code}" aria-pressed="${pressed}">${MARKET_LABEL[code]}<span class="code">${code}</span></button>`;
    }).join("");

  renderPickerShell();
}

function pickerLabel(symbol) {
  return `${symbol.symbol} · ${symbol.name || ""}`.trim();
}

function renderPickerShell() {
  const symbol = currentView();
  document.getElementById("symbol-picker").innerHTML = `
    <label class="switch-label" for="symbol-query">代號</label>
    <div class="symbol-combo">
      <input id="symbol-query" type="text" role="combobox" autocomplete="off" spellcheck="false"
        aria-expanded="false" aria-controls="symbol-menu" aria-autocomplete="list"
        aria-label="搜尋或輸入代號" placeholder="搜尋或輸入代號" value="${esc(pickerLabel(symbol))}">
      <button type="button" class="symbol-toggle" aria-label="展開代號清單" aria-expanded="false">▾</button>
      <div id="symbol-menu" class="symbol-menu" role="listbox" aria-label="代號" hidden></div>
    </div>
  `;
}

function openPicker() {
  const wasOpen = picker.open;
  picker.open = true;
  const input = document.getElementById("symbol-query");
  if (input && document.activeElement === input && input.value === pickerLabel(currentView())) {
    input.value = "";
  }
  if (!wasOpen) {
    const view = currentView();
    const index = pickerChoices().findIndex((choice) => choice.item && choice.item.symbol === view.symbol && choice.item.market === view.market);
    picker.active = index >= 0 ? index : 0;
  }
  paintMenu();
}

function closePicker() {
  picker.open = false;
  const menu = document.getElementById("symbol-menu");
  const input = document.getElementById("symbol-query");
  const toggle = document.querySelector("#symbol-picker .symbol-toggle");
  if (menu) {
    menu.hidden = true;
    menu.innerHTML = "";
  }
  if (input) {
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    if (document.activeElement !== input) input.value = pickerLabel(currentView());
  }
  if (toggle) {
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "展開代號清單");
  }
}

function currentQuery() {
  const input = document.getElementById("symbol-query");
  if (!input) return "";
  const value = input.value.trim();
  if (value === pickerLabel(currentView())) return "";
  return value;
}

function pickerChoices() {
  const query = currentQuery();
  const q = query.toUpperCase();
  const order = Array.isArray(doc.meta.watchlist) ? doc.meta.watchlist : [];
  const rank = (item) => {
    const index = order.indexOf(item.symbol);
    return index === -1 ? 99 : index;
  };
  const list = doc.symbols.filter((item) => {
    if (!q) return item.market === market;
    return item.symbol.toUpperCase().includes(q)
      || String(item.name || "").toUpperCase().includes(q)
      || String(TV_REQUESTED[item.symbol] || "").toUpperCase().includes(q);
  }).sort((a, b) => rank(a) - rank(b) || a.symbol.localeCompare(b.symbol, "en"));
  const choices = list.map((item) => ({ item }));
  if (!q) return choices;
  const resolved = resolveFreeText(query, market);
  if (!resolved) return choices;
  if (resolved.type === "catalog") {
    if (!choices.some((choice) => choice.item.symbol === resolved.item.symbol)) choices.unshift({ item: resolved.item });
    return choices;
  }
  choices.push({ custom: resolved });
  return choices;
}

function paintMenu() {
  const menu = document.getElementById("symbol-menu");
  const input = document.getElementById("symbol-query");
  const toggle = document.querySelector("#symbol-picker .symbol-toggle");
  if (!menu || !input) return;
  const choices = pickerChoices();
  if (picker.active >= choices.length) picker.active = Math.max(0, choices.length - 1);
  menu.hidden = !picker.open;
  input.setAttribute("aria-expanded", picker.open ? "true" : "false");
  if (toggle) {
    toggle.setAttribute("aria-expanded", picker.open ? "true" : "false");
    toggle.setAttribute("aria-label", picker.open ? "收合代號清單" : "展開代號清單");
  }
  if (!picker.open) {
    menu.innerHTML = "";
    return;
  }
  if (!choices.length) {
    input.removeAttribute("aria-activedescendant");
    menu.innerHTML = `<p class="symbol-empty">沒有符合的代號。可輸入交易所前綴，例如 NASDAQ:AAPL，或港股 0700.HK。</p>`;
    return;
  }
  const view = currentView();
  menu.innerHTML = choices.map((choice, index) => {
    const selected = index === picker.active ? "true" : "false";
    if (choice.item) {
      const item = choice.item;
      const current = item.symbol === view.symbol && item.market === view.market;
      return `<button type="button" class="symbol-option${current ? " is-current" : ""}" role="option" id="symbol-opt-${index}" data-pick="${index}" aria-selected="${selected}">
        <span class="sym">${esc(item.symbol)}</span>
        <span class="sym-name">${esc(item.name || "")}</span>
        <span class="sym-meta">${esc(MARKET_LABEL[item.market] || item.market)} · ${esc(INSTRUMENT_LABEL[item.instrument] || "")}</span>
      </button>`;
    }
    const custom = choice.custom;
    const label = custom.tvMode === "unavailable" ? "不能顯示港交所報價" : "載入官方圖表";
    return `<button type="button" class="symbol-option" role="option" id="symbol-opt-${index}" data-pick="${index}" aria-selected="${selected}">
      <span class="sym">${esc(custom.symbol)}</span>
      <span class="sym-name">${esc(label)}</span>
      <span class="sym-meta">${esc(MARKET_LABEL[custom.market] || custom.market)} · 自訂</span>
    </button>`;
  }).join("");
  const active = document.getElementById(`symbol-opt-${picker.active}`);
  if (active) input.setAttribute("aria-activedescendant", active.id);
  else input.removeAttribute("aria-activedescendant");
}

function movePicker(delta) {
  if (!picker.open) openPicker();
  const total = pickerChoices().length;
  if (!total) return;
  picker.active = (picker.active + delta + total) % total;
  paintMenu();
}

function choosePicker(index) {
  const choices = pickerChoices();
  const choice = choices[Number.isInteger(index) ? index : picker.active];
  let target = null;
  if (choice && choice.item) target = choice.item;
  else if (choice && choice.custom) target = choice.custom;
  else {
    const resolved = resolveFreeText(currentQuery(), market);
    if (!resolved) {
      closePicker();
      return;
    }
    target = resolved.type === "catalog" ? resolved.item : resolved;
  }
  const next = `#${target.market}/${encodeURIComponent(target.symbol)}`;
  if (location.hash === next) {
    applyHash();
    render();
    return;
  }
  location.hash = next;
}

function normalizeTicker(raw) {
  return String(raw || "").trim().replace(/\s+/g, "").toUpperCase();
}

function catalogByHkCode(digits) {
  const body = String(digits || "").replace(/^0+/, "");
  if (!body) return null;
  const padded = body.padStart(4, "0") + ".HK";
  return doc.symbols.find((item) => item.symbol.toUpperCase() === padded) || null;
}

function findCatalogSymbol(query) {
  const q = normalizeTicker(query);
  if (!q) return null;
  const exact = doc.symbols.find((item) => item.symbol.toUpperCase() === q);
  if (exact) return exact;
  const named = doc.symbols.filter((item) => String(item.name || "").replace(/\s+/g, "").toUpperCase() === q);
  if (named.length === 1) return named[0];
  if (/^\d{1,5}(?:\.HK)?$/.test(q)) {
    const hit = catalogByHkCode(q.replace(/\.HK$/, ""));
    if (hit) return hit;
  }
  const requested = Object.keys(TV_REQUESTED).find((key) => TV_REQUESTED[key].toUpperCase() === q);
  if (requested) return doc.symbols.find((item) => item.symbol === requested) || null;
  return null;
}

function resolveFreeText(raw, marketHint) {
  const q = normalizeTicker(raw);
  if (!q || q.length > 32) return null;
  const catalog = findCatalogSymbol(q);
  if (catalog) return { type: "catalog", item: catalog };

  const qualified = q.match(/^([A-Z][A-Z0-9_]{0,14}):([A-Z0-9][A-Z0-9.!]{0,23})$/);
  if (qualified) {
    const exchange = qualified[1];
    const tv = `${exchange}:${qualified[2]}`;
    if (exchange === "HKEX") {
      const listed = catalogByHkCode(qualified[2]);
      if (listed) return { type: "catalog", item: listed };
      const symbol = /^\d+$/.test(qualified[2]) ? qualified[2].replace(/^0+/, "").padStart(4, "0") + ".HK" : tv;
      return customResolved("HK", symbol, "unavailable", "", tv, `官方嵌入元件不能顯示港交所代號 ${tv}。這個自訂代號沒有已核對、而且屬同一商品的後備上市，所以不會改顯示其他產品。官方 widget 不能顯示這隻港交所報價。`);
    }
    const nextMarket = exchange === "SSE" || exchange === "SZSE" ? "CN" : "US";
    const symbol = exchange === "SSE" && /^\d{6}$/.test(qualified[2])
      ? `${qualified[2]}.SH`
      : exchange === "SZSE" && /^\d{6}$/.test(qualified[2])
        ? `${qualified[2]}.SZ`
        : tv;
    const again = findCatalogSymbol(symbol);
    if (again) return { type: "catalog", item: again };
    return customResolved(nextMarket, symbol, "direct", tv, tv, "");
  }

  if (/^\d{1,5}\.HK$/.test(q)) {
    const symbol = q.replace(/\.HK$/, "").replace(/^0+/, "").padStart(4, "0") + ".HK";
    const requested = `HKEX:${Number(q.replace(/\.HK$/, ""))}`;
    return customResolved("HK", symbol, "unavailable", "", requested, `官方嵌入元件不能顯示港交所代號 ${requested}。這個自訂代號沒有已核對、而且屬同一商品的後備上市，所以不會改顯示其他產品。官方 widget 不能顯示這隻港交所報價。`);
  }

  const cn = q.match(/^(\d{6})(?:\.(SH|SZ|SS))?$/);
  if (cn && (cn[2] || marketHint === "CN")) {
    const venue = cn[2] === "SZ" ? "SZ" : cn[2] ? "SH" : (/^[013]/.test(cn[1]) ? "SZ" : "SH");
    const symbol = `${cn[1]}.${venue === "SH" ? "SH" : "SZ"}`;
    const listed = findCatalogSymbol(symbol);
    if (listed) return { type: "catalog", item: listed };
    const tv = `${venue === "SH" ? "SSE" : "SZSE"}:${cn[1]}`;
    return customResolved("CN", symbol, "direct", tv, tv, "");
  }

  if (/^[A-Z][A-Z0-9.-]{0,9}$/.test(q)) {
    return customResolved("US", q, "bare", q, q, `此代號不在預設名單，已交由 TradingView 官方 widget 解析「${q}」。若開出的不是你要的商品，請改輸入交易所前綴，例如 NASDAQ:${q}。裸代號有時會錯配到其他公司。`);
  }
  return null;
}

function customResolved(nextMarket, symbol, tvMode, tv, requested, note) {
  return {
    type: "custom",
    market: nextMarket,
    symbol,
    name: "自訂代號",
    tvMode,
    tv,
    requested,
    note,
  };
}

function buildCustom(resolved) {
  return {
    symbol: resolved.symbol,
    name: resolved.name || "自訂代號",
    market: resolved.market,
    instrument: "custom",
    currency: "",
    custom: true,
    tvMode: resolved.tvMode,
    tv: resolved.tv || "",
    tvRequested: resolved.requested || resolved.symbol,
    tvNote: resolved.note || "",
  };
}

function renderMain(symbol) {
  const missingWatch = (doc.meta.watchlist || []).filter((id) => !doc.symbols.some((item) => item.symbol === id));
  const watchNote = missingWatch.length
    ? `<p class="hint">觀察名單有代號未出現在文件內：${esc(missingWatch.join("、"))}</p>`
    : "";
  return `
    <p class="permanent">私人草稿 · 只做分析呈現 · 不落單 · 不顯示持倉 · 頁面不收集金鑰</p>
    <p class="disclaimer">${esc(doc.meta.disclaimer || "未提供聲明。")}</p>
    <p class="legend">顏色按港股習慣：紅色代表上升或淨流入，綠色代表下跌或淨流出。方向同時用文字標出。資金流若寫明示範，就不是真實大單。</p>
    ${watchNote}
    ${renderPrice(symbol)}
    ${renderChart(symbol)}
    <section class="grid-3" id="panel-structure" aria-label="市場結構">${renderFrames(symbol)}</section>
    ${symbol.structure ? `<p class="quiet structure-hint">點選日線、4小時或 1小時結構區塊，圖表會切換至同一週期。</p>` : ""}
    <section class="grid-2">
      ${renderMovingAverages(symbol)}
      <div class="stack">
        ${renderAvwap(symbol)}
        ${renderAtr(symbol)}
      </div>
    </section>
    <section class="grid-2">
      ${renderFlow(symbol)}
      ${renderAlerts(symbol)}
    </section>
    ${renderCommentary(symbol)}
    ${renderSources(symbol)}
    ${renderMethods()}
  `;
}

function renderPrice(symbol) {
  const quote = symbol.quote;
  if (!quote) {
    const blocked = chartPlan(symbol).mode === "unavailable";
    const priceNote = blocked
      ? "本代號沒有手作價格快照。官方 widget 也不能顯示這隻港交所報價，所以不會改放其他產品的圖。"
      : "本代號沒有手作價格快照。請看下方官方圖表，不要把其他代號的價格當成這隻。";
    return `
      <section id="panel-price" class="price-block">
        <div>
          <p class="identity"><strong>${esc(symbol.name || "未提供")}</strong> · ${esc(symbol.symbol || "")}</p>
          <p class="identity">${esc(MARKET_LABEL[symbol.market] || symbol.market || "未提供")} · ${esc(INSTRUMENT_LABEL[symbol.instrument] || "未提供")}${symbol.currency ? ` · ${esc(CCY_LABEL[symbol.currency] || symbol.currency)}` : ""}</p>
          <span class="badge">示範</span>
          <p class="missing">${priceNote}</p>
        </div>
      </section>
    `;
  }
  const priceKind = quote.priceKind === "public_ohlcv" ? "公開行情" : "示範快照";
  return `
    <section id="panel-price" class="price-block">
      <div>
        <p class="identity"><strong>${esc(symbol.name || "未提供")}</strong> · ${esc(symbol.symbol || "")}</p>
        <p class="identity">${esc(MARKET_LABEL[symbol.market] || symbol.market || "未提供")} · ${esc(INSTRUMENT_LABEL[symbol.instrument] || "未提供")} · ${esc(CCY_LABEL[symbol.currency] || "未提供")} · 時段 ${esc(quote.session || "未提供")}</p>
        <p class="session-note">${esc(quote.sessionNote || "")}</p>
        <span class="badge">${priceKind}</span>
      </div>
      <div class="price-figures">
        <p class="price-num">${fmt(quote.last, 2)}</p>
        <p class="price-change ${dirClass(quote.change)}">${fmtSigned(quote.change, 2)}　${fmtSigned(quote.changePct, 2)}%</p>
      </div>
    </section>
  `;
}

function renderFrames(symbol) {
  const structure = symbol.structure;
  if (!structure) {
    return `<article class="card"><h2>市場結構</h2><p class="missing">本代號暫無價格行為示範。</p></article>`;
  }
  return ["daily", "h4", "h1"].map((key) => {
    const frame = structure[key];
    if (!frame) {
      return `<article class="card"><h2>${FRAME_LABEL[key]}</h2><p class="missing">未提供${FRAME_LABEL[key]}結構。</p></article>`;
    }
    const pressed = key === chartInterval ? "true" : "false";
    return `
      <article class="card frame-card" data-chart-frame="${key}" aria-pressed="${pressed}" tabindex="0" role="button" aria-label="將圖表切換至${FRAME_LABEL[key]}">
        <div class="card-head">
          <h2>${FRAME_LABEL[key]}</h2>
          <span class="quiet">${esc(frame.timeframe || FRAME_CODE[key])}</span>
        </div>
        <p class="frame-label ${biasClass(frame.bias)}">${esc(frame.label || "未提供")}</p>
        <p class="frame-summary">${esc(frame.summary || "")}</p>
        <p class="swings"><span>擺動高 <b>${fmt(frame.swingHigh, 2)}</b></span><span>擺動低 <b>${fmt(frame.swingLow, 2)}</b></span></p>
      </article>
    `;
  }).join("");
}

function renderMovingAverages(symbol) {
  const block = symbol.movingAverages;
  if (!block) return `<article class="card" id="panel-ma"><h2>均線距離</h2><p class="missing">未提供均線。</p></article>`;
  const magnitudes = ["ma20", "ma50", "ma250"].map((key) => Math.abs(Number(block[key] && block[key].distancePct) || 0));
  const maxPct = Math.max(...magnitudes, 0.01);
  const rows = ["ma20", "ma50", "ma250"].map((key) => {
    const ma = block[key];
    if (!ma) return `<p class="missing">未提供 ${esc(key)}。</p>`;
    const magnitude = Math.abs(Number(ma.distancePct) || 0);
    const width = magnitude === 0 ? 0 : Math.max(8, Math.min(46, magnitude / maxPct * 46));
    const klass = (ma.distanceAbs || 0) < 0 ? "down" : "up";
    return `
      <div class="ma-row">
        <div>
          <div class="period">${ma.period}日</div>
        </div>
        <div>
          <div class="num">${fmt(ma.value, 2)}</div>
          <div class="origin-bar" aria-hidden="true"><i class="${klass}" style="width:${width}%"></i></div>
        </div>
        <div class="ma-meta ${dirClass(ma.distanceAbs)}">
          <div>${fmtSigned(ma.distanceAbs, 2)}　${fmtSigned(ma.distancePct, 2)}%</div>
          <div>${maVersus(ma.priceVersus)}</div>
        </div>
      </div>
    `;
  }).join("");
  return `<article class="card" id="panel-ma"><h2>均線距離</h2>${rows}</article>`;
}

function renderAvwap(symbol) {
  const avwap = symbol.avwap;
  if (!avwap) return `<article class="card" id="panel-avwap"><h2>AVWAP</h2><p class="missing">未提供 AVWAP。</p></article>`;
  const word = avwap.priceVersus === "below" ? "低於錨定 VWAP" : avwap.priceVersus === "at" ? "貼着錨定 VWAP" : "高於錨定 VWAP";
  return `
    <article class="card" id="panel-avwap">
      <h2>AVWAP</h2>
      <p class="metric ${dirClass(avwap.distanceAbs)}">${fmt(avwap.value, 2)}</p>
      <p class="sub ${dirClass(avwap.distanceAbs)}">${word} ${fmtSigned(avwap.distancePct, 2)}%</p>
      <p class="quiet">錨於 ${esc(avwap.anchorDate || "未提供")} · ${esc(avwap.anchorLabel || "")} ${fmt(avwap.anchorPrice, 2)}</p>
    </article>
  `;
}

function renderAtr(symbol) {
  const atr = symbol.atr;
  if (!atr) return `<article class="card" id="panel-atr"><h2>ATR 收縮／擴張</h2><p class="missing">未提供 ATR。</p></article>`;
  const ratio = Number(atr.ratio);
  const pos = Number.isFinite(ratio) ? clamp((ratio - ATR_MIN) / (ATR_MAX - ATR_MIN) * 100, 0, 100) : 0;
  const tick = (level) => clamp((level - ATR_MIN) / (ATR_MAX - ATR_MIN) * 100, 0, 100);
  return `
    <article class="card" id="panel-atr">
      <div class="card-head">
        <h2>ATR 收縮／擴張</h2>
        <span class="badge">${esc(atr.label || "未提供")}</span>
      </div>
      <p class="sub">ATR(${esc(String(atr.period ?? 14))}) <span class="num">${fmt(atr.value, 2)}</span></p>
      <p class="quiet">${esc(atr.baselineLabel || "基準")} ${fmt(atr.baseline, 2)} · 比率 ${fmt(atr.ratio, 2)}</p>
      <div class="atr-scale" aria-hidden="true">
        <i class="tick" style="left:${tick(0.9)}%"></i>
        <i class="tick" style="left:${tick(1.15)}%"></i>
        <b class="needle" style="left:${pos}%"></b>
      </div>
      <p class="scale-caption"><span>收縮 &lt; 0.90</span><span>中性</span><span>擴張 &gt; 1.15</span></p>
    </article>
  `;
}

function renderFlow(symbol) {
  const flow = symbol.flow;
  if (!flow) {
    return `
      <article class="card" id="panel-flow">
        <div class="card-head">
          <h2>資金流</h2>
          <span class="badge">示範</span>
        </div>
        <p class="missing">本代號暫無資金流示範</p>
        <p class="quiet">沒有套用其他代號的大單或散戶數字。</p>
        ${renderConnect(symbol)}
      </article>
    `;
  }
  const maxAbs = Math.max(Math.abs(Number(flow.largeOrderNet) || 0), Math.abs(Number(flow.retailNet) || 0), 1);
  const badge = flow.isDemo ? esc(flow.demoLabel || "示範數據") : "已標明來源";
  return `
    <article class="card" id="panel-flow">
      <div class="card-head">
        <h2>資金流</h2>
        <span class="badge">${badge}</span>
      </div>
      <p class="quiet">${esc(flow.window || "")} · ${esc(flow.unit || "")}</p>
      ${flowLine("大單", flow.largeOrderNet, flow.unit, maxAbs)}
      ${flowLine("散戶", flow.retailNet, flow.unit, maxAbs)}
      <p class="quiet">${esc(flow.note || "")}</p>
      ${renderConnect(symbol)}
    </article>
  `;
}

function flowLine(name, value, unit, maxAbs) {
  const number = Number(value);
  const width = Number.isFinite(number) ? Math.abs(number) / maxAbs * 50 : 0;
  const klass = number < 0 ? "down" : "up";
  return `
    <div class="flow-row">
      <div class="flow-top">
        <strong>${name}</strong>
        <span class="num ${dirClass(number)}">${fmtSigned(number, 1)} ${esc(unit || "")} · ${flowWord(number)}</span>
      </div>
      <div class="origin-bar" aria-hidden="true"><i class="${klass}" style="width:${clamp(width, 0, 50)}%"></i></div>
    </div>
  `;
}

function renderConnect(symbol) {
  if (symbol.market === "US") {
    return `<p class="quiet">此美股代號沒有南北向欄位。</p>`;
  }
  const flow = symbol.connectFlow;
  if (!flow) {
    return `
      <div class="connect" id="panel-connect">
        <h3>南北向 <span class="badge">示範</span></h3>
        <p class="missing">本代號暫無資金流示範</p>
        <p class="quiet">沒有套用其他代號的南北向數字。</p>
      </div>
    `;
  }
  const badge = flow.isDemo ? esc(flow.demoLabel || "示範數據") : "";
  const northScope = flow.northboundScope === "market" ? "市場合計" : "本股";
  return `
    <div class="connect" id="panel-connect">
      <h3>南北向 ${badge ? `<span class="badge">${badge}</span>` : ""}</h3>
      <div class="flow-top">
        <span>南向（本股）</span>
        <span class="num ${dirClass(flow.southboundNet)}">${fmtSigned(flow.southboundNet, 1)} ${esc(flow.unitSouthbound || "")} · ${flowWord(flow.southboundNet)}</span>
      </div>
      <p class="quiet">${esc(flow.southboundNote || "")}</p>
      <div class="flow-top">
        <span>北向（${northScope}）</span>
        <span class="num ${dirClass(flow.northboundNet)}">${fmtSigned(flow.northboundNet, 1)} ${esc(flow.unitNorthbound || "")} · ${flowWord(flow.northboundNet)}</span>
      </div>
      <p class="quiet">${esc(flow.northboundNote || "")}</p>
    </div>
  `;
}

function renderAlerts(symbol) {
  const alerts = Array.isArray(symbol.alerts) ? symbol.alerts : null;
  if (!alerts) {
    return `
      <article class="card" id="panel-alerts">
        <div class="card-head">
          <h2>背離提示</h2>
          <span class="badge">示範</span>
        </div>
        <p class="missing">本代號暫無資金流示範</p>
        <p class="quiet">沒有為這個代號編寫背離例子，也不會套用其他代號的旗標。</p>
      </article>
    `;
  }
  const body = alerts.length
    ? alerts.map((alert) => `
        <article class="alert ${sevClass(alert.severity)}">
          <h3>${esc(alert.title || "未命名提示")}</h3>
          <p>${esc(alert.detail || "")}</p>
          <p class="quiet">${esc(alert.timeframe || "")} · ${alertType(alert.type)}</p>
        </article>
      `).join("")
    : `<p class="missing">此代號未有背離提示。</p>`;
  const hints = consistencyHints(symbol);
  const hintHtml = hints.map((hint) => `<p class="hint">${esc(hint)}</p>`).join("");
  return `<article class="card" id="panel-alerts"><h2>背離提示</h2>${body}${hintHtml}<p class="quiet">背離旗標來自資料檔。示範檔裏的派發與吸籌是預先寫好的例子。</p></article>`;
}

function consistencyHints(symbol) {
  const hints = [];
  const last = symbol.quote && symbol.quote.last;
  const low = symbol.structure && symbol.structure.daily && symbol.structure.daily.swingLow;
  const high = symbol.structure && symbol.structure.daily && symbol.structure.daily.swingHigh;
  const large = symbol.flow && symbol.flow.largeOrderNet;
  if (!Array.isArray(symbol.alerts) || typeof last !== "number") return hints;
  for (const alert of symbol.alerts) {
    if (alert.type === "distribution") {
      const newHigh = typeof high === "number" && last >= high - 0.001;
      if (!newHigh || !(large < 0)) {
        hints.push("此派發旗標與現價或大單方向不完全一致，請對照來源。資金流若為示範，旗標也不會變成真實大單。");
      }
    }
    if (alert.type === "accumulation") {
      const nearLow = typeof low === "number" && low !== 0 && Math.abs(last - low) / Math.abs(low) < 0.02;
      if (!nearLow || !(large > 0)) {
        hints.push("此吸籌旗標與現價或大單方向不完全一致，請對照來源。資金流若為示範，旗標也不會變成真實大單。");
      }
    }
  }
  return hints;
}

function renderCommentary(symbol) {
  const note = symbol.commentary;
  if (!note) return `<article class="card" id="panel-commentary"><h2>短評</h2><p class="missing">未提供短評。</p></article>`;
  const model = note.origin === "model" && note.modelId
    ? `<p class="model-id">模型 ${esc(note.modelId)}${note.generatedAt ? " · " + esc(formatHkt(note.generatedAt)) : ""}</p>`
    : "";
  const foot = note.origin === "model"
    ? "這則短評由模型生成，並標明模型 id。若資金流仍是示範，模型文字不能把它變成真實大單。"
    : "這則短評預填在 JSON，標明為示範或尚未重算。頁面沒有金鑰欄。要刷新短評，只能在本機以環境變數 GEMINI_API_KEY 執行預覽程式。";
  return `
    <article class="card commentary" id="panel-commentary">
      <div class="card-head">
        <h2>短評</h2>
        <span class="badge">${esc(note.label || (note.origin === "model" ? "模型生成" : "示範預填"))}</span>
      </div>
      ${model}
      <p class="comment">${esc(note.text || "")}</p>
      <p class="quiet">${foot}</p>
    </article>
  `;
}

function renderSources(symbol) {
  const seen = new Set();
  const list = [];
  for (const source of [...(doc.sources || []), ...(symbol.sources || [])]) {
    if (!source || seen.has(source.id)) continue;
    seen.add(source.id);
    list.push(source);
  }
  if (!list.some((source) => source.id === "tradingview-embed")) {
    list.push({
      id: "tradingview-embed",
      kind: "public_ohlcv",
      title: "TradingView 官方圖表嵌入",
      detail: "價格圖表使用 TradingView 官方 Advanced Chart（以 s3.tradingview.com/tv.js 載入）。這是公開行情圖表元件，不是資金流數據來源，也不是暗池、機構或富途資金流。",
      appliesTo: ["price"],
    });
  }
  const items = list.length
    ? list.map((source) => {
        const fields = (source.appliesTo || []).map((field) => FIELD_LABEL[field] || field).join("、");
        return `
          <li>
            <span class="badge">${esc(KIND_LABEL[source.kind] || source.kind || "來源")}</span>
            <strong>${esc(source.title || "未命名來源")}</strong>
            <p>${esc(source.detail || "")}</p>
            <p class="quiet">適用：${esc(fields || "未註明")}</p>
          </li>
        `;
      }).join("")
    : `<li><p class="missing">未提供數據來源。</p></li>`;
  return `
    <section class="sources" id="panel-sources">
      <h2>數據來源</h2>
      <ul>${items}</ul>
      <p class="schema-path">資料合約：schema/capital-flow-dashboard.schema.json</p>
    </section>
  `;
}

function renderMethods() {
  const methods = (doc.meta && doc.meta.methods) || {};
  const rows = [
    ["均線", methods.movingAverage],
    ["ATR", methods.atr],
    ["AVWAP", methods.avwap],
    ["結構", methods.structure],
    ["資金流", methods.flow],
  ];
  return `
    <details id="panel-methods">
      <summary>計算口徑</summary>
      <dl>
        ${rows.map(([name, text]) => `<dt>${name}</dt><dd>${esc(text || "未提供")}</dd>`).join("")}
      </dl>
    </details>
  `;
}

function chartPlan(symbol) {
  if (symbol && symbol.custom) {
    return {
      mode: symbol.tvMode || "direct",
      tv: symbol.tv || "",
      requested: symbol.tvRequested || symbol.symbol,
      note: symbol.tvNote || "",
    };
  }
  const code = symbol && symbol.symbol ? symbol.symbol : symbolId;
  const note = TV_SYMBOL_NOTE[code] || "";
  const requested = TV_REQUESTED[code] || code;
  if (Object.prototype.hasOwnProperty.call(TV_SYMBOL, code)) {
    const tv = TV_SYMBOL[code];
    if (tv) return { mode: note ? "fallback" : "direct", tv, requested, note };
    return { mode: "unavailable", tv: "", requested, note };
  }
  return {
    mode: "unavailable",
    tv: "",
    requested,
    note: note || "官方 widget 沒有這個代號的已核對開圖符號，不會改用其他產品。",
  };
}

function renderChart(symbol) {
  const plan = chartPlan(symbol);
  let notice = "";
  if (plan.mode === "unavailable") {
    notice = `<p class="chart-fallback"><strong>官方 widget 不能顯示這隻港交所報價。</strong> ${esc(plan.note)}</p>`;
  } else if (plan.note && plan.mode === "fallback") {
    notice = `<p class="chart-fallback">圖表顯示 ${esc(plan.tv)}，不是建議代號 ${esc(plan.requested || symbol.symbol)}。${esc(plan.note)}</p>`;
  } else if (plan.note) {
    notice = `<p class="chart-note">${esc(plan.note)}</p>`;
  }
  const buttons = ["daily", "h4", "h1"].map((key) => {
    const pressed = key === chartInterval ? "true" : "false";
    return `<button type="button" data-chart-frame="${key}" aria-pressed="${pressed}">${FRAME_LABEL[key]}</button>`;
  }).join("");
  const shell = plan.mode === "unavailable"
    ? ""
    : `<div class="chart-shell"><div id="tv-chart" data-state="loading" data-symbol="${esc(plan.tv)}" aria-label="${esc(symbol.symbol)} 價格圖表"><p class="chart-loading">正在載入 TradingView 官方圖表…</p></div></div>`;
  const meta = plan.mode === "unavailable"
    ? `建議代號 ${esc(plan.requested)} 無法在官方 widget 開圖。沒有改用其他產品。`
    : `圖表代號 ${esc(plan.tv)}${plan.requested && plan.requested !== plan.tv ? `（建議代號 ${esc(plan.requested)} 無法在官方 widget 開圖）` : ""} · 時區 Asia/Hong_Kong · 圖表介面語言採用 TradingView 支援的繁體中文（zh_TW；官方列表沒有獨立的 zh_HK）`;
  return `
    <section class="chart-block" id="panel-chart" aria-label="價格圖表">
      <div class="card-head chart-head">
        <h2>價格圖表</h2>
        <div class="switch-block" role="group" aria-label="圖表週期">
          <span class="switch-label">週期</span>
          ${buttons}
        </div>
      </div>
      <p class="chart-note">${plan.mode === "unavailable"
        ? "下面沒有嵌入圖表。官方 widget 不能顯示這隻港交所報價。這不是資金流、暗池或經紀數據。本代號暫無資金流示範。"
        : symbol.flow
          ? "此圖是 TradingView 官方嵌入元件（公開價格圖表），不是資金流、暗池或經紀數據。示範資金流仍以本頁下方區塊為準。"
          : "此圖是 TradingView 官方嵌入元件（公開價格圖表），不是資金流、暗池或經紀數據。本代號暫無資金流示範。"}</p>
      ${notice}
      ${shell}
      <p class="quiet chart-meta">${meta}</p>
    </section>
  `;
}

function setChartInterval(next) {
  if (!TV_INTERVAL[next]) return;
  const changed = chartInterval !== next;
  chartInterval = next;
  syncIntervalUi();
  const symbol = currentView();
  if (changed || !document.querySelector("#tv-chart iframe")) {
    mountChart(symbol);
  }
}

function syncIntervalUi() {
  document.querySelectorAll("[data-chart-frame]").forEach((node) => {
    node.setAttribute("aria-pressed", node.dataset.chartFrame === chartInterval ? "true" : "false");
  });
}

function loadTradingViewScript() {
  if (window.TradingView && typeof window.TradingView.widget === "function") {
    return Promise.resolve();
  }
  if (tvScriptPromise) return tvScriptPromise;
  tvScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TV_SCRIPT;
    script.async = true;
    script.onload = () => {
      if (window.TradingView && typeof window.TradingView.widget === "function") {
        resolve();
        return;
      }
      tvScriptPromise = null;
      reject(new Error("TradingView 元件未就緒"));
    };
    script.onerror = () => {
      tvScriptPromise = null;
      reject(new Error("無法載入 TradingView 官方圖表腳本"));
    };
    document.head.appendChild(script);
  });
  return tvScriptPromise;
}

function mountChart(symbol) {
  const host = document.getElementById("tv-chart");
  if (!host) return;
  const plan = chartPlan(symbol || { symbol: symbolId });
  if (!plan.tv || plan.mode === "unavailable") {
    host.dataset.state = "unavailable";
    return;
  }
  const tvSymbol = plan.tv;
  const interval = TV_INTERVAL[chartInterval] || "D";
  const mountId = ++chartMountId;
  host.dataset.state = "loading";
  host.dataset.symbol = tvSymbol;
  host.dataset.interval = interval;
  host.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "chart-loading";
  loading.textContent = "正在載入 TradingView 官方圖表…";
  host.appendChild(loading);

  loadTradingViewScript().then(() => {
    if (mountId !== chartMountId) return;
    const still = document.getElementById("tv-chart");
    if (!still) return;
    still.replaceChildren();
    still.dataset.state = "ready";
    new window.TradingView.widget({
      autosize: true,
      symbol: tvSymbol,
      interval,
      timezone: "Asia/Hong_Kong",
      theme: "light",
      style: "1",
      locale: "zh_TW",
      toolbar_bg: "#ffffff",
      backgroundColor: "#ffffff",
      enable_publishing: false,
      allow_symbol_change: false,
      hide_top_toolbar: true,
      hide_legend: false,
      hide_side_toolbar: true,
      withdateranges: true,
      save_image: false,
      details: false,
      hotlist: false,
      calendar: false,
      hideideas: true,
      studies: [
        { id: "MASimple@tv-basicstudies", inputs: { length: 20 } },
        { id: "MASimple@tv-basicstudies", inputs: { length: 50 } },
        { id: "MASimple@tv-basicstudies", inputs: { length: 250 } },
      ],
      studies_overrides: {
        "moving average.ma.color": "#c8102e",
        "moving average.ma.linewidth": 2,
        "moving average_1.ma.color": "#8e0d22",
        "moving average_1.ma.linewidth": 2,
        "moving average_2.ma.color": "#5e5858",
        "moving average_2.ma.linewidth": 1,
      },
      container_id: "tv-chart",
    });
  }).catch((error) => {
    if (mountId !== chartMountId) return;
    const still = document.getElementById("tv-chart");
    if (!still) return;
    still.dataset.state = "error";
    still.innerHTML = `<p class="missing">無法載入價格圖表。${esc(error && error.message ? error.message : "未知錯誤")}請檢查網絡後重新整理本頁。</p>`;
  });
}

function showError(error) {
  document.body.dataset.ready = "error";
  document.getElementById("data-label").textContent = "載入失敗";
  document.getElementById("main").innerHTML = `
    <section class="error">
      <h2>載入失敗</h2>
      <p>${esc(error && error.message ? error.message : "未知錯誤")}</p>
      <p>請在專案目錄執行 <code>python3 scripts/preview.py</code>，再用瀏覽器打開終端機顯示的本地地址。直接開啟 index.html 時，瀏覽器通常不允許讀取 JSON。</p>
    </section>
  `;
}

function formatHkt(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "未提供";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute} HKT`;
}

function fmt(value, digits) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "未提供";
  return new Intl.NumberFormat("zh-HK", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(number);
}

function fmtSigned(value, digits) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "未提供";
  const body = fmt(Math.abs(number), digits);
  if (number > 0) return `+${body}`;
  if (number < 0) return `−${body}`;
  return body;
}

function dirClass(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return "flat";
  return number > 0 ? "up" : "down";
}

function biasClass(bias) {
  if (bias === "up" || bias === "down" || bias === "range" || bias === "transition") return bias;
  return "flat";
}

function flowWord(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return "持平";
  return number > 0 ? "淨流入" : "淨流出";
}

function maVersus(value) {
  if (value === "above") return "價在均線之上";
  if (value === "below") return "價在均線之下";
  if (value === "at") return "價貼着均線";
  return "未提供";
}

function alertType(type) {
  if (type === "distribution") return "派發式";
  if (type === "accumulation") return "吸籌式";
  if (type === "alignment") return "方向大致同向";
  return "其他";
}

function sevClass(severity) {
  if (severity === "high") return "alert-high";
  if (severity === "medium") return "alert-medium";
  return "alert-info";
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}
