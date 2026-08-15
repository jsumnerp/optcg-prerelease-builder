#!/usr/bin/env python3
"""Scrape a One Piece Card Game set from Bandai's official EN card list.

Usage:
    python3 scripts/scrape_bandai.py OP16            # data only
    python3 scripts/scrape_bandai.py OP16 --images   # data + card images

Bandai publishes each set as a single HTML page keyed by an internal `series`
id (booster N -> 569100 + N).  Everything we need -- cost, power, counter,
colour, type, effect -- lives in that one page, so a set is one request.

OP17 is not on the official site yet (checked: /cardlist/?series=569117 is empty
and /images/cardlist/card/OP17-001.png 404s).  The moment Bandai publishes it,
`python3 scripts/scrape_bandai.py OP17 --images` produces the same JSON shape
and the web app picks it up with no other changes.
"""

import argparse
import html
import json
import os
import re
import sys
import time
import urllib.request

BASE = "https://en.onepiece-cardgame.com"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def series_id(set_code):
    """OP16 -> 569116, ST32 -> 569032, EB04 -> 569204."""
    m = re.fullmatch(r"(OP|ST|EB|PRB)(\d+)", set_code.upper())
    if not m:
        raise SystemExit(f"unrecognised set code: {set_code}")
    prefix, num = m.group(1), int(m.group(2))
    return {"OP": 569100, "ST": 569000, "EB": 569200, "PRB": 569300}[prefix] + num


def fetch(url, binary=False):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=45) as r:
        raw = r.read()
    return raw if binary else raw.decode("utf-8", "replace")


def strip_tags(s):
    s = re.sub(r"<br\s*/?>", " ", s)
    s = re.sub(r"<[^>]+>", "", s)
    return html.unescape(s).replace("　", " ").strip()


def field(block, cls):
    """Pull `<div class="cls"><h3>Label</h3>VALUE</div>`."""
    m = re.search(
        r'<div class="%s">(.*?)</div>' % cls, block, re.S
    )
    if not m:
        return ""
    inner = re.sub(r"<h3>.*?</h3>", "", m.group(1), flags=re.S)
    return strip_tags(inner)


def parse_int(s):
    s = (s or "").replace(",", "").strip()
    m = re.search(r"-?\d+", s)
    return int(m.group()) if m else None


# Effect-text signals the solver leans on.  Kept here so the JSON the web app
# eats is already tagged and the browser never has to parse card text.
TAG_PATTERNS = [
    ("blocker", r"\[Blocker\]"),
    ("rush", r"\[Rush\]"),
    ("double_attack", r"\[Double Attack\]"),
    ("banish", r"\[Banish\]"),
    ("trigger", r"\[Trigger\]"),
    ("on_play", r"\[On Play\]"),
    ("when_attacking", r"\[When Attacking\]"),
    ("on_ko", r"\[On K\.O\.\]"),
    ("activate_main", r"\[Activate: Main\]"),
    ("counter_event", r"\[Counter\]"),
    ("removal", r"K\.O\.\s|return.{0,40}to the (owner's )?(hand|bottom|top)"),
    ("power_down", r"-\d{1,2},?000 power|gains? -"),
    ("draw", r"[Dd]raw \d+ card"),
    ("search", r"look at (up to )?\d+ cards from the top"),
    ("ramp", r"[Ss]et .{0,30}DON!! card"),
    ("life_gain", r"add .{0,20}to (the )?top of (your|the) [Ll]ife"),
]

# Riders that only pay off with the right supporting cards -- the raw material
# for conditional bricks.  Bandai writes type requirements as quoted strings
# (`a type including "Whitebeard Pirates"`) and character requirements as
# bracketed names (`your [Ace] Character`).
QUOTED_RE = re.compile(r"[\"“]([^\"”]{3,40})[\"”]|\{([^}]{3,40})\}")
BRACKET_RE = re.compile(r"\[([^\]]{2,40})\]")

