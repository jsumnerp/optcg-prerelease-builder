# OPTCG Sealed Deck Solver — OP17

Simulates an OP-17 prerelease: opens 6 packs, then builds the best legal 40-card
deck out of what it opened. One button, repeatable by seed, plus a batch mode
that runs many pools and reports how often the deck hits its targets.

```bash
./run.sh
```

Then open <http://localhost:8777/web/>.

---

## The format it's solving

Bandai's prerelease rules, not constructed:

| | |
|---|---|
| Pool | 6 booster packs, 12 cards each = 72 cards |
| Deck | Leader + **40** (constructed is 50) |
| Colour | **Rainbow** — no colour restriction |
| Copies | **No 4-copy limit** — play as many duplicates as you opened |
| Leader | The kit's **rainbow Monkey.D.Luffy**, same for everyone |

### The rainbow Leader matters more than it looks

Its printed text is *"This Leader is treated as a card with all card names,
types, and attributes."* It's a **wildcard**, not a blank. Every rider in the
set keyed to your Leader — "If your Leader is [Shanks]", "if your Leader has
the {Rocks Pirates} type" — is switched **on**. 20 of 129 OP17 cards carry one,
and under a normal mono-colour Leader most of them would be dead text.

What it does *not* do is fix riders that need support **in your deck**: Lucky
Roux still has to find a Red-Haired Pirates card in your deck to reveal. That
distinction is why the solver keeps `reqLeader` and `reqTypes` as separate
fields — the Leader answers the first and only deck composition answers the
second.

Because the wildcard answers every Leader rider identically, it carries no
ranking information, so the solver applies **no** Leader-synergy adjustment at
all — and the guide's ratings were written for this format anyway, so the
riders being live is already priced into them.

Leaders you open in packs are unusable and are shown as such. Set
`format.fixedLeader` to `null` in `web/config.js` to go back to evaluating all
six set Leaders (useful for constructed-style what-ifs).

## Where the card data came from

