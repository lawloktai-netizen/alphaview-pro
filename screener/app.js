(function () {
  const STRATS = {
    growth: {
      name: 'High-growth', zh: '爆升股',
      desc: 'Growth companies. Stage 1 checks fundamentals and the trend (50/200-day moving averages). Stage 2 needs the last 3 quarters of EPS growth above 20% and speeding up. Ties are ranked by EV/EBITDA, lowest first.',
      short: { rev_cagr3: 'Rev 3y >10%', rev_steady: 'Rev steady', rev_bonus: 'Bonus', eps_pos: 'EPS +', roic: 'ROIC >10%', listed: '>3y listed', mcap: 'Mkt cap', ma_cross: '50>200 MA', px_ma200: 'Px>200 MA', ma200_up: '200 MA up', q_eps: 'Q EPS accel', beats: 'Beat est.', one_dollar: '$1 test' },
      extra: { key: 'ev_ebitda', label: 'EV/EBITDA', fmt: 'x', asc: true },
    },
    quality: {
      name: 'Quality', zh: '優質股',
      desc: 'Mature, high-quality compounders: revenue, ROE and EPS all compounding above 12%, Piotroski F-Score above 6, and operating margin above 8% every year.',
      short: { rev_cagr3: 'Rev 3y >12%', roe: 'ROE >12%', eps_cagr: 'EPS >12%', eps_steady: 'EPS steady', fscore: 'F-Score >6', opm: 'Op mgn >8%', mcap: 'Mkt cap', listed: '>3y listed' },
      extra: { key: 'pe', label: 'P/E', fmt: 'x', asc: true },
    },
    reit: {
      name: 'REITs', zh: '房託',
      desc: 'REITs: FFO per share and DPS each growing above 8% a year, true payout (DPS ÷ FFO) below 100%, and yield above 2%. Bonus: rental return on tangible assets trending up.',
      short: { ffo_cagr: 'FFO >8%', ffo_steady: 'FFO steady', ffo_payout: 'Payout <100%', dps_cagr: 'DPS >8%', dps_steady: 'DPS steady', yield: 'Yield >2%', mcap: 'Mkt cap', listed: '>3y listed', rent_ret: 'Rent ret ↑' },
      extra: { key: 'div_yield', label: 'Yield', fmt: 'pct', asc: false },
    },
    dividend: {
      name: 'Dividend', zh: '收息股',
      desc: 'Income stocks: return on capital above 10%, operating cash flow and DPS each growing above 8% a year, payout below 100%, yield above 2%, and listed for more than 5 years.',
      short: { roc: 'ROC >10%', cfo_cagr: 'CFO >8%', cfo_steady: 'CFO steady', payout: 'Payout <100%', dps_cagr: 'DPS >8%', dps_steady: 'DPS steady', yield: 'Yield >2%', mcap: 'Mkt cap', listed: '>5y listed' },
      extra: { key: 'div_yield', label: 'Yield', fmt: 'pct', asc: false },
    },
  };

  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  const rawApi = window.__API_BASE__ || '';
  const API = rawApi.startsWith('__PORT_') ? (localHosts.has(location.hostname) ? 'http://localhost:8000' : null) : rawApi;

  const snap = window.SNAPSHOT || { results: [] };
  const state = {
    strat: 'growth', mkt: 'ALL', q: '', onlyPass: false, reitOnly: false, mcap: 30,
    sort: { key: 'score', dir: -1 }, rows: snap.results.slice(), live: new Set(), detailSym: null, detailStrat: null,
  };

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function fmt(v, f) {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    switch (f) {
      case 'pct': return (v * 100).toFixed(1) + '%';
      case 'x': return Number(v).toFixed(1) + '×';
      case 'hkdbn': return 'HK$' + (v >= 1000 ? (v / 1000).toFixed(1) + 'tn' : v.toFixed(0) + 'bn');
      case 'years': return v.toFixed(1) + ' yrs';
      case 'price': return Number(v).toFixed(2);
      case 'num': return Number(v).toFixed(2);
      case 'score9': return v + ' / 9';
      case 'count': return v + ' / 3';
      case 'list': return Array.isArray(v) ? v.map((x) => x + '%').join(' → ') : '—';
      default: return String(v);
    }
  }
  const sym = (s) => (s === 'pass' ? '✓' : s === 'fail' ? '✕' : '–');

  // Apply user-adjustable market-cap threshold on the client
  function screenOf(r, key) {
    const sc = r.screens[key];
    const crit = sc.criteria.map((c) => {
      if (c.id !== 'mcap') return c;
      const ok = r.mcap_hkd_bn == null ? null : r.mcap_hkd_bn >= state.mcap;
      return { ...c, threshold: state.mcap, label: `Market cap ≥ HK$${state.mcap}bn`, status: ok == null ? 'na' : ok ? 'pass' : 'fail' };
    });
    const req = crit.filter((c) => c.required);
    const passed = req.filter((c) => c.status === 'pass').length;
    const failed = req.filter((c) => c.status === 'fail').length;
    const na = req.filter((c) => c.status === 'na').length;
    return { criteria: crit, passed, failed, na, total: req.length, all_pass: failed === 0 && na === 0 };
  }

  function renderTabs() {
    $('#tabs').innerHTML = Object.entries(STRATS)
      .map(([k, s]) => `<button role="tab" data-k="${k}" class="${k === state.strat ? 'on' : ''}" data-testid="tab-${k}">${s.name}<span class="zh">${s.zh}</span></button>`)
      .join('');
    $('#tabs').querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        state.strat = b.dataset.k;
        state.reitOnly = state.strat === 'reit';
        $('#reitOnly').checked = state.reitOnly;
        state.sort = { key: 'score', dir: -1 };
        renderAll();
      })
    );
  }

  function renderIntro() {
    const s = STRATS[state.strat];
    const sample = state.rows[0];
    const crit = sample ? screenOf(sample, state.strat).criteria : [];
    $('#intro').innerHTML = `<h2>${s.name} <span style="color:var(--ink-3);font-weight:500">${s.zh}</span></h2><p>${s.desc}</p>
      <div class="chips">${crit.map((c) => `<span class="chip ${c.required ? '' : 'adv'}">${esc(c.label)}${c.required ? '' : ' · optional'}</span>`).join('')}</div>`;
  }

  function filtered() {
    const q = state.q.trim().toLowerCase();
    return state.rows.filter((r) => {
      if (state.mkt !== 'ALL' && r.market !== state.mkt) return false;
      if (state.reitOnly && !r.is_reit) return false;
      if (q && !(r.symbol.toLowerCase().includes(q) || (r.name || '').toLowerCase().includes(q))) return false;
      if (state.onlyPass && !screenOf(r, state.strat).all_pass) return false;
      return true;
    });
  }

  function sortRows(rows) {
    const s = STRATS[state.strat];
    const { key, dir } = state.sort;
    const val = (r) => {
      const sc = screenOf(r, state.strat);
      if (key === 'score') return sc.passed / (sc.total || 1);
      if (key === 'symbol') return r.symbol;
      if (key === 'mcap') return r.mcap_hkd_bn ?? -1;
      if (key === 'extra') return r[s.extra.key];
      const c = sc.criteria.find((c) => c.id === key);
      return c ? { pass: 2, na: 1, fail: 0 }[c.status] : 0;
    };
    return rows.sort((a, b) => {
      let va = val(a), vb = val(b);
      if (key === 'extra') {
        const asc = s.extra.asc ? 1 : -1;
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        if (s.extra.key === 'ev_ebitda') { if (va <= 0) return 1; if (vb <= 0) return -1; }
        return (va - vb) * asc * (dir === -1 ? 1 : -1);
      }
      if (typeof va === 'string') return va.localeCompare(vb) * dir;
      if (va !== vb) return (va - vb) * dir;
      // tie-break with the strategy's ranking metric (course: EV/EBITDA for growth)
      const ea = a[s.extra.key], eb = b[s.extra.key];
      if (ea == null || (s.extra.key === 'ev_ebitda' && ea <= 0)) return 1;
      if (eb == null || (s.extra.key === 'ev_ebitda' && eb <= 0)) return -1;
      return s.extra.asc ? ea - eb : eb - ea;
    });
  }

  function renderKpis(rows) {
    const scs = rows.map((r) => screenOf(r, state.strat));
    const full = scs.filter((s) => s.all_pass).length;
    const near = scs.filter((s) => !s.all_pass && s.failed + s.na <= 1).length;
    const gaps = scs.filter((s) => s.na > 0).length;
    $('#kpis').innerHTML = [
      ['Stocks shown', rows.length, ''],
      ['Full passes', full, 'hl'],
      ['One criterion short', near, ''],
      ['With data gaps', gaps, ''],
    ].map(([l, v, c]) => `<div class="kpi ${c}" data-testid="kpi-${l.toLowerCase().replace(/\s+/g, '-')}"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('');
  }

  function renderTable() {
    const s = STRATS[state.strat];
    const rows = sortRows(filtered());
    renderKpis(rows);
    const sample = state.rows[0];
    const crit = sample ? screenOf(sample, state.strat).criteria : [];
    const th = (key, label, cls = '', title = '') =>
      `<th data-sort="${key}" class="${cls} ${state.sort.key === key ? 'sorted' : ''}" title="${esc(title)}">${label}${state.sort.key === key ? (state.sort.dir === -1 ? ' ↓' : ' ↑') : ''}</th>`;
    $('#grid thead').innerHTML = `<tr>${th('symbol', 'Stock')}${th('score', 'Score')}${crit
      .map((c) => th(c.id, `<span>${esc(s.short[c.id] || c.id)}</span>`, 'c', c.label + (c.required ? '' : ' (optional)')))
      .join('')}${th('extra', s.extra.label)}${th('mcap', 'Mkt cap')}</tr>`;
    $('#grid tbody').innerHTML = rows
      .map((r) => {
        const sc = screenOf(r, state.strat);
        const pct = Math.round((sc.passed / (sc.total || 1)) * 100);
        return `<tr data-sym="${esc(r.symbol)}" class="${sc.all_pass ? 'full' : ''}" data-testid="row-${esc(r.symbol)}">
          <td class="sym">${esc(r.symbol)}${r.is_reit ? '<span class="tag">REIT</span>' : ''}${state.live.has(r.symbol) ? '<span class="tag live">live</span>' : ''}<small>${esc(r.name)}</small></td>
          <td><div class="score"><b>${sc.passed}/${sc.total}</b><div class="bar"><i style="width:${pct}%"></i></div></div></td>
          ${sc.criteria.map((c) => `<td class="c"><span class="dot ${c.status}" title="${esc(c.label)}: ${esc(fmt(c.value, c.fmt))}">${sym(c.status)}</span></td>`).join('')}
          <td class="n">${fmt(r[s.extra.key], s.extra.fmt)}</td>
          <td class="n">${fmt(r.mcap_hkd_bn, 'hkdbn')}</td></tr>`;
      })
      .join('');
    $('#empty').hidden = rows.length > 0;
    $('#grid thead').querySelectorAll('th').forEach((h) =>
      h.addEventListener('click', () => {
        const k = h.dataset.sort;
        state.sort = state.sort.key === k ? { key: k, dir: -state.sort.dir } : { key: k, dir: k === 'symbol' ? 1 : -1 };
        renderTable();
      })
    );
    $('#grid tbody').querySelectorAll('tr').forEach((tr) => tr.addEventListener('click', () => openDetail(tr.dataset.sym)));
  }

  function renderAll() {
    renderTabs();
    renderIntro();
    $('#reitOnlyWrap').style.display = '';
    renderTable();
    if (state.detailSym) renderDetail();
  }

  // ---------- detail drawer ----------
  function openDetail(symbol, strat) {
    state.detailSym = symbol;
    state.detailStrat = strat || state.strat;
    renderDetail();
    $('#drawer').classList.add('on');
    $('#drawer').setAttribute('aria-hidden', 'false');
    $('#scrim').classList.add('on');
  }
  function closeDetail() {
    state.detailSym = null;
    $('#drawer').classList.remove('on');
    $('#drawer').setAttribute('aria-hidden', 'true');
    $('#scrim').classList.remove('on');
  }

  function renderDetail() {
    const r = state.rows.find((x) => x.symbol === state.detailSym);
    if (!r) return;
    const k = state.detailStrat;
    const sc = screenOf(r, k);
    const groups = { core: 'Fundamentals', technical: 'Market sentiment (technical)', advanced: k === 'growth' ? 'Stage 2: advanced conditions' : 'Extra checks' };
    let html = `<div class="d-head"><h3>${esc(r.symbol)} · ${esc(r.name)}</h3><p>${esc([r.sector, r.industry, r.currency, 'as of ' + r.as_of].filter(Boolean).join(' · '))}</p></div>
      <div class="d-stats">
        <div><span>Price</span><b>${fmt(r.price, 'price')}</b></div>
        <div><span>Mkt cap</span><b>${fmt(r.mcap_hkd_bn, 'hkdbn')}</b></div>
        <div><span>EV/EBITDA</span><b>${fmt(r.ev_ebitda, 'x')}</b></div>
        <div><span>Yield</span><b>${fmt(r.div_yield, 'pct')}</b></div>
      </div>
      <div class="d-tabs">${Object.entries(STRATS).map(([kk, s]) => {
        const x = screenOf(r, kk);
        return `<button data-k="${kk}" class="${kk === k ? 'on' : ''}" data-testid="detail-tab-${kk}">${s.name} ${x.passed}/${x.total}</button>`;
      }).join('')}</div>`;
    let lastGroup = null;
    sc.criteria.forEach((c) => {
      if (c.group !== lastGroup) { html += `<div class="grp">${groups[c.group] || c.group}</div>`; lastGroup = c.group; }
      const thr = c.threshold == null ? '' : c.fmt === 'price' ? `vs ${fmt(c.threshold, 'price')}` : c.fmt === 'list' ? 'need > 20%' : `target ${fmt(c.threshold, c.fmt === 'score9' || c.fmt === 'count' ? 'num0' : c.fmt)}`;
      html += `<div class="crit" data-testid="crit-${c.id}"><span class="dot ${c.status}">${sym(c.status)}</span>
        <div><span class="lbl">${esc(c.label)}${c.required ? '' : ' <span class="tag">optional</span>'}</span>${c.note ? `<span class="note">${esc(c.note)}</span>` : ''}</div>
        <div class="val">${c.fmt === 'bool' ? (c.status === 'pass' ? 'Yes' : c.status === 'fail' ? 'No' : 'n/a') : fmt(c.value, c.fmt)}${thr && c.fmt !== 'bool' ? `<small>${esc(thr.replace('num0', ''))}</small>` : ''}</div></div>`;
    });

    if (k === 'quality' && r.fscore_tests) {
      html += `<div class="grp">Piotroski F-Score breakdown</div><div class="fs">${r.fscore_tests
        .map((t) => `<div><span class="dot ${t.ok === null ? 'na' : t.ok ? 'pass' : 'fail'}">${sym(t.ok === null ? 'na' : t.ok ? 'pass' : 'fail')}</span>${esc(t.name)}</div>`).join('')}</div>`;
    }
    if (k === 'growth' && r.series.q_eps && r.series.q_eps.length) {
      html += `<div class="grp">Quarterly EPS, year over year</div><table class="mini"><tr><th>Reported</th><th>EPS</th><th>YoY</th><th>Change in growth</th></tr>${r.series.q_eps
        .map((q, i, a) => {
          const acc = i > 0 && q.yoy != null && a[i - 1].yoy != null ? q.yoy - a[i - 1].yoy : null;
          return `<tr><td>${esc(q.t)}</td><td>${fmt(q.eps, 'num')}</td><td>${fmt(q.yoy, 'pct')}</td><td>${acc == null ? '—' : (acc > 0 ? '+' : '') + (acc * 100).toFixed(1) + ' pts'}</td></tr>`;
        }).join('')}</table>`;
    }
    if ((k === 'reit' || k === 'dividend') && r.series.dps && r.series.dps.length) {
      html += `<div class="grp">Dividends per share by calendar year</div><table class="mini"><tr><th>Year</th><th>DPS</th></tr>${r.series.dps
        .map((d) => `<tr><td>${esc(d.t)}</td><td>${fmt(d.v, 'num')}</td></tr>`).join('')}</table>`;
    }
    if (r.series.revenue && r.series.revenue.length) {
      html += `<div class="grp">Annual revenue and EPS</div><table class="mini"><tr><th>Fiscal year</th><th>Revenue (bn)</th><th>EPS</th></tr>${r.series.revenue
        .map((d) => { const e = r.series.eps.find((x) => x.t === d.t); return `<tr><td>${esc(d.t)}</td><td>${(d.v / 1e9).toFixed(2)}</td><td>${e ? fmt(e.v, 'num') : '—'}</td></tr>`; }).join('')}</table>`;
    }
    const manual = {
      growth: ['EPS growth, revenue growth and net margin rank in the top 3 of the sub-industry', 'Growth is not from one-off asset sales', 'Sales are surging too (units sold, market share)', 'Products: top-3 market share, disruptive, cutting-edge tech, pricing power', 'Industry has high technology or policy barriers, not heavy capital needs'],
      quality: ['Check the economic-cycle quadrant (倫皇時鐘) fits the sector'],
      reit: ['LSEG ESG score and management team background (scored out of 7, scaled to 3)', 'Prefer REITs in the right economic-cycle quadrant'],
      dividend: ['Prefer stocks in the right economic-cycle quadrant'],
    }[k];
    html += `<div class="manual"><b>Check by hand (not automated)</b><ul>${manual.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>`;
    $('#detail').innerHTML = html;
    $('#detail').querySelectorAll('.d-tabs button').forEach((b) => b.addEventListener('click', () => { state.detailStrat = b.dataset.k; renderDetail(); }));
  }

  // ---------- live lookup ----------
  async function lookup(symbol) {
    symbol = symbol.trim().toUpperCase();
    if (!symbol) return;
    if (/^\d{1,5}$/.test(symbol)) symbol = symbol.padStart(4, '0') + '.HK';
    const btn = $('#lookup button');
    if (!API) {
      showMsg(`Live lookup needs the backend, which isn't running. Use the ${state.rows.length} stocks below.`);
      return;
    }
    btn.disabled = true; btn.textContent = 'Fetching…';
    $('#detail').innerHTML = `<div class="d-head"><h3>${esc(symbol)}</h3><p>Fetching statements, prices and dividends from Yahoo Finance…</p></div>${'<div class="skel"></div>'.repeat(8)}`;
    $('#drawer').classList.add('on'); $('#scrim').classList.add('on');
    try {
      const res = await fetch(`${API}/api/analyze/${encodeURIComponent(symbol)}`, { credentials: 'omit' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `HTTP ${res.status}`);
      const r = await res.json();
      state.rows = state.rows.filter((x) => x.symbol !== r.symbol).concat([r]);
      state.live.add(r.symbol);
      renderTable();
      openDetail(r.symbol);
    } catch (e) {
      $('#detail').innerHTML = `<div class="err">Couldn't analyze ${esc(symbol)}: ${esc(e.message || 'request failed')}. The snapshot table is unchanged. Check the ticker format: US "AAPL", HK "0700.HK".</div>`;
    } finally {
      btn.disabled = false; btn.textContent = 'Analyze';
    }
  }
  function showMsg(m) {
    $('#detail').innerHTML = `<div class="err">${esc(m)}</div>`;
    $('#drawer').classList.add('on'); $('#scrim').classList.add('on');
  }

  // ---------- wire up ----------
  $('#asof').textContent = snap.as_of ? `Snapshot ${snap.as_of}` : '';
  document.querySelectorAll('.seg button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
      state.mkt = b.dataset.mkt; renderTable();
    })
  );
  $('#q').addEventListener('input', (e) => { state.q = e.target.value; renderTable(); });
  $('#onlyPass').addEventListener('change', (e) => { state.onlyPass = e.target.checked; renderTable(); });
  $('#reitOnly').addEventListener('change', (e) => { state.reitOnly = e.target.checked; renderTable(); });
  $('#mcap').addEventListener('input', (e) => { const v = parseFloat(e.target.value); state.mcap = Number.isFinite(v) ? v : 0; renderIntro(); renderTable(); if (state.detailSym) renderDetail(); });
  $('#lookup').addEventListener('submit', (e) => { e.preventDefault(); lookup($('#lookup-input').value); });
  $('#close').addEventListener('click', closeDetail);
  $('#scrim').addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

  renderAll();
})();
