#!/usr/bin/env python3
"""Assemble data/cards_OP17.json from three sources.

OP17 is not on Bandai's official card list yet (checked: /cardlist/?series=569117
returns nothing and /images/cardlist/card/OP17-001.png 404s), so the set is
stitched together:

  data/op17_stats.tsv   cost / power / counter / colour / category, read off
                        prerelease card scans
  data/op17_text.json   name / rarity / types / effect text, scraped from a
                        card-preview site
  data/ratings_OP17.json  the prerelease guide's 0-5 rating and commentary

The guide's notes very often say "a vanilla Nc would have..." about the card
being rated. That is an independent statement of the card's cost, so this
script checks every such note against the TSV and reports disagreements --
that is the main defence against a misread scan.

Swap in scrape_bandai.py the day Bandai publishes OP17; the JSON shape is
identical and nothing downstream changes.
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "scripts"))
from scrape_bandai import (  # noqa: E402
    derive_tags, classify_requirements, counter_event_value, free_counter_value)


def load_stats(path):
    rows = {}
    with open(path) as fh:
        for line in fh:
            if line.startswith("#") or not line.strip():
                continue
            parts = [p.strip() for p in line.rstrip("\n").split("\t")]
            cid, category, color, cost, power, counter, life = parts[:7]
            num = lambda v: None if v in ("-", "") else int(v)
            rows[cid] = {
                "category": category,
                "colors": [color],
                "cost": num(cost),
                "power": num(power) or 0,
                "counter": num(counter) or 0,
                "life": num(life),
            }
    return rows


# "A vanilla 4c would have 1k counter" -- the guide stating the card's cost.
VANILLA_RE = re.compile(r"\bvanilla\s+(\d{1,2})\s*(?:c\b|cost|-cost|don)", re.I)


def cross_check(stats, ratings):
    """Compare each card's TSV cost against the cost implied by its note."""
    agreed, mismatched, silent = 0, [], 0
    for cid, entry in ratings.items():
        if cid not in stats:
            continue
        m = VANILLA_RE.search(entry.get("note") or "")
        if not m:
            silent += 1
            continue
        implied = int(m.group(1))
        actual = stats[cid]["cost"]
        if actual == implied:
            agreed += 1
        else:
            mismatched.append((cid, entry["name"], actual, implied))
    return agreed, mismatched, silent


# The preview site files X. Drake's article under OP17-076, but the code printed
# on the card is OP17-075 and the rating sheet agrees. Trust the printed code.
TEXT_ID_FIXES = {"OP17-076": "OP17-075"}


def apply_text_fixes(text):
    for wrong, right in TEXT_ID_FIXES.items():
        if wrong in text and not text.get(right, {}).get("effect"):
            text[right] = text.pop(wrong)
            print(f"  text remapped: {wrong} -> {right} ({text[right]['name']})")
    return text


def main():
    stats = load_stats(os.path.join(HERE, "data", "op17_stats.tsv"))
    ratings = json.load(open(os.path.join(HERE, "data", "ratings_OP17.json")))["ratings"]
    text = apply_text_fixes(json.load(open(os.path.join(HERE, "data", "op17_text.json"))))

    agreed, mismatched, silent = cross_check(stats, ratings)
    print(f"cost cross-check vs guide notes: {agreed} agree, {len(mismatched)} disagree, "
          f"{silent} notes make no cost claim")
    for cid, name, actual, implied in mismatched:
        print(f"  ! {cid} {name}: scan says {actual}c, guide note implies {implied}c")

    cards = []
    for cid in sorted(stats):
        st = stats[cid]
        tx = text.get(cid, {})
        rt = ratings.get(cid, {})
        name = tx.get("name") or rt.get("name") or cid
        types = [t.strip() for t in (tx.get("traits") or "").split("/") if t.strip()]
        effect = tx.get("effect", "")
        trigger = tx.get("trigger", "")

        tags, req_types, req_names, leader_reqs = derive_tags(effect, trigger, types, name)

        # A printed counter always wins. Otherwise only a *free* Counter event
        # counts -- 0 cost, no trash/rest rider -- because only that one is a
        # drop-in substitute for a printed counter.
        counter = st["counter"] or free_counter_value(st["cost"], effect, trigger)
        cards.append({
            "id": cid,
            "baseId": cid,
            "parallel": False,
            "name": name,
            # The rating sheet lists a rarity for every card; the preview site
            # leaves most blank, so the sheet wins.
            "rarity": rt.get("rarity") or tx.get("rarity") or "C",
            "category": st["category"],
            "cost": st["cost"],
            "life": st["life"],
            "power": st["power"],
            "counter": counter,
            # Raw [Counter] power even when it isn't free, for display/tooltips.
            "counterEventPower": counter_event_value(effect, trigger),
            "colors": st["colors"],
            "attribute": tx.get("attribute", ""),
            "types": types,
            "effect": effect,
            "trigger": trigger,
            "tags": tags,
            "reqTypes": req_types,
            "reqNames": req_names,
            "reqLeader": leader_reqs,
            "image": f"img/{cid}.jpg",
        })

    classify_requirements(cards)

    # SP reprints from older sets are pullable in OP17 packs; their stats come
    # straight from Bandai, so they need no scan-reading.
    sp_path = os.path.join(HERE, "data", "sp_reprints.json")
    if os.path.exists(sp_path):
        for c in json.load(open(sp_path))["cards"]:
            c = dict(c)
            c["rarity"] = "SP"
            c["image"] = f"img/{c['id']}.jpg"
            cards.append(c)

    out = os.path.join(HERE, "data", "cards_OP17.json")
    with open(out, "w") as fh:
        json.dump({"set": "OP17", "cards": cards}, fh, indent=1)

    missing_text = [c["id"] for c in cards if not c["effect"] and c["category"] != "LEADER"]
    print(f"wrote {len(cards)} cards -> {out}")
    print(f"  {len([c for c in cards if c['rarity'] == 'SP'])} SP reprints (stats from Bandai)")
    print(f"  {len(missing_text)} cards with no effect text: {missing_text[:8]}")


if __name__ == "__main__":
    main()