# Bracketed tokens that are keywords/timings rather than character names.
KEYWORDS = {
    "activate: main", "main", "counter", "trigger", "blocker", "rush", "banish",
    "double attack", "on play", "on k.o.", "when attacking", "when blocking",
    "on block", "once per turn", "once per deck", "your turn", "opponent's turn",
    "end of your turn", "end of your opponent's turn", "start of your turn",
    "on your opponent's attack", "on opponent's attack", "when attacked",
    "on your attack", "during your turn", "if you don't have a leader",
    "unblockable", "on opponent's k.o.", "on your opponent's k.o.",
}
_DON_RE = re.compile(r"^don!!\s*[x×]?\s*-?\d+$", re.I)
# Sources punctuate keywords inconsistently ("Rush: Character", "Activate:Main"),
# so compare on a squashed form.
_KEYWORDS_NORM = {re.sub(r"[\s:.'’-]", "", k) for k in KEYWORDS} | {
    "rushcharacter", "banishcharacter", "doubleattackcharacter", "counterevent",
}


def _is_keyword(token):
    return re.sub(r"[\s:.'’-]", "", token.lower()) in _KEYWORDS_NORM


# Riders keyed to *your Leader* specifically -- "If your Leader is [Shanks]",
# "your Leader has the {Rocks Pirates} type", "Your [Edward.Newgate] Leader's".
# These are a different beast from deck-density riders: with a neutral sealed
# Leader they can never turn on at all.
_LEADER_RE = re.compile(r"[^.;]{0,90}\bLeader\b[^.;]{0,90}", re.I)


def derive_leader_reqs(text):
    reqs = set()
    for window in _LEADER_RE.findall(text):
        for a, b in QUOTED_RE.findall(window):
            reqs.add((a or b).strip())
        for tok in BRACKET_RE.findall(window):
            t = tok.strip()
            if not _is_keyword(t) and not _DON_RE.match(t):
                reqs.add(t)
    return sorted(reqs)


# A Counter event's printed counter value is 0, but the power it hands out is
# exactly what a counter card's number means: "[Counter] ... gains +2000 power
# during this battle" is a 2000 counter that happens to be an Event. Without
# this, OP17's thirteen Counter events all score as counterless.
# A [Trigger] ends the Counter clause -- unless it sits immediately after it,
# as on Fulgora ("[Counter] [Trigger] ... gains +4000 power"), where consuming
# it is the difference between reading 4000 and reading nothing.
_COUNTER_CLAUSE = re.compile(
    r"\[Counter\]\s*(?:\[Trigger\]\s*)?(.*?)(?=\[Main\]|\[Trigger\]|$)", re.S | re.I)
_PLUS_POWER = re.compile(r"\+\s*([\d,]+)\s*power", re.I)


# A Counter clause that makes you pay for it -- trash a card, rest DON!! -- is
# not a plain counter. Only a free one substitutes for a printed 2000.
_COUNTER_COST = re.compile(r"\btrash\b|\bdiscard\b|\brest\b.{0,30}\bDON!!|You may rest", re.I)


def counter_event_value(effect, trigger):
    """Power granted by a card's [Counter] clause, or 0 if it has none."""
    best = 0
    for text in (effect or "", trigger or ""):
        for clause in _COUNTER_CLAUSE.findall(text):
            for m in _PLUS_POWER.finditer(clause):
                best = max(best, int(m.group(1).replace(",", "")))
    return best


def free_counter_value(cost, effect, trigger):
    """Counter power that behaves like a printed counter: costs 0 to play and
    demands nothing extra to use. A 1-cost counter event still costs you a turn's
    DON!!, and a `[Counter] You may trash 1 card:` clause costs a card -- neither
    is the thing you reach for when you just need +2000 in a battle."""
    if cost != 0:
        return 0
    for text in (effect or "", trigger or ""):
        for clause in _COUNTER_CLAUSE.findall(text):
            if _PLUS_POWER.search(clause) and _COUNTER_COST.search(clause):
                return 0
    return counter_event_value(effect, trigger)