**OP17 is not on Bandai's official card list yet.** I checked directly:
`en.onepiece-cardgame.com/cardlist/?series=569117` returns an empty page and
`/images/cardlist/card/OP17-001.png` 404s (OP16's equivalent returns a 200).
The set releases 28 Aug 2026. So the OP17 dataset is stitched from three
sources, and you should know which field came from where:

| Field | Source | Confidence |
|---|---|---|
| rating, commentary | your `OP17 Prerelease Guide.xlsx` | authoritative |
| rarity | same spreadsheet | authoritative |
| name, types, effect text | card-preview site scrape | high |
| **cost, power, counter, colour, category** | **read off prerelease card scans by eye** | **see below** |
| SP reprint stats (`EB04-007`, `ST32-002`, …) | Bandai's own card list | authoritative |

### How the scan-read stats were checked

The guide's commentary repeatedly says things like *"A vanilla 4c would have 1k
counter"* about the card being rated. That's an independent statement of the
card's cost, written by someone holding the card. `scripts/build_op17.py`
extracts every such claim and compares it to the hand-entered table:

```
cost cross-check vs guide notes: 52 agree, 0 disagree, 67 notes make no cost claim
```

52 of 52 checkable costs agree. The resulting rarity split (46 C / 29 UC / 26 R
/ 10 SR / 2 SEC / 6 L) also matches OP16's exactly, as you'd expect from a set
built to the same skeleton.

**What is still soft:** counter values are the weakest field — they're printed
sideways on the card edge and several source scans are angled phone photos.
`OP17-085` (Dorry) had no usable scan at all; its 5c/5000 is inferred from the
guide's note and it ships with a placeholder image. Everything is in
`data/op17_stats.tsv`, one line per card — correct anything you spot and re-run
`python3 scripts/build_op17.py`.

### When Bandai publishes OP17

```bash
python3 scripts/scrape_bandai.py OP17 --images
```

That overwrites `data/cards_OP17.json` with official data in the identical
shape. Nothing else changes. The scraper was developed and tested against OP16,
which it parsed cleanly end to end (119 cards + images), so the path works —
that dataset has since been deleted since only OP17 is wanted here.

## The pack model

Bandai does not publish per-pack odds. The defaults in `web/config.js` reproduce
the per-box counts the community has measured for a 24-pack box (2 Leaders,
6 SR, ~0.5 SEC) and put Rares in the rest of the hit slot:

```js
pack: {
  slots:   { C: 7, UC: 4 },            // 11 base cards
  hitSlot: { R: .642, SR: .25, L: .083, SEC: .021, SP: .004 },
}
```

These are an estimate, not a published table. Edit them freely — the whole file
is read live on each build.

## How the solver works

Pick 40 cards from ~45 distinct pool entries to maximise total score. The
objective is **not** linear — a card's value depends on what else made the deck
— so it's simulated annealing over swap moves rather than an LP.

**Per-card value** = guide rating (or a stat-based heuristic for unrated cards)
+ Leader synergy − brick tax.

**Two kinds of brick:**

- *Curve brick* — cost ≥ 6 with no early game. Scales with cost.
- *Conditional brick* — a rider like `a type including {Rocks Pirates}` when the
  deck doesn't have enough Rocks Pirates cards to turn it on. This is the term
  that makes the problem non-linear, and it's what makes the solver build
  archetype-coherent decks even though the format is rainbow. 45 of 129 OP17
  cards carry one.

**"…unless good effects"** is `penalty × max(0, 5.0 − rating) / 1.5`. A 5.0-rated
card pays no brick tax at all; a 3.5 or below pays in full. So Jozu at 6 cost
keeps his slot and a mediocre 7-drop doesn't.

**Deck-level constraints** (all in `config.js`, all soft with a score cost):
**10–14 cards with a 2000 counter**, **≥5 blockers**, at most 12 counterless
cards, at most 5 uncastable counter-fodder cards, per-cost curve **ceilings**,
≤9 events/stages, ≥27 characters.

### A band needs a reward, not just a floor

Penalising below 10 and above 14 is *not* a band — it's a floor, and the solver
banks the minimum and spends every remaining slot on card quality. 109 of 120
pools came out at exactly 10.

`counterBonusInBand` pays 0.9 per 2k counter between the floor and the ceiling.
That number is the measured price of a marginal counter (rating/card fell 0.039
across 1.71 counters when the old target moved 10 → 12, ≈0.9 score each), so
counters are valued at par: the deck takes extras when the pool offers them
cheaply and stops when they would cost real cards.

| bonus | 10 | 11 | 12 | 13 | 14 | mean |
|---|---|---|---|---|---|---|
| 0 | 109 | 4 | 2 | 0 | 0 | 9.99 |
| **0.9** | **44** | 18 | 17 | 10 | 26 | **11.47** |
| 2.0 | 3 | 10 | 13 | 13 | 76 | 13.08 |

Overpaying just moves the pile-up to the ceiling, which is the same bug at the
other end.

Those first two are the deliberate ones. A 6-pack pool opens ~16 copies of
2000-counter cards, so the counter target is never a scarcity problem — it's a
discipline problem, because the set's 2k-counter cards average a **3.14** guide
rating against a 3.59 set average and any quality-maximising build cuts them
all. The blocker floor exists because OP17's blockers (15 cards, mean rating
**4.00**) and its 2k-counter cards (22 cards) overlap in exactly **one** card
(OP17-029 Hongo), so raising one target quietly eats the other.

### The curve is ceilings only, on purpose

Goldfishing 60 decks × 300 games (going first, one mulligan, cast the biggest
affordable card each turn) says the low-end minimums earn nothing:

| curve constraint | dead turns | turn-2 dead | avg cost | 6+ drops |
|---|---|---|---|---|
| both | 8.2% | 12.7% | 3.62 | 7.8 |
| ceilings only | 8.3% | 13.7% | 3.63 | 7.9 |
| floors only | 9.5% | 14.6% | 3.81 | 9.2 |
| none | 9.6% | 15.7% | 3.81 | 9.3 |

Ceilings-only ≈ both; floors-only ≈ nothing. **The 2k-counter target is already
a curve constraint in disguise** — OP17 puts its 2000-counters at 1 and 3 cost
(4.4 and 4.3 copies per pool against 0.2 at four cost), so requiring 10+ of them
fills the cheap slots by itself. What counters can't prevent is the top end
bloating on high-rated fatties, which is what the caps are for. The 7+ cap is
set to 4 rather than 5: it takes dead turns 8.3% → 7.9% for 0.018 rating/card.

### Counter fodder is not a curve slot

An expensive card carrying a 2000 counter is a **counter**, not a 7-drop. You
never cast Kingdew (7c/8000) in a 40-card sealed deck — you hold it and pitch
it. Counting it against the top-end cap made the solver refuse the exact cards
it needed: on seed 562113 it flagged `curve 7+: 6` **and** `only 8 2k counters`
at the same time, while leaving five 7-cost 2k-counters unplayed.

