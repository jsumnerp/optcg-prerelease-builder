#!/usr/bin/env python3
"""Pull stats for the SP reprints that appear in OP17 packs.

The rating guide lists 11 SP cards from older sets. Those are already on
Bandai's site, so their stats need no scan-reading -- but they live across
several series pages (and EB04's cards sit inside the OP15 booster page, not a
series of their own). This walks the right pages and writes data/sp_reprints.json,
which build_op17.py appends to the OP17 card list.

    python3 scripts/fetch_sp_reprints.py
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "scripts"))
import scrape_bandai as sb  # noqa: E402

WANTED = [
    "EB04-007", "EB04-061", "OP12-056", "OP13-028", "OP14-108",
    "OP16-098", "P-084", "P-107", "ST27-005", "ST31-004", "ST32-002",
]

# set prefix -> the series page that actually contains it
SERIES = {
    "EB04": 569115,   # EB04 cards ship inside the OP15 booster page
    "OP12": 569112,
    "OP13": 569113,
    "OP14": 569114,
    "OP16": 569116,
    "P":    569901,   # promos
    "ST27": 569027,
    "ST31": 569031,
    "ST32": 569032,
}


def main():
    want = set(WANTED)
    found = {}
    for prefix, series in SERIES.items():
        if not any(w.startswith(prefix + "-") for w in want):
            continue
        page = sb.fetch(f"{sb.BASE}/cardlist/?series={series}")
        cards = sb.parse_cards(page, prefix)
        sb.classify_requirements(cards)
        for c in cards:
            if c["id"] in want:
                found[c["id"]] = c
        print(f"{prefix} (series {series}): {len(cards)} cards, "
              f"{len(found)}/{len(want)} wanted so far")

    missing = sorted(want - set(found))
    out = os.path.join(HERE, "data", "sp_reprints.json")
    with open(out, "w") as fh:
        json.dump({"cards": [found[k] for k in sorted(found)]}, fh, indent=1)
    print(f"wrote {len(found)} SP reprints -> {out}")
    if missing:
        print(f"  not on Bandai's site: {missing}")


if __name__ == "__main__":
    main()