# The Leader condition, so it can be cut out before deck requirements are read.
# "If your Leader is [X] or has the {Y} type," ends at the comma; "your [X]
# Leader" is the possessive form. Cutting exactly these is what separates
# "my Leader must be X" from "my deck must contain X".
#
# It matters that the cut is precise. Izo reads "If your Leader is [Edward
# Newgate] or has the {Land of Wano} type, give up to 1 of your opponent's
# rested Characters -6000 power" -- Land of Wano is purely a Leader condition,
# so a wildcard Leader answers it and the deck needs no Land of Wano at all.
# Kouzuki Oden opens with the same clause but then says "play up to 1 Character
# card with a type including {Land of Wano}", which IS a real deck requirement.
# Strip the clause and the two cards separate correctly; strip the whole card's
# types and Oden wrongly looks free.
# Longest alternative first: the "Leader ... or ... Characters" form must win
# over the bare "of your Leader with a type including X", or only half the
# clause gets cut and the other half survives as a phantom deck requirement.
_LEADER_CLAUSE = re.compile(
    # "up to 1 of your Leader with a type including "X" or up to 1 of your
    # Characters with a type including "X"" -- the Leader is an alternative
    # target for the same effect, so a wildcard Leader makes it always live.
    # (Distinct from Oden, whose second clause targets a different card.)
    r"of\s+your\s+Leader\s+.{0,90}?or\s+up\s+to\s+\d+\s+of\s+your\s+Characters"
    r"\s+with\s+a\s+type\s+including\s+[\"“][^\"”]*[\"”]"
    r"|(?:If\s+)?your\s+Leader\s+(?:is|has)[^,.;:]*"
    r"|[Yy]our\s+\[[^\]]{1,40}\]\s+Leader(?:'s)?"
    r"|of\s+your\s+Leader\s+with\s+a\s+type\s+including\s+[\"“][^\"”]*[\"”]",
    re.I)

# A requirement is only a *deck* requirement if it needs a card from somewhere
# the Leader can't be: your hand, deck or trash. "Up to 1 of your [Rocks.D.Xebec]
# gains [Unblockable]" targets something on your field -- and a wildcard Leader
# is treated as having every name, so it can be that target. "Play up to 1
# [Brogy] from your hand" cannot: you can't play your Leader.
_NEEDS_ANOTHER_CARD = re.compile(r"\b(hand|deck|trash|Characters)\b", re.I)


def _is_deck_requirement(text, token):
    """True if `token` is used somewhere that needs a real card, not the Leader."""
    for m in re.finditer(re.escape(token), text):
        lo, hi = max(0, m.start() - 70), min(len(text), m.end() + 70)
        if _NEEDS_ANOTHER_CARD.search(text[lo:hi]):
            return True
    return False


def derive_tags(effect, trigger, types, name):
    text = f"{effect} {trigger}"
    tags = [n for n, pat in TAG_PATTERNS if re.search(pat, text)]

    # Requirements the *deck* must satisfy are read from the text with Leader
    # conditions removed -- those are the Leader's job, not the deck's.
    deck_text = _LEADER_CLAUSE.sub(" ", text)

    # Bandai quotes type names; the OP17 preview source braces them.
    req_types = {(a or b).strip() for a, b in QUOTED_RE.findall(deck_text)}
    req_names = set()
    for tok in BRACKET_RE.findall(deck_text):
        t = tok.strip()
        if _is_keyword(t) or _DON_RE.match(t):
            continue
        req_names.add(t)

    # Type riders stay even when the card carries that type itself: "reveal a
    # card with a type including {X}" still needs X-density in the deck, and the
    # solver already excludes a card's own copies when counting enablers.
    req_names.discard(name)

    # Keep only the requirements that genuinely need another card.
    req_types = {t for t in req_types if _is_deck_requirement(deck_text, t)}
    req_names = {n for n in req_names if _is_deck_requirement(deck_text, n)}

    return tags, sorted(req_types), sorted(req_names), derive_leader_reqs(text)


def classify_requirements(cards):
    """Bracketed tokens are ambiguous: `[Yamato]` is a character but
    `[Prisoner of Impel Down]` is a type.  Only the whole set can tell them
    apart, so split them once every card is parsed."""
    vocab_types = {t for c in cards for t in c["types"]}
    vocab_names = {c["name"] for c in cards}

    def is_type(tok):
        if tok in vocab_types:
            return True
        if tok in vocab_names:
            return False
        # "Prisoner of Impel Down" reads as a type even though no OP16 card
        # carries it verbatim -- fall back to a substring match on the vocab.
        return any(t in tok for t in vocab_types)

    for c in cards:
        moved = [n for n in c["reqNames"] if is_type(n)]
        if moved:
            c["reqNames"] = [n for n in c["reqNames"] if n not in moved]
            c["reqTypes"] = sorted(set(c["reqTypes"]) | set(moved))


