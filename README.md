# OPTCG Sealed Deck Solver — OP17

Simulates an OP-17 prerelease: opens 6 packs, then builds the best legal 40-card
deck out of what it opened. One button, repeatable by seed, plus a batch mode
that runs many pools and reports how often the deck hits its targets.

```bash
./run.sh          # → http://localhost:8777/
```

It's a **PWA**: installable to your phone's home screen and fully usable
offline, which is the point — venue wifi at a prerelease is not a plan.

## Deploying

The app is a static site at the repo root, so it needs no build step.

**Cloudflare (recommended — auto-deploys on every push).** Two routes, both fine:

*Workers + static assets (what the dashboard steers you to now):*
*Workers & Pages* → *Create* → *Import a repository* → pick this repo → deploy.
`wrangler.toml` already declares the whole app as static assets from `/`, so
there is nothing to configure and no build step.

*Classic Pages:* *Create* → *Pages* tab → *Connect to Git*, then:

| setting | value |
|---|---|
| Framework preset | None |
| Build command | *(leave empty)* |
| Build output directory | `/` |

Either way, every push to `main` redeploys.

**If your repo isn't in the list**, it's the GitHub App's repository access, not
the repo: [github.com/settings/installations](https://github.com/settings/installations)
→ *Cloudflare Workers and Pages* → *Configure* → add it under *Repository
access*. Repos created after you first authorised Cloudflare aren't included
automatically. `_headers` is already in the repo
and tells Cloudflare to revalidate `sw.js`, `config.js` and `data/*` while
caching card art immutably, so a deploy can't pin you to a stale build.

`.github/workflows/` runs a data-validation check on every push (every card has
a cost and an image; reports any card with unknown text). It does **not** deploy
unless you trigger it by hand and have set `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID` — because if Cloudflare's Git integration is connected,
it is already deploying and two paths racing on one project is worse than one.

**GitHub Pages** works too: *Settings → Pages → Source: main, folder `/`*.

### Installing on your phone

Service workers require a **secure origin**. Over `https` (Cloudflare/GitHub
Pages) install works normally — open the site, *Share → Add to Home Screen* on
iOS, or the install prompt on Android. Over plain `http` on a LAN address the
registration is silently skipped: the app still runs, it just can't be
installed or used offline. `localhost` counts as secure, so local dev is fine.

Once installed, the shell, both data files and all 129 card thumbnails
(~1.4 MB) are precached, so a cold offline launch is fully functional. The
larger 420px card art is cached as you browse it.

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
`format.fixedLeader` to `null` in `config.js` to go back to evaluating all
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
| name, types, effect text | English card scans (cardkaizoku, 119/119 revealed) | high |
| **cost, power, counter, colour, category** | **read off card scans by eye, then verified** | **see below** |
| SP reprint stats (`EB04-007`, `ST32-002`, …) | Bandai's own card list | authoritative |
| card art | English scans, 600×838 | — |

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

**Counter values were then verified independently.** They're the weakest field
— printed sideways on the card edge — so every one of the 119 was re-read off
the clean English scans and compared to the table: **119/119 correct, zero
errors**. Dorry (`OP17-085`), which originally had no scan at all and whose
5c/5000/+1000 was inferred purely from the guide's note, came out right.

**Nothing is missing.** Every card resolves: 7 are confirmed to have no rules
text at all (flagged `vanilla: true` so the gap report can tell "this card is
blank" from "we couldn't read it"), and every other card has its text. Stats
live in `data/op17_stats.tsv`, text in `data/op17_text.json` — edit either and
re-run `python3 scripts/build_op17.py`.

### When Bandai publishes OP17

```bash
python3 scripts/scrape_bandai.py OP17 --images
```

That overwrites `data/cards_OP17.json` with official data in the identical
shape. Nothing else changes. The scraper was developed and tested against OP16,
which it parsed cleanly end to end (119 cards + images), so the path works —
that dataset has since been deleted since only OP17 is wanted here.

## The pack model

Bandai does not publish per-pack odds. The defaults in `config.js` reproduce
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
**14+ cards with a 2000 counter**, **≥5 blockers**, at most 12 counterless
cards, at most 5 uncastable counter-fodder cards, per-cost curve **ceilings**,
≤9 events/stages, ≥27 characters.

### What counts as a 2000 counter

A printed 2000 on the card, plus one narrow case: a **0-cost Counter event with
no extra cost**. `[Counter] ... gains +2000 power` on a free event is a drop-in
substitute for a printed counter. Everything else is excluded, deliberately:

- a **1-cost** counter event still costs a turn's DON!!
- a **pitch** counter (`[Counter] You may trash 1 card: ...`) costs *two* cards,
  the event plus the pitch — it is not a 2000 counter

In OP17 that means exactly two cards qualify beyond the printed ones:
`OP17-055` and `OP17-056`, both 0-cost Rocks Pirates events at +2000. The
solver reads the value out of the card text (`free_counter_value`), so nothing
is hand-maintained. 24 cards in the set clear the bar; a 6-pack pool opens
~17.6 copies.

### A floor, not a band

The target is a **soft floor at 14 with no ceiling**. Soft matters: each
missing counter costs `counterFloorWeight`, so the solver stops short when the
last counters would cost real cards.

Sweeping that weight over 120 pools:

| floor weight | mean 2k | reaches 14 | rating/card | blockers |
|---|---|---|---|---|
| 0.9 | 11.65 | 28% | 3.952 | 6.3 |
| 1.5 | 13.01 | 58% | 3.925 | 6.2 |
| **2.5** | **13.55** | **83%** | **3.910** | 6.0 |
| 4.0 | 13.59 | 83% | 3.908 | 6.0 |

2.5 and 4.0 are identical, which is the evidence that 2.5 isn't force-marching:
the pools that fall short do so because they contain no more counters, not
because the push is too weak. Total cost of the whole climb: 0.042 rating/card.

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

### A 2000 counter on a real body is worth more

Two cards can both "be a 2000 counter" and be worth very different things:

| | | |
|---|---|---|
| **Kingdew** 7c/8000/+2000 | **dual-purpose** | cast it on 7, or pitch it for 2000 |
| **Crone Oli** 1c/**0 power**/+2000 | **single-purpose** | never a play, only ever a counter |

`dualPurposeBonus` (0.5) pays a 2000-counter card whose body is worth casting at
its cost. It's the difference between counting counters and counting *useful*
counters.

It changes less than you'd expect, because **supply binds before preference
does**. OP17 prints 6 high-cost 2k counters and 12 low-cost ones; a pool opens
~5.5 and ~7.4 of them, and the solver already takes ~4.4 of the 5.5. The
resulting 5.6-low / 4.4-high split is what the set offers, not what the model
prefers.

The same insight drives the curve exemption: a dual-purpose card is never a dead
draw, which is exactly what the top-end cap exists to limit, so it shouldn't pay
that cap. A 7c/9000 with no counter has one mode and does. Counting it against the top-end cap made the solver refuse the exact cards
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
| reaching the counter target | 91% | **96%** |
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
  behaves. Current numbers over 100 OP17 pools: **82%** reach 14+ 2k counters
  (mean **13.5**), **95%** reach 5+ blockers, **63%** meet every structural
  target, mean avg cost 3.77. The ones that miss are genuine pool problems, not
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
config.js              every tunable number: format, pack odds, weights
solver.js                  scoring + annealing
packs.js                   pack simulation
app.js                     UI
sw.js                      offline precache (shell + thumbnails)
manifest.webmanifest       PWA metadata
_headers                   Cloudflare Pages cache rules
```

## What it can't do

The guide's ratings are context-free but sealed is contextual — removal is
better in a low-power pool, a vanilla 4-drop is better when your curve has a
hole. Treat the output as a ranked starting point and use the Cuts tab's margins
to argue with it.
