// Booster pack simulation.
//
// Bandai does not publish per-pack odds for the One Piece Card Game. The model
// in config.js is built to reproduce the per-box counts the community has
// measured (2 Leaders, 6 SR, ~0.5 SEC per 24-pack box) and is fully editable.
// Everything here just samples from that model.

(function () {
  'use strict';

  function byRarity(cards) {
    const buckets = { C: [], UC: [], R: [], SR: [], SEC: [], L: [], SP: [], P: [] };
    for (const c of cards) {
      if (c.parallel) { buckets.P.push(c); continue; }
      if (buckets[c.rarity]) buckets[c.rarity].push(c);
      else (buckets[c.rarity] = []).push(c);
    }
    return buckets;
  }

  function pickHitRarity(rng) {
    const dist = window.CFG.pack.hitSlot;
    let roll = rng();
    for (const [rarity, p] of Object.entries(dist)) {
      roll -= p;
      if (roll <= 0) return rarity;
    }
    return 'R'; // probabilities that don't quite sum to 1 fall back to a Rare
  }

  function drawDistinct(bucket, n, rng, taken) {
    const out = [];
    let guard = 0;
    while (out.length < n && guard++ < n * 40) {
      const c = bucket[(rng() * bucket.length) | 0];
      if (!c) break;
      if (taken.has(c.id)) continue; // no duplicates inside one pack
      taken.add(c.id);
      out.push(c);
    }
    // Tiny sets can run out of distinct cards; top up with repeats rather than
    // returning a short pack.
    while (out.length < n && bucket.length) out.push(bucket[(rng() * bucket.length) | 0]);
    return out;
  }

  function openPack(buckets, rng) {
    const taken = new Set();
    const cards = [];
    for (const [rarity, n] of Object.entries(window.CFG.pack.slots)) {
      cards.push(...drawDistinct(buckets[rarity] || [], n, rng, taken));
    }
    let hit = pickHitRarity(rng);
    let bucket = buckets[hit];
    if (!bucket || !bucket.length) { hit = 'R'; bucket = buckets.R; }
    cards.push(...drawDistinct(bucket, 1, rng, taken));
    return cards;
  }

  // Returns { pool: [{card, count}], packs: [[card,...]], raw: [card,...] }
  // A parallel counts as its base printing for deckbuilding purposes.
  function openPacks(cards, nPacks, seed) {
    const rng = window.Solver.mulberry32(seed);
    const buckets = byRarity(cards);
    const byId = new Map(cards.map((c) => [c.id, c]));

    const packs = [];
    for (let i = 0; i < nPacks; i++) packs.push(openPack(buckets, rng));

    const counts = new Map();
    const raw = [];
    for (const pack of packs) {
      for (const c of pack) {
        raw.push(c);
        const base = byId.get(c.baseId) || c;
        counts.set(base.id, (counts.get(base.id) || 0) + 1);
      }
    }

    const pool = [...counts.entries()]
      .map(([id, count]) => ({ card: byId.get(id), count }))
      .filter((e) => e.card)
      .sort((a, b) =>
        (a.card.cost ?? 99) - (b.card.cost ?? 99) ||
        a.card.id.localeCompare(b.card.id));

    return { pool, packs, raw };
  }

  // The prerelease kit hands everyone the same rainbow Leader, so normally
  // there is exactly one candidate. Clearing `fixedLeader` falls back to the
  // general rules: you may bring any Leader you own, including from older sets,
  // so every Leader in the set is a candidate rather than only the ones opened.
  function leaderCandidates(cards, pool) {
    const fixed = window.CFG.format.fixedLeader;
    if (fixed) return [fixed];
    if (window.CFG.format.bringOwnLeader) {
      return cards.filter((c) => c.category === 'LEADER' && !c.parallel);
    }
    const pulled = pool.filter((e) => e.card.category === 'LEADER').map((e) => e.card);
    return pulled.length ? pulled : cards.filter((c) => c.category === 'LEADER' && !c.parallel);
  }

  window.Packs = { openPacks, leaderCandidates, byRarity };
})();
