// Deck solver: score every card in a sealed pool, then search for the 40 that
// maximise total score subject to curve / counter / composition constraints.
//
// Why annealing and not an LP: the conditional-brick term is non-linear -- a
// card's value depends on how many *other* cards in the same deck share a type.
// Local search handles that directly; an ILP would need the outer fixed-point
// loop anyway.

(function () {
  'use strict';

  // ---------------------------------------------------------------- RNG ----
  // Seeded so a pool you like can be reproduced exactly.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ------------------------------------------------------- card scoring ----

  // Quality on a 1-5 scale, matching the prerelease guide's scale so a rated
  // set and an unrated set are directly comparable.
  function heuristicRating(card) {
    const S = window.CFG.score;
    let r;

    if (card.category === 'EVENT') r = S.eventBase;
    else if (card.category === 'STAGE') r = S.stageBase;
    else {
      const cost = card.cost == null ? 0 : card.cost;
      const vanilla = S.vanillaPower[Math.min(cost, 10)] || 12000;
      const delta = ((card.power || 0) - vanilla) / 1000;
      r = 3.0 + delta * S.perThousandPower;
      const c = card.counter || 0;
      r += S.counter[c] !== undefined ? S.counter[c] : (c >= 2000 ? 0.45 : 0);
    }

    for (const tag of card.tags || []) {
      if (S.keyword[tag]) r += S.keyword[tag];
    }
    return Math.max(1, Math.min(5, r));
  }

  // The guide's rating wins when we have one; otherwise fall back to stats.
  function baseRating(card, ratings) {
    const entry = ratings && ratings[card.baseId || card.id];
    if (entry && typeof entry.rating === 'number') {
      return { value: entry.rating, source: 'guide', note: entry.note || '' };
    }
    return { value: heuristicRating(card), source: 'heuristic', note: '' };
  }

  // How much of a brick penalty actually lands, given the card's quality.
  // A 5.0 pays nothing; a 3.5 or below pays in full.
  function forgiveness(rating) {
    const S = window.CFG.score;
    const span = S.brickForgiveAt - S.brickForgiveFrom;
    if (span <= 0) return 1;
    return Math.max(0, Math.min(1, 1 - (rating - S.brickForgiveFrom) / span));
  }

  // Static part of a card's value -- everything that doesn't depend on which
  // other cards made the deck. Computed once per build.
  function staticValue(card, leader, ratings) {
    const S = window.CFG.score;
    const base = baseRating(card, ratings);
    let v = base.value;
    const reasons = [
      base.source === 'guide'
        ? `guide rating ${base.value.toFixed(1)}`
        : `heuristic rating ${base.value.toFixed(1)}`,
    ];

    // A wildcard Leader answers every Leader-keyed rider in the set, so the
    // adjustment is the same for every card and carries no ranking information.
    // The guide's ratings were written for this format and already assume it.
    if (leader && !leader.wildcard) {
      const leaderTypes = new Set(leader.types || []);
      const shared = (card.types || []).filter((t) => leaderTypes.has(t));
      if (shared.length) {
        v += S.leaderTypeMatch * shared.length;
        reasons.push(`shares ${shared.join('/')} with Leader`);
      }
      const satisfied = (card.reqTypes || []).filter((t) => leaderTypes.has(t));
      if (satisfied.length) {
        v += S.leaderReqSatisfied;
        reasons.push(`Leader satisfies "${satisfied.join('/')}" rider`);
      }

      // "If your Leader is [Shanks] / has the {Rocks Pirates} type" -- either
      // the Leader answers it or the text is dead weight. Nothing the deck
      // contains can change that, so it's priced here rather than per-deck.
      const leaderReq = card.reqLeader || [];
      if (leaderReq.length) {
        const met = leaderReq.some((t) => leaderTypes.has(t) || t === leader.name);
        if (met) {
          v += S.leaderReqSatisfied;
          reasons.push('Leader turns its rider on');
        } else {
          const dead = S.leaderReqDead * forgiveness(base.value);
          v -= dead;
          if (dead > 0.05) {
            reasons.push(`needs a ${leaderReq.join('/')} Leader — dead ${-dead.toFixed(2)}`);
          }
        }
      }
    }

    // A 2000 counter attached to a body you'd actually cast is worth more than
    // the same counter on a card that can only ever be pitched.
    if ((card.counter || 0) >= 2000 && card.category === 'CHARACTER') {
      const vanilla = S.vanillaPower[Math.min(card.cost ?? 0, 10)] || 12000;
      if ((card.power || 0) >= vanilla - S.dualPurposeSlack) {
        v += S.dualPurposeBonus;
        reasons.push('2k counter on a castable body');
      }
    }

    // Curve brick: expensive cards you can't cast early.
    let curveBrick = 0;
    if (card.cost != null && card.cost >= S.curveBrickCost) {
      const raw = (card.cost - S.curveBrickCost + 1) * S.curveBrickWeight;
      curveBrick = raw * forgiveness(base.value);
      if (curveBrick > 0.05) reasons.push(`${card.cost}-cost brick risk -${curveBrick.toFixed(2)}`);
    }

    return {
      base: base.value,
      source: base.source,
      note: base.note,
      value: v - curveBrick,
      curveBrick,
      forgive: forgiveness(base.value),
      reasons,
    };
  }

  // ------------------------------------------------------ deck evaluation ---
  //
  // The search runs ~10^5 candidate decks, so the hot path uses a precomputed
  // context of typed arrays and O(1) aggregate updates per swap. `evaluate()`
  // below is the readable full recompute, kept for the final report and used
  // to assert the fast path agrees (see selfCheck).

  // Which curve bucket a card occupies, or -1 if it doesn't occupy one at all.
  // Counter fodder -- an expensive body carrying a 2000 counter -- is a card you
  // hold and pitch, not a card you cast, so it shouldn't consume a curve slot.
  function curveSlot(card) {
    const D = window.CFG.deck;
    const cost = card.cost == null ? 0 : card.cost;
    if (D.curveExemptCounterFodder &&
        cost >= D.curveExemptFromCost &&
        (card.counter || 0) >= 2000) {
      return -1;
    }
    return Math.min(cost, 7);
  }

  function makeContext(entries, statics) {
    const typeIdx = new Map();
    const nameIdx = new Map();
    const idFor = (map, key) => {
      let i = map.get(key);
      if (i === undefined) { i = map.size; map.set(key, i); }
      return i;
    };

    const n = entries.length;
    const ctx = {
      n,
      statics,
      value: new Float64Array(n),
      forgive: new Float64Array(n),
      slot: new Int32Array(n),
      isFodder: new Uint8Array(n),
      is2k: new Uint8Array(n),
      hasCounter: new Uint8Array(n),
      isBlocker: new Uint8Array(n),
      isChar: new Uint8Array(n),
      types: new Array(n),
      nameId: new Int32Array(n),
      reqTypes: new Array(n),
      reqNames: new Array(n),
      reqEntries: [],
      typeIdx, nameIdx,
    };

    for (let i = 0; i < n; i++) {
      const c = entries[i].card;
      ctx.value[i] = statics[i].value;
      ctx.forgive[i] = statics[i].forgive;
      ctx.slot[i] = curveSlot(c);
      ctx.isFodder[i] = curveSlot(c) < 0 ? 1 : 0;
      ctx.is2k[i] = (c.counter || 0) >= 2000 ? 1 : 0;
      ctx.hasCounter[i] = (c.counter || 0) > 0 || (c.tags || []).includes('counter_event') ? 1 : 0;
      ctx.isBlocker[i] = (c.tags || []).includes('blocker') ? 1 : 0;
      ctx.isChar[i] = c.category === 'CHARACTER' ? 1 : 0;
      ctx.types[i] = (c.types || []).map((t) => idFor(typeIdx, t));
      ctx.nameId[i] = idFor(nameIdx, c.name);
      ctx.reqTypes[i] = (c.reqTypes || []).map((t) => idFor(typeIdx, t));
      ctx.reqNames[i] = (c.reqNames || []).map((t) => idFor(nameIdx, t));
      if (ctx.reqTypes[i].length || ctx.reqNames[i].length) ctx.reqEntries.push(i);
    }
    ctx.nTypes = typeIdx.size;
    ctx.nNames = nameIdx.size;
    return ctx;
  }

  function newAgg(ctx) {
    return {
      staticSum: 0,
      n2k: 0, nCounters: 0, nNoCounter: 0, nBlockers: 0, nChars: 0, nNonChars: 0, nFodder: 0,
      curve: new Int32Array(8),
      typeCount: new Int32Array(ctx.nTypes),
      nameCount: new Int32Array(ctx.nNames),
    };
  }

  function applyDelta(agg, ctx, i, d) {
    agg.staticSum += ctx.value[i] * d;
    if (ctx.slot[i] >= 0) agg.curve[ctx.slot[i]] += d; else agg.nFodder += d;
    if (ctx.is2k[i]) agg.n2k += d;
    if (ctx.hasCounter[i]) agg.nCounters += d; else agg.nNoCounter += d;
    if (ctx.isBlocker[i]) agg.nBlockers += d;
    if (ctx.isChar[i]) agg.nChars += d; else agg.nNonChars += d;
    for (const t of ctx.types[i]) agg.typeCount[t] += d;
    agg.nameCount[ctx.nameId[i]] += d;
  }

  function buildAgg(counts, ctx) {
    const agg = newAgg(ctx);
    for (let i = 0; i < ctx.n; i++) if (counts[i]) applyDelta(agg, ctx, i, counts[i]);
    return agg;
  }

  // Conditional bricks -- only cards that actually carry a rider can pay this,
  // so we walk `reqEntries` rather than the whole deck.
  function conditionalPenalty(counts, ctx) {
    const S = window.CFG.score;
    let total = 0;
    for (const i of ctx.reqEntries) {
      const n = counts[i];
      if (!n) continue;
      let worst = 0;
      for (const t of ctx.reqTypes[i]) {
        const have = ctxTypeCount(i, t, n, ctx) ;
        const shortfall = Math.max(0, S.enablerTarget - have) / S.enablerTarget;
        const pen = shortfall * S.conditionalWeight * ctx.forgive[i];
        if (pen > worst) worst = pen;
      }
      for (const nm of ctx.reqNames[i]) {
        const have = ctx._agg.nameCount[nm] - (ctx.nameId[i] === nm ? n : 0);
        const pen = (have > 0 ? 0 : 1) * S.conditionalWeight * ctx.forgive[i];
        if (pen > worst) worst = pen;
      }
      total += worst * n;
    }
    return total;
  }

  // A card never counts as its own enabler.
  function ctxTypeCount(i, t, n, ctx) {
    const own = ctx.types[i].includes(t) ? n : 0;
    return ctx._agg.typeCount[t] - own;
  }

  function structuralPenalty(agg, collect) {
    const D = window.CFG.deck;
    let p = 0;

    for (const cost of Object.keys(D.curve)) {
      const [lo, hi] = D.curve[cost];
      const have = agg.curve[+cost];
      const off = have < lo ? lo - have : have > hi ? have - hi : 0;
      if (off) {
        p += off * D.curveWeight;
        if (collect) collect.push(`curve ${cost}${cost === '7' ? '+' : ''}: ${have} (want ${lo}-${hi})`);
      }
    }

    const short2k = Math.max(0, D.target2kCounters - agg.n2k);
    if (short2k) {
      p += short2k * D.counterFloorWeight;
      if (collect) collect.push(`only ${agg.n2k} 2k counters (want ${D.target2kCounters}-${D.max2kCounters})`);
    }
    const over2k = D.max2kCounters ? Math.max(0, agg.n2k - D.max2kCounters) : 0;
    if (over2k) {
      p += over2k * D.over2kWeight;
      if (collect) collect.push(`${agg.n2k} 2k counters (max ${D.max2kCounters})`);
    }

    if (agg.nNoCounter > D.maxNoCounter) {
      p += (agg.nNoCounter - D.maxNoCounter) * D.noCounterWeight;
      if (collect) collect.push(`${agg.nNoCounter} counterless cards (max ${D.maxNoCounter})`);
    }

    if (D.maxCounterFodder != null && agg.nFodder > D.maxCounterFodder) {
      p += (agg.nFodder - D.maxCounterFodder) * D.counterFodderWeight;
      if (collect) collect.push(`${agg.nFodder} uncastable counter cards (max ${D.maxCounterFodder})`);
    }

    if (agg.nBlockers < D.minBlockers) {
      p += (D.minBlockers - agg.nBlockers) * D.blockerWeight;
      if (collect) collect.push(`${agg.nBlockers} blockers (want ${D.minBlockers}+)`);
    }

    if (agg.nNonChars > D.maxNonCharacters) {
      p += (agg.nNonChars - D.maxNonCharacters) * D.nonCharacterWeight;
      if (collect) collect.push(`${agg.nNonChars} events/stages (max ${D.maxNonCharacters})`);
    }

    if (agg.nChars < D.minCharacters) {
      p += (D.minCharacters - agg.nChars) * D.characterWeight;
      if (collect) collect.push(`${agg.nChars} characters (want ${D.minCharacters}+)`);
    }
    return p;
  }

  // Counters earned above the floor, capped at the ceiling.
  function counterBonus(n2k) {
    const D = window.CFG.deck;
    if (!D.counterBonusInBand) return 0;
    const ceiling = D.max2kCounters == null ? Infinity : D.max2kCounters;
    return Math.max(0, Math.min(n2k, ceiling) - D.target2kCounters) * D.counterBonusInBand;
  }

  function fastScore(counts, ctx, agg) {
    ctx._agg = agg;
    const bonus = Math.min(agg.nBlockers, 5) * window.CFG.deck.blockerBonus
                + counterBonus(agg.n2k);
    return agg.staticSum + bonus - conditionalPenalty(counts, ctx) - structuralPenalty(agg, null);
  }

  // Readable full recompute. Same maths, no incremental state -- used for the
  // final report and by selfCheck() to verify the fast path.
  function evaluate(deckCounts, entries, statics) {
    const D = window.CFG.deck;
    const S = window.CFG.score;

    let total = 0;
    let n2k = 0, nCounters = 0, nNoCounter = 0, nBlockers = 0, nChars = 0, nNonChars = 0, nFodder = 0;
    const curve = {};
    const typeCount = {};
    const nameCount = {};

    for (let i = 0; i < entries.length; i++) {
      const n = deckCounts[i];
      if (!n) continue;
      const c = entries[i].card;
      total += statics[i].value * n;

      if (c.counter >= 2000) n2k += n;
      if (c.counter > 0 || (c.tags || []).includes('counter_event')) nCounters += n;
      else nNoCounter += n;
      if ((c.tags || []).includes('blocker')) nBlockers += n;
      if (c.category === 'CHARACTER') nChars += n;
      else nNonChars += n;

      const slot = curveSlot(c);
      if (slot >= 0) curve[slot] = (curve[slot] || 0) + n; else nFodder += n;

      for (const t of c.types || []) typeCount[t] = (typeCount[t] || 0) + n;
      nameCount[c.name] = (nameCount[c.name] || 0) + n;
    }

    // Conditional bricks -- this is the term that makes the problem non-linear.
    let conditional = 0;
    const brickDetail = [];
    for (let i = 0; i < entries.length; i++) {
      const n = deckCounts[i];
      if (!n) continue;
      const c = entries[i].card;
      let worst = 0, worstReq = null;

      for (const t of c.reqTypes || []) {
        const have = (typeCount[t] || 0) - ((c.types || []).includes(t) ? n : 0);
        const shortfall = Math.max(0, S.enablerTarget - have) / S.enablerTarget;
        const pen = shortfall * S.conditionalWeight * statics[i].forgive;
        if (pen > worst) { worst = pen; worstReq = `${t} (${have} in deck)`; }
      }
      for (const nm of c.reqNames || []) {
        const have = (nameCount[nm] || 0) - (c.name === nm ? n : 0);
        const shortfall = have > 0 ? 0 : 1;
        const pen = shortfall * S.conditionalWeight * statics[i].forgive;
        if (pen > worst) { worst = pen; worstReq = `${nm} (${have} in deck)`; }
      }
      if (worst > 0) {
        conditional += worst * n;
        brickDetail.push({ index: i, penalty: worst, req: worstReq });
      }
    }
    total -= conditional;

    // ---- structural constraints ----
    const penalties = [];
    let structural = 0;

    for (const [cost, band] of Object.entries(D.curve)) {
      const have = curve[cost] || 0;
      const off = have < band[0] ? band[0] - have : have > band[1] ? have - band[1] : 0;
      if (off) {
        structural += off * D.curveWeight;
        penalties.push(`curve ${cost}${cost === '7' ? '+' : ''}: ${have} (want ${band[0]}-${band[1]})`);
      }
    }

    const short2k = Math.max(0, D.target2kCounters - n2k);
    if (short2k) {
      structural += short2k * D.counterFloorWeight;
      penalties.push(`only ${n2k} 2k counters (want ${D.target2kCounters}-${D.max2kCounters})`);
    }
    const over2k = D.max2kCounters ? Math.max(0, n2k - D.max2kCounters) : 0;
    if (over2k) {
      structural += over2k * D.over2kWeight;
      penalties.push(`${n2k} 2k counters (max ${D.max2kCounters})`);
    }

    if (nNoCounter > D.maxNoCounter) {
      structural += (nNoCounter - D.maxNoCounter) * D.noCounterWeight;
      penalties.push(`${nNoCounter} counterless cards (max ${D.maxNoCounter})`);
    }

    if (D.maxCounterFodder != null && nFodder > D.maxCounterFodder) {
      structural += (nFodder - D.maxCounterFodder) * D.counterFodderWeight;
      penalties.push(`${nFodder} uncastable counter cards (max ${D.maxCounterFodder})`);
    }

    if (nBlockers < D.minBlockers) {
      structural += (D.minBlockers - nBlockers) * D.blockerWeight;
      penalties.push(`${nBlockers} blockers (want ${D.minBlockers}+)`);
    }
    total += Math.min(nBlockers, 5) * D.blockerBonus;
    total += counterBonus(n2k);

    if (nNonChars > D.maxNonCharacters) {
      structural += (nNonChars - D.maxNonCharacters) * D.nonCharacterWeight;
      penalties.push(`${nNonChars} events/stages (max ${D.maxNonCharacters})`);
    }
    if (nChars < D.minCharacters) {
      structural += (D.minCharacters - nChars) * D.characterWeight;
      penalties.push(`${nChars} characters (want ${D.minCharacters}+)`);
    }

    total -= structural;

    return {
      score: total,
      stats: { n2k, nCounters, nNoCounter, nBlockers, nChars, nNonChars, nFodder, curve, typeCount },
      penalties,
      brickDetail,
      conditional,
    };
  }

  // ------------------------------------------------------------ search ------

  function anneal(entries, statics, ctx, rng, seedCounts) {
    const F = window.CFG.format;
    const SV = window.CFG.solver;
    const nEntries = entries.length;
    const target = F.deckSize;

    // null/undefined means "no limit" -- Infinity doesn't survive a JSON
    // round-trip, so don't let a serialised config silently cap everything to 0.
    const limit = (F.copyLimit == null) ? Infinity : F.copyLimit;
    const caps = entries.map((e) => Math.min(e.count, limit));
    if (caps.reduce((a, b) => a + b, 0) < target) return null; // pool too small

    let counts;
    if (seedCounts) {
      counts = seedCounts.slice();
    } else {
      // Greedy seed: best static value first. Gives annealing a running start.
      const order = statics.map((s, i) => [i, s.value])
        .sort((a, b) => b[1] - a[1]).map((x) => x[0]);
      counts = new Array(nEntries).fill(0);
      let placed = 0;
      for (const i of order) {
        if (placed >= target) break;
        const take = Math.min(caps[i], target - placed);
        counts[i] = take;
        placed += take;
      }
    }

    const agg = buildAgg(counts, ctx);
    let cur = fastScore(counts, ctx, agg);
    let bestScore = cur;
    let bestCounts = counts.slice();

    // Maintained rather than rebuilt: `outs` is every entry with a copy in the
    // deck, `ins` every entry with a spare copy in the pool.
    const outs = [], ins = [];
    const outPos = new Int32Array(nEntries).fill(-1);
    const inPos = new Int32Array(nEntries).fill(-1);
    const push = (arr, pos, i) => { pos[i] = arr.length; arr.push(i); };
    const drop = (arr, pos, i) => {
      const p = pos[i], last = arr.pop();
      if (p < arr.length) { arr[p] = last; pos[last] = p; }
      pos[i] = -1;
    };
    for (let i = 0; i < nEntries; i++) {
      if (counts[i] > 0) push(outs, outPos, i);
      if (counts[i] < caps[i]) push(ins, inPos, i);
    }
    const sync = (i) => {
      const inDeck = counts[i] > 0, hasSpare = counts[i] < caps[i];
      if (inDeck && outPos[i] < 0) push(outs, outPos, i);
      if (!inDeck && outPos[i] >= 0) drop(outs, outPos, i);
      if (hasSpare && inPos[i] < 0) push(ins, inPos, i);
      if (!hasSpare && inPos[i] >= 0) drop(ins, inPos, i);
    };

    const decay = Math.pow(SV.endTemp / SV.startTemp, 1 / SV.iterations);
    let temp = SV.startTemp;

    for (let it = 0; it < SV.iterations; it++, temp *= decay) {
      if (!outs.length || !ins.length) break;
      const out = outs[(rng() * outs.length) | 0];
      const inn = ins[(rng() * ins.length) | 0];
      if (out === inn) continue;

      counts[out]--; applyDelta(agg, ctx, out, -1);
      counts[inn]++; applyDelta(agg, ctx, inn, +1);
      const next = fastScore(counts, ctx, agg);
      const delta = next - cur;

      if (delta >= 0 || rng() < Math.exp(delta / temp)) {
        cur = next;
        sync(out); sync(inn);
        if (cur > bestScore) { bestScore = cur; bestCounts = counts.slice(); }
      } else {
        counts[out]++; applyDelta(agg, ctx, out, +1);
        counts[inn]--; applyDelta(agg, ctx, inn, -1);
      }
    }

    return { counts: bestCounts, result: evaluate(bestCounts, entries, statics) };
  }

  // --------------------------------------------------------- public API -----

  // pool: [{card, count}]  ->  best deck for one specific leader
  function solveForLeader(pool, leader, ratings, rng) {
    const entries = pool.filter((e) => e.card.category !== 'LEADER');
    if (!entries.length) return null;

    const statics = entries.map((e) => staticValue(e.card, leader, ratings));
    const ctx = makeContext(entries, statics);

    let best = null;
    for (let r = 0; r < window.CFG.solver.restarts; r++) {
      // Restart 0 starts greedy; later restarts re-anneal from the incumbent so
      // the extra passes deepen the search instead of repeating it.
      const attempt = anneal(entries, statics, ctx, rng, best ? best.counts : null);
      if (attempt && (!best || attempt.result.score > best.result.score)) best = attempt;
    }
    if (!best) return null;

    // Marginal analysis: for every card left out, how much would the deck lose
    // by swapping in one copy for its weakest current card? That number is the
    // honest "how close was this to making it" figure.
    const weakest = best.counts
      .map((n, i) => (n ? [i, statics[i].value] : null))
      .filter(Boolean)
      .sort((a, b) => a[1] - b[1])[0];

    const cuts = [];
    for (let i = 0; i < entries.length; i++) {
      const unused = entries[i].count - best.counts[i];
      if (unused <= 0) continue;
      let margin = null;
      if (weakest && weakest[0] !== i) {
        const trial = best.counts.slice();
        trial[weakest[0]]--; trial[i]++;
        margin = evaluate(trial, entries, statics).score - best.result.score;
      }
      cuts.push({
        card: entries[i].card,
        count: unused,
        static: statics[i],
        margin,
      });
    }
    cuts.sort((a, b) => (b.margin ?? -99) - (a.margin ?? -99));

    const deck = [];
    for (let i = 0; i < entries.length; i++) {
      if (best.counts[i]) {
        const brick = best.result.brickDetail.find((b) => b.index === i);
        deck.push({
          card: entries[i].card,
          count: best.counts[i],
          static: statics[i],
          brick: brick || null,
        });
      }
    }
    deck.sort((a, b) =>
      (a.card.cost ?? 99) - (b.card.cost ?? 99) ||
      b.static.value - a.static.value);

    return { leader, deck, cuts, result: best.result };
  }

  // Try every candidate leader, keep the best deck.
  function buildDeck(pool, leaderCandidates, ratings, seed) {
    const rng = mulberry32(seed ?? 12345);
    const tried = [];
    for (const leader of leaderCandidates) {
      const sol = solveForLeader(pool, leader, ratings, rng);
      if (sol) tried.push(sol);
    }
    if (!tried.length) return null;
    tried.sort((a, b) => b.result.score - a.result.score);
    const winner = tried[0];
    winner.leaderRanking = tried.map((t) => ({
      leader: t.leader,
      score: t.result.score,
    }));
    return winner;
  }

  // Two implementations of one objective is exactly the kind of thing that
  // silently drifts, so prove they agree on random decks before trusting the
  // fast one. Returns the largest disagreement seen.
  function selfCheck(pool, leader, ratings, trials) {
    const entries = pool.filter((e) => e.card.category !== 'LEADER');
    if (entries.length < 2) return 0;
    const statics = entries.map((e) => staticValue(e.card, leader, ratings));
    const ctx = makeContext(entries, statics);
    const caps = entries.map((e) => Math.min(e.count, window.CFG.format.copyLimit));
    const rng = mulberry32(99);

    let worst = 0;
    for (let t = 0; t < (trials || 25); t++) {
      const counts = new Array(entries.length).fill(0);
      let placed = 0;
      while (placed < window.CFG.format.deckSize) {
        const i = (rng() * entries.length) | 0;
        if (counts[i] >= caps[i]) continue;
        counts[i]++; placed++;
      }
      const fast = fastScore(counts, ctx, buildAgg(counts, ctx));
      const slow = evaluate(counts, entries, statics).score;
      worst = Math.max(worst, Math.abs(fast - slow));
    }
    return worst;
  }

  window.Solver = {
    buildDeck, solveForLeader, heuristicRating, baseRating, evaluate,
    mulberry32, selfCheck,
  };
})();
