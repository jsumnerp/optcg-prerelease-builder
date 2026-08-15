#!/usr/bin/env python3
"""Turn a prerelease rating spreadsheet into ratings_<SET>.json.

Usage:
    python3 scripts/import_ratings.py "~/Downloads/OP17 Prerelease Guide.xlsx" OP17

Expects columns: Card # | Card Name | Rarity | Rating | Explanation.
Rows whose rating is "N/A" (Leaders, in this guide) are kept with rating null so
the solver falls back to its own heuristic for them.

Stdlib only -- xlsx is a zip of XML, and pulling in openpyxl for one sheet isn't
worth the install.
"""

import json
import os
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def col_index(ref):
    """'C12' -> 2 (zero-based column)."""
    letters = re.match(r"[A-Z]+", ref).group()
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def read_rows(path):
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            root = ET.fromstring(z.read("xl/sharedStrings.xml"))
            for si in root.findall(f"{NS}si"):
                shared.append("".join(t.text or "" for t in si.iter(f"{NS}t")))

        sheets = [n for n in z.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)]
        root = ET.fromstring(z.read(sorted(sheets)[0]))

    for row in root.iter(f"{NS}row"):
        cells = {}
        for c in row.findall(f"{NS}c"):
            v = c.find(f"{NS}v")
            if c.get("t") == "s" and v is not None:
                val = shared[int(v.text)]
            elif c.get("t") == "inlineStr":
                val = "".join(t.text or "" for t in c.iter(f"{NS}t"))
            else:
                val = v.text if v is not None else None
            cells[col_index(c.get("r"))] = val
        yield [cells.get(i) for i in range(max(cells) + 1)] if cells else []


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    path = os.path.expanduser(sys.argv[1])
    set_code = sys.argv[2].upper()

    ratings, offset = {}, 0
    for row in read_rows(path):
        if len(row) < 4 or not row[0]:
            continue
        card_id = str(row[0]).strip()
        if not re.fullmatch(r"[A-Z]+\d*-\d+", card_id):  # OP17-002, ST32-002, P-107
            continue  # header row, the trailing "Average:" row, blanks
        raw = (str(row[3]) if row[3] is not None else "").strip()
        try:
            rating = round(float(raw), 2)
        except ValueError:
            rating = None  # "N/A" -- Leaders in this guide
        ratings[card_id] = {
            "name": (row[1] or "").strip(),
            "rarity": (row[2] or "").strip(),
            "rating": rating,
            "note": (row[4] or "").strip() if len(row) > 4 and row[4] else "",
        }
        if not card_id.startswith(set_code):
            offset += 1

    out = os.path.join(HERE, "data", f"ratings_{set_code}.json")
    with open(out, "w") as fh:
        json.dump({"set": set_code, "ratings": ratings}, fh, indent=1)

    scored = [v["rating"] for v in ratings.values() if v["rating"] is not None]
    print(f"{len(ratings)} rated cards -> {out}")
    print(f"  {len(scored)} numeric, {len(ratings) - len(scored)} N/A, "
          f"{offset} from other sets (SP reprints)")
    print(f"  mean {sum(scored) / len(scored):.2f}")


if __name__ == "__main__":
    main()