def parse_cards(page, set_code):
    cards = []
    blocks = re.findall(
        r'<dl class="modalCol" id="(%s-\d+[^"]*)">(.*?)</dl>' % re.escape(set_code),
        page,
        re.S,
    )
    for card_id, block in blocks:
        info = re.search(r'<div class="infoCol">(.*?)</div>', block, re.S)
        parts = [strip_tags(p) for p in re.findall(r"<span>(.*?)</span>", info.group(1))] if info else []
        rarity = parts[1] if len(parts) > 1 else ""
        category = (parts[2] if len(parts) > 2 else "").upper()

        name_m = re.search(r'<div class="cardName">(.*?)</div>', block, re.S)
        name = strip_tags(name_m.group(1)) if name_m else ""

        attr_m = re.search(r'<div class="attribute">.*?<i>(.*?)</i>', block, re.S)
        attribute = strip_tags(attr_m.group(1)) if attr_m else ""

        # Leaders show "Life"; everything else shows "Cost" -- same div class.
        cost_raw = field(block, "cost")
        colour = field(block, "color")
        types = [t.strip() for t in field(block, "feature").split("/") if t.strip()]
        effect = field(block, "text")
        trigger = field(block, "trigger")

        tags, req_types, req_names, leader_reqs = derive_tags(effect, trigger, types, name)
        is_leader = category == "LEADER"
        base_id = card_id.split("_")[0]

        cards.append(
            {
                "id": card_id,
                "baseId": base_id,
                "parallel": base_id != card_id,
                "name": name,
                "rarity": rarity,
                "category": category,
                "cost": None if is_leader else parse_int(cost_raw),
                "life": parse_int(cost_raw) if is_leader else None,
                "power": parse_int(field(block, "power")),
                "counter": (parse_int(field(block, "counter")) or 0)
                           or free_counter_value(
                               0 if is_leader else parse_int(cost_raw), effect, trigger),
                "counterEventPower": counter_event_value(effect, trigger),
                "colors": [c.strip() for c in colour.split("/") if c.strip()],
                "attribute": attribute,
                "types": types,
                "effect": effect,
                "trigger": trigger,
                "tags": tags,
                "reqTypes": req_types,
                "reqNames": req_names,
                "reqLeader": leader_reqs,
                "image": f"img/{card_id}.png",
            }
        )
    return cards


def download_images(cards, set_code, outdir):
    """Base printings only -- parallels are alt art of a gameplay-identical card."""
    os.makedirs(outdir, exist_ok=True)
    got = skipped = failed = 0
    for c in [c for c in cards if not c["parallel"]]:
        dest = os.path.join(outdir, f"{c['id']}.png")
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            skipped += 1
            continue
        url = f"{BASE}/images/cardlist/card/{c['id']}.png"
        try:
            data = fetch(url, binary=True)
            with open(dest, "wb") as fh:
                fh.write(data)
            got += 1
        except Exception as exc:  # a missing alt-art shouldn't kill the run
            print(f"  ! {c['id']}: {exc}", file=sys.stderr)
            failed += 1
        time.sleep(0.25)  # be polite to Bandai
    print(f"images: {got} downloaded, {skipped} already present, {failed} failed")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("set_code")
    ap.add_argument("--images", action="store_true")
    args = ap.parse_args()

    code = args.set_code.upper()
    url = f"{BASE}/cardlist/?series={series_id(code)}"
    print(f"fetching {url}")
    page = fetch(url)
    cards = parse_cards(page, code)
    classify_requirements(cards)

    if not cards:
        raise SystemExit(
            f"no {code} cards on Bandai's site yet -- the set is unpublished.\n"
            f"Re-run this once it goes live; nothing else needs to change."
        )

    out = os.path.join(HERE, "data", f"cards_{code}.json")
    with open(out, "w") as fh:
        json.dump({"set": code, "cards": cards}, fh, indent=1)

    base = [c for c in cards if not c["parallel"]]
    by_rarity = {}
    for c in base:
        by_rarity[c["rarity"]] = by_rarity.get(c["rarity"], 0) + 1
    print(f"parsed {len(base)} base cards (+{len(cards) - len(base)} parallels) -> {out}")
    print("  by rarity:", dict(sorted(by_rarity.items())))

    if args.images:
        download_images(cards, code, os.path.join(HERE, "web", "img"))


if __name__ == "__main__":
    main()
