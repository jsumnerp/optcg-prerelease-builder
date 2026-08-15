// UI glue: load a set, open packs, run the solver, render the result.

(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  };

  const state = { set: null, cards: [], ratings: {}, pool: null, solution: null };

  // ------------------------------------------------------------ loading ---

  async function loadSet(code) {
    // no-store: a stale card file silently produces a wrong deck, and
    // browsers will happily reuse one cached before the server said not to.
    const res = await fetch(`data/cards_${code}.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`no card data for ${code} -- run scripts/scrape_bandai.py ${code}`);
    const data = await res.json();
    state.set = code;
    state.cards = data.cards;

    state.ratings = {};
    try {
      const r = await fetch(`data/ratings_${code}.json`, { cache: 'no-store' });
      if (r.ok) state.ratings = (await r.json()).ratings || {};
    } catch (_) { /* ratings are optional -- heuristic covers it */ }

    const rated = state.cards.filter((c) => !c.parallel && state.ratings[c.id]).length;
    const base = state.cards.filter((c) => !c.parallel).length;
    setStatus(
      `${code}: ${base} cards loaded. ` +
      (rated
        ? `${rated} have guide ratings; the rest use the built-in heuristic.`
        : `No rating sheet for ${code} -- scoring entirely from the built-in heuristic.`),
      rated ? '' : 'warn'
    );
  }

  function setStatus(msg, cls) {
    const n = $('#status');
    n.textContent = msg;
    n.className = 'status' + (cls ? ' ' + cls : '');
  }

  // ------------------------------------------------------------ rendering ---

  function cardTile(card, count, extra) {
    const wrap = el('div', 'card' + (extra && extra.brick ? ' brickish' : ''));
    const img = el('img');
    img.src = card.image;
    img.alt = `${card.id} ${card.name}`;
    img.loading = 'lazy';
    img.title = [
      `${card.id} ${card.name} (${card.rarity})`,
      `${card.category} · ${card.cost != null ? card.cost + 'c' : 'Life ' + card.life} · ${card.power || 0} power · ${card.counter || 0} counter`,
      card.types.join('/'),
      card.effect || '(vanilla)',
      card.trigger ? card.trigger : '',
      extra && extra.note ? '\n— ' + extra.note : '',
    ].filter(Boolean).join('\n');
    wrap.appendChild(img);

    if (count > 1) wrap.appendChild(el('div', 'qty', '×' + count));

    const meta = el('div', 'meta');
    const cost = card.category === 'LEADER' ? 'L' : card.cost;
    meta.innerHTML =
      `<span class="v">${cost}c</span> · ${card.power || 0} · ` +
      `<span class="v">${card.counter ? card.counter : '—'}</span> ctr` +
      (extra && extra.value != null ? ` · <span class="v">${extra.value.toFixed(2)}</span>` : '');
    wrap.appendChild(meta);

    if (extra && extra.why) wrap.appendChild(el('div', 'why', extra.why));
    return wrap;
  }

  function renderCurve(curve) {
    const bands = window.CFG.deck.curve;
    const box = el('div', 'curve');
    const max = Math.max(6, ...Object.values(curve));
    for (const cost of Object.keys(bands)) {
      const n = curve[cost] || 0;
      const [lo, hi] = bands[cost];
      const col = el('div', 'col');
      col.appendChild(el('div', 'n', String(n)));
      const bar = el('div', 'bar-in' + (n < lo || n > hi ? ' out' : ''));
      bar.style.height = `${Math.max(2, (n / max) * 78)}px`;
      col.appendChild(bar);
      col.appendChild(el('div', 'lbl', cost === '7' ? '7+' : cost));
      col.appendChild(el('div', 'band', `${lo}-${hi}`));
      box.appendChild(col);
    }
    return box;
  }

  function chip(label, value, cls) {
    const c = el('div', 'chip' + (cls ? ' ' + cls : ''));
    c.innerHTML = `${label} <b>${value}</b>`;
    return c;
  }

  function renderDeck(sol) {
    const s = sol.result.stats;
    const D = window.CFG.deck;
    const total = sol.deck.reduce((a, d) => a + d.count, 0);

    // ---- summary ----
    const sum = el('div', 'summary');
    const lead = el('div', 'leaderCard');
    const limg = el('img');
    limg.src = sol.leader.image;
    limg.alt = sol.leader.name;
    limg.title = `${sol.leader.id} ${sol.leader.name}\nLife ${sol.leader.life} · ${sol.leader.power} power\n${sol.leader.types.join('/')}\n${sol.leader.effect}`;
    lead.appendChild(limg);
    lead.appendChild(el('div', 'cap', sol.leader.wildcard
      ? `${sol.leader.name} — all colours, counts as every name/type`
      : `${sol.leader.name} — ${sol.leader.colors.join('/')} · ${sol.leader.types.join('/')}`));
    sum.appendChild(lead);

    const right = el('div');
    right.style.flex = '1';
    right.style.minWidth = '380px';

    const chips = el('div', 'chips');
    chips.appendChild(chip('deck', `${total}/${window.CFG.format.deckSize}`, total === window.CFG.format.deckSize ? 'ok' : 'bad'));
    const in2kBand = s.n2k >= D.target2kCounters && (!D.max2kCounters || s.n2k <= D.max2kCounters);
    chips.appendChild(chip('2k counters',
      `${s.n2k}/${D.target2kCounters}` + (D.max2kCounters ? `-${D.max2kCounters}` : '+'),
      in2kBand ? 'ok' : s.n2k < D.target2kCounters ? 'bad' : 'warn'));
    chips.appendChild(chip('counter cards', s.nCounters));
    chips.appendChild(chip('counterless', `${s.nNoCounter}/${D.maxNoCounter}`, s.nNoCounter <= D.maxNoCounter ? 'ok' : 'warn'));
    chips.appendChild(chip('blockers', `${s.nBlockers}/${D.minBlockers}`, s.nBlockers >= D.minBlockers ? 'ok' : 'bad'));
    chips.appendChild(chip('characters', s.nChars, s.nChars >= D.minCharacters ? 'ok' : 'warn'));
    chips.appendChild(chip('events/stages', s.nNonChars, s.nNonChars <= D.maxNonCharacters ? 'ok' : 'warn'));
    if (D.maxCounterFodder != null) {
      chips.appendChild(chip('counter fodder', `${s.nFodder}/${D.maxCounterFodder}`,
        s.nFodder <= D.maxCounterFodder ? 'ok' : 'warn'));
    }
    chips.appendChild(chip('avg cost', avgCost(sol.deck).toFixed(2)));
    chips.appendChild(chip('brick tax', '−' + sol.result.conditional.toFixed(2), sol.result.conditional > 3 ? 'warn' : 'ok'));
    chips.appendChild(chip('score', sol.result.score.toFixed(1)));
    right.appendChild(chips);

    right.appendChild(renderCurve(s.curve));

    const flags = el('div', 'flags');
    if (sol.result.penalties.length) {
      for (const p of sol.result.penalties) flags.appendChild(el('div', 'flag', '⚠ ' + p));
    } else {
      flags.appendChild(el('div', 'flag ok', '✓ every structural target met'));
    }
    right.appendChild(flags);

    if (sol.leaderRanking && sol.leaderRanking.length > 1) {
      const alt = el('div', 'note');
      alt.textContent =
        'Leaders considered: ' +
        sol.leaderRanking.slice(0, 6)
          .map((r) => `${r.leader.name} ${r.score.toFixed(1)}`)
          .join(' · ');
      right.appendChild(alt);
    }
    sum.appendChild(right);

    $('#deckSummary').replaceChildren(sum);
    renderExport('deck', sol.deck, sol.leader);

    // ---- the 40 cards, grouped by cost ----
    const body = el('div');
    const groups = new Map();
    for (const d of sol.deck) {
      const k = d.card.cost ?? 0;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(d);
    }
    for (const cost of [...groups.keys()].sort((a, b) => a - b)) {
      const items = groups.get(cost);
      const n = items.reduce((a, d) => a + d.count, 0);
      const g = el('div', 'costGroup');
      g.appendChild(el('h3', null, `${cost} cost — ${n} card${n === 1 ? '' : 's'}`));
      const grid = el('div', 'grid');
      for (const d of items) {
        grid.appendChild(cardTile(d.card, d.count, {
          value: d.static.value,
          brick: !!d.brick,
          why: d.brick ? `needs ${d.brick.req}` : d.static.reasons.slice(1, 2).join(''),
          note: d.static.note,
        }));
      }
      g.appendChild(grid);
      body.appendChild(g);
    }
    $('#deckBody').className = '';
    $('#deckBody').replaceChildren(body);
  }

  // ---------------------------------------------------------------- export ---
  // Card Kaizoku's "Import SIM" reads the OPTCGSim decklist format: one
  // `<qty>x<cardId>` per line, Leader first.
  function simList(entries, leader) {
    const lines = [];
    // The kit's rainbow Leader is an event-only card with no catalogue number,
    // so there is nothing importable to emit for it.
    const realId = leader && /^[A-Z]+\d*-\d+$/.test(leader.id);
    if (realId) lines.push(`1x${leader.id}`);
    for (const d of [...entries].sort((a, b) => a.card.id.localeCompare(b.card.id))) {
      lines.push(`${d.count}x${d.card.id}`);
    }
    return { text: lines.join('\n') + '\n', leaderIncluded: !!realId };
  }

  // Both exports behave identically; `key` picks which panel's elements to use.
  const EXPORTS = {
    deck: { panel: '#deckExport', text: '#simText', msg: '#exportMsg', toggle: '#btnToggleSim', suffix: 'deck' },
    cuts: { panel: '#cutsExport', text: '#cutsSimText', msg: '#cutsExportMsg', toggle: '#btnToggleCutsSim', suffix: 'cuts' },
  };

  function renderExport(key, entries, leader, note) {
    const E = EXPORTS[key];
    const { text, leaderIncluded } = simList(entries, leader);
    $(E.text).value = text;
    $(E.panel).hidden = false;
    const n = entries.reduce((a, e) => a + e.count, 0);
    $(E.msg).textContent = note || (leaderIncluded
      ? `${n} cards`
      : `${n} cards — add ${leader.name} yourself, it has no catalogue number`);
  }

  async function copySim(key) {
    const E = EXPORTS[key];
    try {
      await navigator.clipboard.writeText($(E.text).value);
      $(E.msg).textContent = 'Copied — paste into Card Kaizoku › Import SIM';
    } catch (_) {
      // Clipboard API needs a secure context; fall back to selecting the text.
      const ta = $(E.text);
      ta.hidden = false;
      ta.select();
      $(E.msg).textContent = 'Select-all and copy from the box below';
    }
  }

  function downloadSim(key) {
    const E = EXPORTS[key];
    const name = `${state.set}-sealed-${$('#seed').value || 'pool'}-${E.suffix}.txt`;
    const blob = new Blob([$(E.text).value], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    $(E.msg).textContent = `Saved ${name}`;
  }

  function wireExport(key) {
    const E = EXPORTS[key];
    $(E.panel).querySelector('[data-act=copy]').addEventListener('click', () => copySim(key));
    $(E.panel).querySelector('[data-act=download]').addEventListener('click', () => downloadSim(key));
    $(E.toggle).addEventListener('click', () => {
      const ta = $(E.text);
      ta.hidden = !ta.hidden;
      $(E.toggle).textContent = ta.hidden ? 'Show list' : 'Hide list';
    });
  }

  function avgCost(deck) {
    let n = 0, sum = 0;
    for (const d of deck) { n += d.count; sum += (d.card.cost || 0) * d.count; }
    return n ? sum / n : 0;
  }

  function renderPool(pool, packs) {
    const body = el('div');
    const n = pool.reduce((a, e) => a + e.count, 0);
    const h = el('div', 'chips');
    h.appendChild(chip('cards opened', n));
    h.appendChild(chip('distinct', pool.length));
    h.appendChild(chip('packs', packs ? packs.length : '—'));
    const rar = {};
    for (const e of pool) rar[e.card.rarity] = (rar[e.card.rarity] || 0) + e.count;
    for (const r of ['L', 'SEC', 'SR', 'R', 'UC', 'C']) if (rar[r]) h.appendChild(chip(r, rar[r]));
    body.appendChild(h);

    const grid = el('div', 'grid');
    for (const e of pool) {
      grid.appendChild(cardTile(e.card, e.count, {
        value: window.Solver.baseRating(e.card, state.ratings).value,
      }));
    }
    body.appendChild(grid);
    $('#poolBody').className = '';
    $('#poolBody').replaceChildren(body);
  }

  function renderCuts(sol) {
    const body = el('div');
    body.appendChild(el('h2', null, 'Cut pile — ranked by how close each was to making the deck'));
    const note = el('div', 'note');
    note.textContent =
      'Margin = the score change from swapping this card in for the deck\'s weakest card. ' +
      'Anything near zero is a coin flip you can overrule.';
    body.appendChild(note);

    const t = el('table');
    t.innerHTML =
      '<thead><tr><th>Card</th><th class="num">Qty</th><th class="num">Cost</th>' +
      '<th class="num">Power</th><th class="num">Ctr</th><th class="num">Rating</th>' +
      '<th class="num">Margin</th><th>Why it was cut</th></tr></thead>';
    const tb = el('tbody');
    for (const c of sol.cuts.slice(0, 60)) {
      const tr = el('tr');
      const m = c.margin;
      tr.innerHTML =
        `<td>${c.card.id} ${escapeHtml(c.card.name)}</td>` +
        `<td class="num">${c.count}</td>` +
        `<td class="num">${c.card.cost ?? '—'}</td>` +
        `<td class="num">${c.card.power || 0}</td>` +
        `<td class="num">${c.card.counter || '—'}</td>` +
        `<td class="num">${c.static.base.toFixed(1)}</td>` +
        `<td class="num ${m > -0.25 ? 'pos' : 'neg'}">${m == null ? '—' : m.toFixed(2)}</td>` +
        `<td>${escapeHtml(cutReason(c, sol))}</td>`;
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    body.appendChild(t);
    $('#cutsBody').className = '';
    $('#cutsBody').replaceChildren(body);

    // No Leader line on the cut pile -- it isn't a deck, it's your sideboard.
    renderExport('cuts', sol.cuts.map((c) => ({ card: c.card, count: c.count })), null,
      `${sol.cuts.reduce((a, c) => a + c.count, 0)} cards left over`);
  }

  // Why a card missed the cut, measured against the deck that was actually
  // built rather than guessed from the card's text. Each candidate reason
  // carries the score it would cost, and the largest one wins -- otherwise you
  // get plausible-sounding explanations that aren't what the solver did.
  function cutReason(cut, sol) {
    const c = cut.card;
    const D = window.CFG.deck;
    const S = window.CFG.score;
    const st = sol.result.stats;
    const reasons = [];

    // Curve pressure -- but counter fodder occupies no slot, so it can't be
    // blocked by one.
    const cost = c.cost ?? 0;
    const isFodder = D.curveExemptCounterFodder &&
      cost >= D.curveExemptFromCost && (c.counter || 0) >= 2000;
    if (!isFodder) {
      const slot = Math.min(cost, 7);
      const band = D.curve[slot];
      const have = st.curve[slot] || 0;
      if (band && have >= band[1]) {
        reasons.push([2.0 + (have - band[1]) * D.curveWeight,
          `${slot}-cost slot full (${have}/${band[1]})`]);
      }
    } else if (st.nFodder >= D.maxCounterFodder) {
      reasons.push([2.0, `counter fodder full (${st.nFodder}/${D.maxCounterFodder})`]);
    }

    // Riders. A wildcard Leader answers every Leader-keyed condition, so those
    // are never a reason. What can still bite is a rider needing support in the
    // deck -- and only if the built deck actually lacks it.
    const answered = new Set(sol.leader.wildcard ? (c.reqLeader || []) : []);
    for (const t of c.reqTypes || []) {
      if (answered.has(t)) continue;
      const have = st.typeCount[t] || 0;
      if (have >= S.enablerTarget) continue;
      const pen = ((S.enablerTarget - have) / S.enablerTarget) * S.conditionalWeight * cut.static.forgive;
      if (pen > 0.05) reasons.push([pen, `only ${have} ${t} in deck to turn it on`]);
    }

    if (cut.static.curveBrick > 0.05) {
      reasons.push([cut.static.curveBrick,
        `${cost}-cost brick risk for a ${cut.static.base.toFixed(1)} card`]);
    }
    if (!c.counter && c.category === 'CHARACTER' && st.nNoCounter >= D.maxNoCounter) {
      reasons.push([1.0, `no counter, and the deck is at ${st.nNoCounter}/${D.maxNoCounter} counterless`]);
    }
    if (c.category !== 'CHARACTER' && st.nNonChars >= D.maxNonCharacters) {
      reasons.push([1.0, `events/stages at their cap (${st.nNonChars}/${D.maxNonCharacters})`]);
    }

    if (!reasons.length) return `outscored — rated ${cut.static.base.toFixed(1)}`;
    reasons.sort((a, b) => b[0] - a[0]);
    return reasons[0][1];
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }

  // -------------------------------------------------------------- actions ---

  function runSim() {
    const packs = +$('#packCount').value || 6;
    const seed = +$('#seed').value || 1;
    window.CFG.format.packs = packs;

    const t0 = performance.now();
    const opened = window.Packs.openPacks(state.cards, packs, seed);
    state.pool = opened.pool;

    const leaders = window.Packs.leaderCandidates(state.cards, opened.pool);
    const sol = window.Solver.buildDeck(opened.pool, leaders, state.ratings, seed);
    const ms = Math.round(performance.now() - t0);

    if (!sol) { setStatus('Pool too small to build a 40-card deck.', 'warn'); return; }
    state.solution = sol;

    // The optimiser's inner loop and the reporting path are two implementations
    // of one objective; make sure they still agree.
    const drift = window.Solver.selfCheck(opened.pool, leaders[0], state.ratings, 25);
    if (drift > 1e-6) console.warn(`solver fast/slow path disagree by ${drift}`);

    renderDeck(sol);
    renderPool(opened.pool, opened.packs);
    renderCuts(sol);

    const fixed = window.CFG.format.fixedLeader;
    const pulledLeaders = opened.pool.filter((e) => e.card.category === 'LEADER');
    setStatus(
      `Seed ${seed} · ${packs} packs · ${opened.raw.length} cards · ` +
      (fixed
        ? `Leader fixed: ${fixed.name}` +
          (pulledLeaders.length
            ? ` (${pulledLeaders.length} set Leader${pulledLeaders.length > 1 ? 's' : ''} opened, unusable)`
            : '')
        : `${pulledLeaders.length ? 'pulled ' + pulledLeaders.map((e) => e.card.name).join(', ') : 'no Leader pulled'} ` +
          `(bring-your-own is ${window.CFG.format.bringOwnLeader ? 'on' : 'off'})`) +
      ` · solved in ${ms}ms`
    );
    showTab('deck');
  }

  function runBatch(n) {
    const packs = +$('#packCount').value || 6;
    const start = +$('#seed').value || 1;
    const btn = $('#btnBatch');
    btn.disabled = true;
    setStatus(`Running ${n} sims…`);

    // Yield once so the status paints before we block the thread.
    setTimeout(() => {
      const D = window.CFG.deck;
      const rows = [];
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        const seed = start + i;
        const opened = window.Packs.openPacks(state.cards, packs, seed);
        const leaders = window.Packs.leaderCandidates(state.cards, opened.pool);
        const sol = window.Solver.buildDeck(opened.pool, leaders, state.ratings, seed);
        if (!sol) continue;
        const s = sol.result.stats;
        rows.push({
          seed,
          score: sol.result.score,
          n2k: s.n2k,
          nCounters: s.nCounters,
          nBlockers: s.nBlockers,
          leader: sol.leader.name,
          clean: sol.result.penalties.length === 0,
          curveOff: sol.result.penalties.filter((p) => p.startsWith('curve')).length,
          brickTax: sol.result.conditional,
          avgCost: avgCost(sol.deck),
        });
      }
      renderBatch(rows, Math.round(performance.now() - t0));
      btn.disabled = false;
      showTab('batch');
    }, 20);
  }

  function renderBatch(rows, ms) {
    const D = window.CFG.deck;
    const body = el('div');
    if (!rows.length) { body.appendChild(el('div', 'empty', 'No sims completed.')); $('#batchBody').replaceChildren(body); return; }

    const mean = (f) => rows.reduce((a, r) => a + f(r), 0) / rows.length;
    const pct = (f) => (100 * rows.filter(f).length / rows.length).toFixed(0) + '%';

    const chips = el('div', 'chips');
    chips.appendChild(chip('sims', rows.length));
    chips.appendChild(chip(`${D.target2kCounters}+ 2k counters`,
      pct((r) => r.n2k >= D.target2kCounters && (!D.max2kCounters || r.n2k <= D.max2kCounters)),
      rows.filter((r) => r.n2k >= D.target2kCounters).length / rows.length > 0.6 ? 'ok' : 'warn'));
    chips.appendChild(chip(`${D.minBlockers}+ blockers`, pct((r) => r.nBlockers >= D.minBlockers)));
    chips.appendChild(chip('all targets met', pct((r) => r.clean)));
    chips.appendChild(chip('mean 2k counters', mean((r) => r.n2k).toFixed(1)));
    chips.appendChild(chip('mean counter cards', mean((r) => r.nCounters).toFixed(1)));
    chips.appendChild(chip('mean blockers', mean((r) => r.nBlockers).toFixed(1)));
    chips.appendChild(chip('mean avg cost', mean((r) => r.avgCost).toFixed(2)));
    chips.appendChild(chip('mean brick tax', mean((r) => r.brickTax).toFixed(2)));
    chips.appendChild(chip('elapsed', ms + 'ms'));
    body.appendChild(chips);

    // Distribution of 2k counters -- the number the whole aim hangs on.
    const dist = {};
    for (const r of rows) dist[r.n2k] = (dist[r.n2k] || 0) + 1;
    const keys = Object.keys(dist).map(Number).sort((a, b) => a - b);
    const maxN = Math.max(...Object.values(dist));
    const hist = el('div', 'curve');
    for (const k of keys) {
      const col = el('div', 'col');
      col.appendChild(el('div', 'n', String(dist[k])));
      const bar = el('div', 'bar-in' + (k < D.target2kCounters ? ' out' : ''));
      bar.style.height = `${Math.max(2, (dist[k] / maxN) * 78)}px`;
      col.appendChild(bar);
      col.appendChild(el('div', 'lbl', String(k)));
      col.appendChild(el('div', 'band', '2k'));
      hist.appendChild(col);
    }
    body.appendChild(el('h2', null, 'Distribution of 2000-counter cards per solved deck'));
    body.appendChild(hist);

    // With the kit's fixed Leader there is nothing to tally.
    if (window.CFG.format.fixedLeader) {
      $('#batchBody').className = '';
      $('#batchBody').replaceChildren(body);
      setStatus(`${rows.length} sims in ${ms}ms.`);
      return;
    }

    const leaderTally = {};
    for (const r of rows) leaderTally[r.leader] = (leaderTally[r.leader] || 0) + 1;
    const t = el('table');
    t.innerHTML = '<thead><tr><th>Leader chosen</th><th class="num">Decks</th><th class="num">Share</th></tr></thead>';
    const tb = el('tbody');
    for (const [name, count] of Object.entries(leaderTally).sort((a, b) => b[1] - a[1])) {
      const tr = el('tr');
      tr.innerHTML = `<td>${escapeHtml(name)}</td><td class="num">${count}</td><td class="num">${(100 * count / rows.length).toFixed(0)}%</td>`;
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    body.appendChild(el('h2', null, 'Which Leader the solver picked'));
    body.appendChild(t);

    $('#batchBody').className = '';
    $('#batchBody').replaceChildren(body);
    setStatus(`${rows.length} sims in ${ms}ms.`);
  }

  // --------------------------------------------------------- paste input ---

  function parsePaste(text) {
    const byId = new Map(state.cards.map((c) => [c.id.toUpperCase(), c]));
    const counts = new Map();
    const unknown = [];

    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      // "3x OP17-024" / "3 OP17-024" / "OP17-024 x3" / "OP17-024"
      let m = s.match(/^(?:(\d+)\s*[xX]?\s+)?([A-Za-z]+\d*-\d+[A-Za-z0-9_]*)(?:\s*[xX]\s*(\d+))?$/);
      if (!m) { unknown.push(s); continue; }
      const id = m[2].toUpperCase();
      const n = +(m[1] || m[3] || 1);
      const card = byId.get(id);
      if (!card) { unknown.push(s); continue; }
      const base = byId.get((card.baseId || card.id).toUpperCase()) || card;
      counts.set(base.id, (counts.get(base.id) || 0) + n);
    }

    const pool = [...counts.entries()]
      .map(([id, count]) => ({ card: byId.get(id), count }))
      .sort((a, b) => (a.card.cost ?? 99) - (b.card.cost ?? 99));
    return { pool, unknown };
  }

  function runPaste() {
    const { pool, unknown } = parsePaste($('#pasteBox').value);
    const n = pool.reduce((a, e) => a + e.count, 0);
    const msg = $('#pasteMsg');
    if (n < window.CFG.format.deckSize) {
      msg.textContent = `Only ${n} cards parsed — need at least ${window.CFG.format.deckSize}.` +
        (unknown.length ? ` Unrecognised: ${unknown.slice(0, 5).join(', ')}` : '');
      return;
    }
    msg.textContent = `${n} cards, ${pool.length} distinct.` +
      (unknown.length ? ` Skipped ${unknown.length} unrecognised line(s): ${unknown.slice(0, 5).join(', ')}` : '');

    const leaders = window.Packs.leaderCandidates(state.cards, pool);
    const sol = window.Solver.buildDeck(pool, leaders, state.ratings, +$('#seed').value || 1);
    if (!sol) { msg.textContent += ' — solver could not build a legal deck.'; return; }
    state.pool = pool;
    state.solution = sol;
    renderDeck(sol);
    renderPool(pool, null);
    renderCuts(sol);
    showTab('deck');
  }

  // ------------------------------------------------------------ quick add ---
  // Thumb-first entry for typing a real pool in at the event. Tap art to add
  // one; the 1-5 row sets a count outright, which is how duplicates actually
  // arrive when you're reading off a stack of 72 cards.

  const quick = { counts: new Map(), color: 'All', search: '', tiles: new Map() };

  function quickCards() {
    return state.cards.filter((c) => !c.parallel && c.category !== 'LEADER');
  }

  function renderQuickColors() {
    const box = $('#qaColors');
    const colors = ['All', 'Red', 'Green', 'Blue', 'Purple', 'Black', 'Yellow'];
    box.replaceChildren(...colors.map((col) => {
      const b = el('button', quick.color === col ? 'on' : null, col);
      b.addEventListener('click', () => { quick.color = col; renderQuickColors(); renderQuickGrid(); });
      return b;
    }));
  }

  function renderQuickGrid() {
    const q = quick.search.trim().toLowerCase();
    const list = quickCards().filter((c) =>
      (quick.color === 'All' || c.colors.includes(quick.color)) &&
      (!q || c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)));

    quick.tiles.clear();
    const frag = document.createDocumentFragment();
    for (const c of list) {
      const card = el('div', 'qa-card');

      const btn = el('button', 'qa-img');
      btn.type = 'button';
      btn.setAttribute('aria-label', `Add ${c.id} ${c.name}`);
      const img = el('img');
      img.src = `thumb/${c.id}.jpg`;
      img.alt = `${c.id} ${c.name}`;
      img.loading = 'lazy';
      img.decoding = 'async';
      btn.appendChild(img);
      const badge = el('div', 'qa-badge');
      btn.appendChild(badge);
      btn.addEventListener('click', () => setQuick(c.id, (quick.counts.get(c.id) || 0) + 1));
      card.appendChild(btn);

      const code = el('div', 'qa-code');
      code.innerHTML = `<b>${escapeHtml(c.id.replace(/^OP17-/, ''))}</b> ${escapeHtml(c.name).slice(0, 18)}`;
      card.appendChild(code);

      const nums = el('div', 'qa-nums');
      const numBtns = [];
      for (let k = 1; k <= 5; k++) {
        const b = el('button', null, String(k));
        b.type = 'button';
        b.addEventListener('click', () => setQuick(c.id, k));
        nums.appendChild(b);
        numBtns.push(b);
      }
      const clr = el('button', 'clr', '×');
      clr.type = 'button';
      clr.addEventListener('click', () => setQuick(c.id, 0));
      nums.appendChild(clr);
      card.appendChild(nums);

      quick.tiles.set(c.id, { card, badge, numBtns });
      paintQuickTile(c.id);
      frag.appendChild(card);
    }
    $('#qaGrid').replaceChildren(frag);
    updateQuickCount();
  }

  // Repaint one tile in place. Rebuilding all 119 on every tap would re-trigger
  // lazy image loads and jump the scroll position -- unusable on a phone.
  function paintQuickTile(id) {
    const t = quick.tiles.get(id);
    if (!t) return;
    const n = quick.counts.get(id) || 0;
    t.card.classList.toggle('picked', n > 0);
    t.badge.textContent = n ? '×' + n : '';
    t.badge.style.display = n ? '' : 'none';
    t.numBtns.forEach((b, i) => b.classList.toggle('on', n === i + 1));
  }

  function setQuick(id, n) {
    if (n <= 0) quick.counts.delete(id); else quick.counts.set(id, n);
    paintQuickTile(id);
    updateQuickCount();
  }

  function updateQuickCount() {
    let total = 0;
    for (const n of quick.counts.values()) total += n;
    const need = window.CFG.format.deckSize;
    const target = window.CFG.format.packs * window.CFG.format.cardsPerPack;
    $('#qaCount').textContent =
      `${total} cards · ${quick.counts.size} distinct` +
      (total < need ? ` · need ${need - total} more to build` : ` · of ${target} expected`);
    $('#qaBuild').disabled = total < need;
  }

  function buildFromQuick() {
    const byId = new Map(state.cards.map((c) => [c.id, c]));
    const pool = [...quick.counts.entries()]
      .map(([id, count]) => ({ card: byId.get(id), count }))
      .filter((e) => e.card)
      .sort((a, b) => (a.card.cost ?? 99) - (b.card.cost ?? 99));

    const sol = window.Solver.buildDeck(
      pool, window.Packs.leaderCandidates(state.cards, pool), state.ratings, 1);
    if (!sol) { setStatus('Could not build a legal deck from that pool.', 'warn'); return; }
    state.pool = pool;
    state.solution = sol;
    renderDeck(sol);
    renderPool(pool, null);
    renderCuts(sol);
    const n = pool.reduce((a, e) => a + e.count, 0);
    setStatus(`Hand-entered pool · ${n} cards · Leader ${sol.leader.name}`);
    showTab('deck');
  }

  // ----------------------------------------------------------------- tabs ---

  function showTab(name) {
    for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
    for (const s of document.querySelectorAll('.tab')) s.classList.toggle('active', s.id === 'tab-' + name);
  }

  // ----------------------------------------------------------------- init ---

  async function discoverSets() {
    const sel = $('#setSelect');
    // Add a set code here once its data/cards_<CODE>.json exists.
    const candidates = ['OP17'];
    const found = [];
    for (const c of candidates) {
      try {
        const r = await fetch(`data/cards_${c}.json`, { method: 'HEAD', cache: 'no-store' });
        if (r.ok) found.push(c);
      } catch (_) { /* not present */ }
    }
    for (const c of found) sel.appendChild(new Option(c, c));
    // A one-set picker is just clutter.
    sel.closest('label').hidden = found.length < 2;
    return found;
  }

  async function init() {
    document.querySelectorAll('.tabs button').forEach((b) =>
      b.addEventListener('click', () => showTab(b.dataset.tab)));

    $('#btnSim').addEventListener('click', runSim);
    $('#btnBatch').addEventListener('click', () => runBatch(100));
    $('#btnPaste').addEventListener('click', runPaste);
    $('#btnReroll').addEventListener('click', () => {
      $('#seed').value = Math.floor(Math.random() * 1e6);
      runSim();
    });
    wireExport('deck');
    wireExport('cuts');

    $('#qaSearch').addEventListener('input', (e) => { quick.search = e.target.value; renderQuickGrid(); });
    $('#qaClear').addEventListener('click', () => { quick.counts.clear(); renderQuickGrid(); });
    $('#qaBuild').addEventListener('click', buildFromQuick);

    $('#setSelect').addEventListener('change', async (e) => {
      await loadSet(e.target.value);
      quick.counts.clear();
      renderQuickColors();
      renderQuickGrid();
      $('#deckBody').className = 'empty';
      $('#deckBody').textContent = 'Set changed — run a new simulation.';
    });

    const sets = await discoverSets();
    if (!sets.length) {
      setStatus('No card data found. Run: python3 scripts/build_op17.py', 'warn');
      return;
    }
    await loadSet(sets[0]);
    renderQuickColors();
    renderQuickGrid();
  }

  init().catch((e) => setStatus(String(e.message || e), 'warn'));
})();
