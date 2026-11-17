// Token Launch Radar's dashboard logic. It renders window.RADAR_DATA (written beside this page by
// main.ts from the same board board.json carries) as a sortable, filterable board with a
// per-protocol detail view. No network: every figure on the page is in data.js.
//
// Screenshot states, applied on load with no interaction:
//   ?view=board                        the ranked board (the default)
//   ?view=detail&slug=<slug>           the board with that protocol's detail view open
//   ?view=filtered&category=<category> the board filtered to one category

(function () {
  'use strict';

  var DATA = window.RADAR_DATA;
  if (!DATA) return;
  var rows = DATA.rows;

  var state = { q: '', category: '', chain: '', watchlistOnly: false, sort: 'rank', dir: 1, selected: null };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var usdFull = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usdFull.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + ' years';
    return days + ' days';
  }
  function mult(row) { return row.implied_value_usd / row.tvl_usd; }

  /* --- header stats ------------------------------------------------------ */

  function renderStats() {
    var s = DATA.stats;
    var cells = [
      ['Board rows', s.board, ''],
      ['Watchlist covered', s.watchlist + ' / ' + s.watchlist, 'watch'],
      ['Early finds below the floor', s.early, ''],
      ['Tokenized comparables', s.comparables, ''],
      ['Global multiple', DATA.global_multiple.toFixed(3) + 'x', ''],
    ];
    $('stats').innerHTML = cells.map(function (c) {
      return '<div class="stat ' + c[2] + '"><b>' + esc(c[1]) + '</b><span>' + esc(c[0]) + '</span></div>';
    }).join('');
    $('foot').textContent =
      'Snapshot: ' + DATA.source + ' (as of ' + DATA.as_of + '). Model ' + DATA.model_version +
      '. Implied values are this radar\'s own claim, derived from the snapshot\'s figures alone; ' +
      'a protocol "records no token" when its snapshot record carries none.';
  }

  /* --- controls ------------------------------------------------------------ */

  function fillSelect(el, values) {
    values.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      el.appendChild(o);
    });
  }

  function renderControls() {
    var cats = [];
    var chains = [];
    var seenC = {};
    var seenH = {};
    rows.forEach(function (r) {
      var c = r.category || '(uncategorized)';
      if (!seenC[c]) { seenC[c] = 1; cats.push(c); }
      r.chains.forEach(function (h) { if (!seenH[h]) { seenH[h] = 1; chains.push(h); } });
    });
    cats.sort();
    chains.sort();
    fillSelect($('category'), cats);
    fillSelect($('chain'), chains);
  }

  /* --- board ----------------------------------------------------------------- */

  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    var out = rows.filter(function (r) {
      if (state.watchlistOnly && !r.watchlist) return false;
      if (state.category && (r.category || '(uncategorized)') !== state.category) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var key = state.sort;
    var dir = state.dir;
    var val = function (r) {
      switch (key) {
        case 'name': return r.name.toLowerCase();
        case 'category': return (r.category || '').toLowerCase();
        case 'tvl': return r.tvl_usd;
        case 'change': return r.change_7d === null ? -Infinity : r.change_7d;
        case 'implied': return r.implied_value_usd;
        case 'multiple': return mult(r);
        default: return r.rank;
      }
    };
    out.sort(function (a, b) {
      var va = val(a);
      var vb = val(b);
      if (va < vb) return -dir;
      if (va > vb) return dir;
      return a.rank - b.rank;
    });
    return out;
  }

  function renderBoard() {
    var vis = visibleRows();
    $('count').innerHTML = 'Showing <b>' + vis.length + '</b> of <b>' + rows.length + '</b> protocols';
    $('empty').hidden = vis.length > 0;
    var heads = document.querySelectorAll('.board th[data-key]');
    heads.forEach(function (th) {
      var base = th.getAttribute('data-label') || th.textContent.replace(/ [▲▼]$/, '');
      th.setAttribute('data-label', base);
      th.innerHTML = esc(base) + (th.getAttribute('data-key') === state.sort
        ? ' <span class="dir">' + (state.dir === 1 ? '▲' : '▼') + '</span>' : '');
    });
    $('rows').innerHTML = vis.map(function (r) {
      var chg = r.change_7d === null ? '' : (r.change_7d >= 0 ? 'pos' : 'neg');
      return '<tr data-slug="' + esc(r.slug) + '"' + (state.selected === r.slug ? ' class="selected"' : '') + '>' +
        '<td class="num">' + r.rank + '</td>' +
        '<td class="name">' + esc(r.name) + (r.watchlist ? '<span class="badge">Watchlist</span>' : '') +
          '<span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td class="cat">' + esc(r.category || '—') + '</td>' +
        '<td class="chains">' + esc(r.chains.join(', ') || '—') + '</td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num ' + chg + '">' + fmtPct(r.change_7d) + '</td>' +
        '<td class="num implied">' + fmtUsd(r.implied_value_usd) + '</td>' +
        '<td class="num">' + mult(r).toFixed(3) + 'x</td>' +
        '</tr>';
    }).join('');
  }

  /* --- detail ------------------------------------------------------------------ */

  function findRow(slug) {
    for (var i = 0; i < rows.length; i++) if (rows[i].slug === slug) return rows[i];
    return null;
  }

  function renderDetail() {
    var box = $('detail');
    var r = state.selected ? findRow(state.selected) : null;
    if (!r) { box.hidden = true; box.innerHTML = ''; return; }
    var m = r.model;
    var cat = DATA.categories.filter(function (c) { return c.category === (r.category || '(uncategorized)'); })[0];
    var compNote = cat
      ? 'the ' + esc(cat.category) + ' multiple comes from ' + cat.comps + ' tokenized comparables (median ' +
        (cat.median_ratio === null ? 'n/a' : cat.median_ratio.toFixed(3)) + 'x, shrunk toward the global median)'
      : 'the category has no tokenized comparable in the snapshot, so the global median multiple prices this row';
    var facts = [
      ['Implied value', fmtUsd(r.implied_value_usd)],
      ['TVL', fmtUsd(r.tvl_usd)],
      ['Value / TVL', mult(r).toFixed(3) + 'x'],
      ['7d TVL change', fmtPct(r.change_7d)],
      ['Live without a token', fmtAge(r.age_days)],
      ['Listed on DefiLlama', r.listed_at || 'unknown'],
      ['Category multiple', m.category_multiple.toFixed(3) + 'x (' + m.category_comps + ' comps)'],
      ['Watchlist', r.watchlist ? 'Yes — above the $50M floor' : 'No — early find below the floor'],
    ];
    box.innerHTML =
      '<div class="detail-head"><h2>' + esc(r.name) + '</h2><span class="slug">' + esc(r.slug) + '</span>' +
      (r.watchlist ? '<span class="badge">Watchlist</span>' : '') +
      '<button class="detail-close" id="detail-close" type="button">Close</button></div>' +
      '<div class="facts">' + facts.map(function (f) {
        return '<div class="fact"><span>' + esc(f[0]) + '</span><b>' + esc(f[1]) + '</b></div>';
      }).join('') + '</div>' +
      '<div class="math">' + fmtUsd(r.tvl_usd) + ' <span class="op">TVL &times;</span> ' + m.category_multiple.toFixed(3) +
      ' <span class="op">category &times;</span> ' + m.momentum_factor.toFixed(3) + ' <span class="op">momentum &times;</span> ' +
      m.maturity_factor.toFixed(3) + ' <span class="op">maturity &times;</span> ' + m.size_factor.toFixed(3) +
      ' <span class="op">size &rarr;</span> <span class="res">' + fmtUsd(r.implied_value_usd) + '</span></div>' +
      '<p class="math-note">The model\'s arithmetic for this row, from its own record: ' + compNote +
      '. Momentum reads its 7-day TVL change, maturity its time live without a token, size its TVL tier. ' +
      'Chains: ' + esc(r.chains.join(', ') || 'none listed') + '.</p>' +
      '<h3>Farm plan</h3><ol class="steps">' +
      r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
    box.hidden = false;
    $('detail-close').addEventListener('click', function () {
      state.selected = null;
      renderDetail();
      renderBoard();
    });
  }

  /* --- methodology ---------------------------------------------------------------- */

  function renderMultiples() {
    var head = '<table class="mults"><thead><tr><th>Category</th><th class="num">Comparables</th>' +
      '<th class="num">Median mcap / TVL</th><th class="num">Multiple used</th></tr></thead><tbody>';
    var body = DATA.categories.map(function (c) {
      return '<tr><td>' + esc(c.category) + '</td><td class="num">' + c.comps + '</td><td class="num">' +
        (c.median_ratio === null ? 'n/a' : c.median_ratio.toFixed(3) + 'x') + '</td><td class="num">' +
        c.multiple.toFixed(3) + 'x</td></tr>';
    }).join('');
    $('multiples').innerHTML = head + body + '</tbody></table>' +
      '<p>The global median across all ' + DATA.stats.comparables + ' comparables is ' +
      DATA.global_multiple.toFixed(3) + 'x; it prices any category with no comparable of its own.</p>';
  }

  /* --- wiring ------------------------------------------------------------------------ */

  function select(slug, scroll) {
    state.selected = slug;
    renderDetail();
    renderBoard();
    if (slug && scroll) $('detail').scrollIntoView({ block: 'start' });
  }

  function init() {
    renderStats();
    renderControls();
    renderMultiples();

    $('q').addEventListener('input', function (e) { state.q = e.target.value; renderBoard(); });
    $('category').addEventListener('change', function (e) { state.category = e.target.value; renderBoard(); });
    $('chain').addEventListener('change', function (e) { state.chain = e.target.value; renderBoard(); });
    $('watchlist-only').addEventListener('change', function (e) { state.watchlistOnly = e.target.checked; renderBoard(); });
    $('sort').addEventListener('change', function (e) {
      state.sort = e.target.value;
      state.dir = state.sort === 'name' || state.sort === 'category' || state.sort === 'rank' ? 1 : -1;
      renderBoard();
    });
    document.querySelectorAll('.board th[data-key]').forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-key');
        if (state.sort === key) state.dir = -state.dir;
        else { state.sort = key; state.dir = key === 'name' || key === 'category' || key === 'rank' ? 1 : -1; }
        $('sort').value = key;
        renderBoard();
      });
    });
    $('rows').addEventListener('click', function (e) {
      var tr = e.target.closest('tr[data-slug]');
      if (tr) select(tr.getAttribute('data-slug'), true);
    });

    // Deterministic screenshot states, applied before the first paint of the board.
    var params = new URLSearchParams(window.location.search);
    var view = params.get('view');
    if (view === 'filtered' && params.get('category')) {
      state.category = params.get('category');
      $('category').value = state.category;
    }
    renderBoard();
    if (view === 'detail' && params.get('slug') && findRow(params.get('slug'))) {
      select(params.get('slug'), false);
    }
  }

  init();
})();