So cards at cost ≥ `curveExemptFromCost` (6) with a 2000 counter occupy no curve
bucket. They still count toward the counter target, the counterless cap and the
40. Seed 562113 goes 8 → 10 counters with every flag cleared.

The exemption can't be unlimited, though — freed from the cap the solver hoards
fodder, and every copy is a card that can never be played. `maxCounterFodder`
(5) caps pure-defence cards directly instead of pretending they're 7-drops.
It rarely binds (mean fodder is 2.5) but it catches the outlier pools.

Honest accounting for the whole change, 120 pools:

| | before exemption | after |
|---|---|---|
| in the 10–14 band | 91% | **96%** |
| all targets met | 63% | **78%** |
| rating per card | 3.919 | **3.945** |
| dead turns | **7.8%** | 8.9% |
| avg cost | 3.52 | 3.67 |

Dead turns got worse, and that is a real cost — the deck now carries ~2.5 cards
it can never cast. But the metric counts "holding counters" as a dead turn,
which for a defensive plan is exactly what you wanted, and the previous
behaviour was self-contradictory: it failed the counter target *because* of a
cap on cards it wasn't going to cast anyway.

The 7+ cap flags on ~37% of pools. That's not noise — it means the pool is
top-heavy in *real* 7-drops.

### Performance

The inner loop keeps aggregates (curve buckets, counter counts, per-type
density) incrementally and only re-walks the cards that carry riders. A build is
**~55 ms** with the fixed Leader, ~190 ms if you turn all six Leaders back on
(the naive full-recompute version took 6.6 s). The readable full-recompute
scorer is kept alongside the fast path, and `Solver.selfCheck()` asserts the two
agree on random decks after every build.

## Tabs

- **Deck** — the 40, grouped by cost, with the curve, the stat chips and every
  unmet target listed explicitly. Red outline = the solver is paying a brick tax
  on that card.
- **Pool** — all 72 cards opened, with duplicate counts.
- **Cuts** — everything left out, ranked by *margin*: the score change from
  swapping it in for the deck's weakest card. Anything near zero is a coin flip
  you should feel free to overrule. Exports too, so you can load your leftovers
  in as a sideboard and try swaps yourself.

### Exporting to Card Kaizoku

Both the Deck and Cuts tabs have **Copy for Card Kaizoku** / **Download .txt**.
The format is the OPTCGSim decklist that Card Kaizoku's *More › Import SIM*
reads — one `<qty>x<cardId>` per line:

```
3xOP17-002
2xOP17-011
1xOP17-014
```

The kit's rainbow Leader has no catalogue number, so it can't be emitted — add
it in Kaizoku yourself. The panel says so rather than silently shipping 40
cards with no Leader.

I verified the button exists and is labelled "Import SIM"; I did not run a
deck through their parser. If it rejects the file, tell me what it expects.
- **Batch stats** — run 100 pools (~2 s) and see how the format actually
  behaves. Current numbers over 100 OP17 pools: **95%** land in the 10–14
  2k-counter band (mean **11.5**, genuinely spread across it), **96%** reach 5+
  blockers, **80%** meet every structural target, mean avg cost 3.75. The ones that miss are genuine pool problems, not
  solver failures — that's what the flags under the curve are for.
- **Quick add** — the one to use at the event, on a phone. The whole set as a
  tappable image grid: tap the art to add one, the **1–5** buttons set a count
  outright, **×** clears. Search by name or code, filter by colour, running
  total in a fixed bottom bar, then Build. Thumbnails are 150px (1.4 MB for the
  set) and tiles repaint individually so tapping never jumps your scroll
  position.
- **Paste** — same thing by keyboard: `OP17-024 x3`, one per line.

## Files

```
scripts/scrape_bandai.py   official Bandai scraper (any set) + image download
scripts/import_ratings.py  xlsx -> ratings JSON (stdlib only, no openpyxl)
scripts/build_op17.py      fuse stats + text + ratings, with the cost cross-check
data/op17_stats.tsv        hand-entered stats — edit here to fix a misread
web/config.js              every tunable number: format, pack odds, weights
web/solver.js              scoring + annealing
web/packs.js               pack simulation
web/app.js                 UI
```

## What it can't do

The guide's ratings are context-free but sealed is contextual — removal is
better in a low-power pool, a vanilla 4-drop is better when your curve has a
hole. Treat the output as a ranked starting point and use the Cuts tab's margins
to argue with it.
