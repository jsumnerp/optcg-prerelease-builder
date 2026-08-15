// Every tunable number lives here so you can argue with the model without
// touching the solver.  `window.CFG` is read live on each build, so edit,
// refresh, rebuild.

window.CFG = {
  // ---- Sealed format ------------------------------------------------------
  format: {
    packs: 6,          // Bandai's suggested prerelease kit
    cardsPerPack: 12,
    deckSize: 40,      // prerelease deck is Leader + 40 (constructed is 50)
    copyLimit: Infinity, // prerelease lifts the 4-copy rule
    rainbow: true,     // no colour restriction from your Leader

    // The prerelease kit supplies the rainbow Monkey.D.Luffy Leader and
    // everyone plays it, so the Leader is fixed rather than chosen. Set this
    // to null to go back to evaluating every Leader in the set.
    //
    // `wildcard` is the whole point of this card: its printed text is "This
    // Leader is treated as a card with all card names, types, and attributes."
    // So every "If your Leader is [Shanks]" / "if your Leader has the {Rocks
    // Pirates} type" rider in the set is switched ON. Riders that need support
    // *in your deck* are unaffected -- the Leader can't reveal itself off the
    // top of your deck.
    fixedLeader: {
      id: 'P-RAINBOW-LUFFY',
      name: 'Monkey.D.Luffy (rainbow)',
      rarity: 'P',
      category: 'LEADER',
      wildcard: true,
      cost: null,
      life: 5,
      power: 5000,
      counter: 0,
      colors: ['Red', 'Green', 'Blue', 'Purple', 'Black', 'Yellow'],
      attribute: '',
      types: [],
      effect: 'This Leader can only be used in designated events according to the rules. '
            + 'This Leader is treated as a card with all card names, types, and attributes '
            + 'according to the rules.',
      trigger: '',
      tags: [],
      reqTypes: [], reqNames: [], reqLeader: [],
      image: 'img/P-RAINBOW-LUFFY.jpg',
    },
    bringOwnLeader: false, // ignored while fixedLeader is set
  },

  // ---- Pack model ---------------------------------------------------------
  // Bandai does NOT publish per-pack odds. These defaults reproduce the
  // community-reported per-box counts for a 24-pack box: 2 Leaders, 6 SR,
  // ~0.5 SEC. Rares fill the rest of the hit slot. Change freely.
  pack: {
    slots: { C: 7, UC: 4 },   // 11 base cards...
    hitSlot: {                // ...plus 1 hit, drawn from this distribution
      R:   0.642,
      SR:  0.250,   // 6 per 24-pack box
      L:   0.083,   // 2 per box
      SEC: 0.021,   // ~0.5 per box
      SP:  0.004,   // ~1 per 12-box case
    },
  },

  // ---- What a good sealed deck looks like ---------------------------------
  deck: {
    // cost -> [min, max] cards at that cost. 7 means "7 or more".
    // Ceilings only -- the minimums are deliberately 0.
    //
    // Goldfishing 60 decks x 300 games says the low-end floors earn nothing:
    // floors-only decks are as clunky as no curve constraint at all (9.5% vs
    // 9.6% dead turns), while ceilings-only matches the full set of bands
    // (8.3% vs 8.2%). The reason is that the 2k-counter target already *is* a
    // curve constraint -- OP17 puts its 2000-counters at 1 and 3 cost (4.4 and
    // 4.3 copies per pool, against 0.2 at four cost), so requiring 10+ of them
    // fills the cheap slots on its own. What counters can't stop is the top end
    // bloating on high-rated fatties, which is what these caps are for.
    //
    // The 7+ cap is the load-bearing one: 5 -> 4 takes dead turns 8.3% -> 7.9%
    // for 0.018 rating/card. Tightening further to 3 only buys another 0.2pp.
    curve: { 0: [0, 4], 1: [0, 8], 2: [0, 9], 3: [0, 8], 4: [0, 8], 5: [0, 7], 6: [0, 4], 7: [0, 4] },

    // An expensive card with a 2000 counter doesn't compete for a curve slot
    // the way a plain fatty does. Kingdew (7c/8000/+2000) is DUAL-PURPOSE: cast
    // it on 7, or pitch it for 2000 on a turn you'd rather not -- so it is
    // never a dead draw, which is exactly what the top-end cap exists to limit.
    // A 7c/9000 with no counter has only one mode and does deserve the cap.
    //
    // Counting the dual-purpose ones against it made the solver refuse the very
    // cards it needed to reach the counter target: on seed 562113 it flagged
    // "curve 7+: 6" and "only 8 2k counters" simultaneously while leaving five
    // 7-cost 2k-counters unplayed.
    curveExemptCounterFodder: true,
    curveExemptFromCost: 6,
    // Exempt is not unlimited, though. These cards are fine to draw late but
    // still can't be cast before turn 6, so a deck leaning entirely on them
    // starts slowly. The cap is about early-game density, NOT about the cards
    // being useless -- they aren't. It binds rarely: a pool opens ~5.5 of them
    // and the solver takes ~4.4.
    maxCounterFodder: 5,
    counterFodderWeight: 0.9,
    curveWeight: 1.8,          // score lost per card outside a band

    // Aim at 14, no ceiling -- more is fine. The floor is SOFT: each missing
    // counter costs `counterFloorWeight`, so the solver stops short when the
    // last counters would cost real cards.
    //
    // 2.5 is the efficient point. Sweeping it over 120 pools: 0.9 -> mean 11.7,
    // 28% reach 14, 3.952 rating/card; 1.5 -> 13.0, 58%, 3.925; 2.5 -> 13.6,
    // 83%, 3.910; 4.0 -> 13.6, 83%, 3.908. Raising it past 2.5 changes nothing,
    // which is the evidence that 2.5 is not force-marching: the 17% that fall
    // short do so because the pool has no more counters, not because the push
    // is too weak. Drop toward 0.9 to make it advisory.
    target2kCounters: 14,
    max2kCounters: null,       // no ceiling
    counterFloorWeight: 2.5,
    over2kWeight: 0,
    // Only meaningful with a ceiling set; with a bare floor there is no band
    // to reward inside.
    counterBonusInBand: 0,
    // Sealed decks run far more counter cards than constructed -- most commons
    // carry 1000. So the constraint that matters is a ceiling on *counterless*
    // cards, not a band on counter cards.
    maxNoCounter: 12,
    noCounterWeight: 0.5,

    // Blockers are the one card type every published sealed guide calls
    // "extremely good", and they rate 4.00 in the guide against a 3.59 set
    // average. A pool opens ~9, and decks land near 6.5 unprompted -- so this
    // floor is insurance against a bad pool rather than a thumb on the scale.
    // It matters more now the counter target is up: OP17's blockers and its
    // 2k-counter cards are near-disjoint (15 and 22 cards, overlap of 1), so
    // the two goals compete for the same slots.
    minBlockers: 5,
    blockerWeight: 1.5,
    blockerBonus: 0.3,         // per blocker, capped at 5

    maxNonCharacters: 9,       // events + stages
    nonCharacterWeight: 1.0,

    minCharacters: 27,
    characterWeight: 1.0,
  },

  // ---- Card scoring -------------------------------------------------------
  score: {
    // Vanilla power benchmark by cost -- the yardstick for "is this efficient?"
    vanillaPower: { 0: 2000, 1: 3000, 2: 4000, 3: 5000, 4: 6000, 5: 7000,
                    6: 8000, 7: 9000, 8: 10000, 9: 11000, 10: 12000 },
    perThousandPower: 0.35,

    counter: { 2000: 0.45, 1000: 0.15, 0: -0.25 },

    // Two cards can both "be a 2000 counter" and be worth very different things.
    // Kingdew (7c/8000/+2000) is dual-purpose: cast it on 7, or pitch it for
    // 2000 on a turn you'd rather not. Crone Oli (1c/*0 power*/+2000) is
    // single-purpose -- it will never be a play, only ever a counter.
    //
    // `dualPurposeBonus` pays a 2000-counter card whose body is worth casting
    // at its cost (within `dualPurposeSlack` of the vanilla benchmark). It is
    // the difference between counting counters and counting *useful* counters.
    dualPurposeBonus: 0.5,
    dualPurposeSlack: 1000,

    keyword: {
      blocker: 0.75, rush: 0.45, double_attack: 0.35, banish: 0.20,
      trigger: 0.30, removal: 0.80, power_down: 0.40, draw: 0.35,
      search: 0.25, ramp: 0.50, life_gain: 0.30, on_play: 0.15,
      counter_event: 1.00, when_attacking: 0.15, on_ko: 0.20,
      activate_main: 0.15,
    },

    eventBase: 2.0,
    stageBase: 2.0,

    // Leader synergy
    leaderTypeMatch: 0.20,     // per shared type with your Leader
    leaderReqSatisfied: 0.40,  // card's rider names a type your Leader has
    // A rider keyed to a *specific* Leader ("If your Leader is [Shanks]") is
    // simply dead under a neutral rainbow Leader. Forgiveness still applies, so
    // a 5.0-rated card keeps its slot on the strength of the rest of its text.
    leaderReqDead: 0.85,

    // ---- Bricks ----
    // A brick is a card that's dead in hand. Two kinds:
    curveBrickCost: 6,         // cost >= this starts paying a curve-brick tax
    curveBrickWeight: 0.35,    // per point of cost above the threshold
    // Conditional bricks: card needs N supporting cards to reliably turn on.
    enablerTarget: 6,          // deck copies of a required type to be "on"
    conditionalWeight: 0.90,
    // "...unless good effects": a high rating buys the penalty back. Cards at
    // or above `brickForgiveAt` pay nothing; it scales linearly below that.
    brickForgiveAt: 5.0,
    brickForgiveFrom: 3.5,
  },

  // ---- Optimiser ----------------------------------------------------------
  solver: {
    restarts: 5,
    iterations: 9000,
    startTemp: 2.5,
    endTemp: 0.02,
    synergyPasses: 3,   // re-solve after recomputing conditional enablers
  },
};
