#!/usr/bin/env python3
from __future__ import annotations
"""Parse BGS RockName.nt, RRUFF CSV, and Mindat rocks into a single geo_terms.json lookup file.

Usage:
    python scripts/build_geo_terms.py

    Set MINDAT_API_KEY env var to include Mindat rock names (entrytype=7).
    Without it, Mindat rocks are skipped.

Reads:
    data/RockName.nt         – BGS Rock Classification Scheme (N-Triples RDF)
    data/RRUFF_Export_*.csv   – RRUFF mineral database export
    Mindat API               – Rock names (entrytype=7), optional

Writes:
    app/data/geo_terms.json  – {term_lower: {class, source}} for ~11 000 terms
"""

import csv
import json
import os
import re
import sys
import time
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BGS_FILE = ROOT / "data" / "RockName.nt"
RRUFF_GLOB = "RRUFF_Export_*.csv"
OUT_FILE = ROOT / "app" / "data" / "geo_terms.json"

IGNEOUS_ANCESTORS = {"PT_IR", "PCT_VIS"}
SEDIMENTARY_ANCESTORS = {"PS_SSR"}
METAMORPHIC_ANCESTORS = {"PH_MET"}

SKIP_PATTERNS = re.compile(
    r"\[Obsolete|"
    r"\[UDCS",
    re.IGNORECASE,
)

CLEAN_SUFFIX = re.compile(r"\s*\[.*?\]\s*$")

NT_TRIPLE = re.compile(
    r"<http://data\.bgs\.ac\.uk/id/EarthMaterialClass/RockName/([^>]+)>\s+"
    r"<([^>]+)>\s+"
    r"(?:<http://data\.bgs\.ac\.uk/id/EarthMaterialClass/RockName/([^>]+)>|\"([^\"]+)\")"
)

PRED_PREFLABEL = "http://www.w3.org/2004/02/skos/core#prefLabel"
PRED_BROADER = "http://www.w3.org/2004/02/skos/core#broader"


def parse_bgs(path: Path) -> dict[str, dict]:
    """Parse BGS RockName.nt and return {term_lower: {class, source}}."""
    names: dict[str, str] = {}
    broader: dict[str, list[str]] = defaultdict(list)

    with open(path, encoding="utf-8") as f:
        for line in f:
            m = NT_TRIPLE.search(line)
            if not m:
                continue
            subj_code = m.group(1)
            predicate = m.group(2)
            obj_code = m.group(3)
            obj_literal = m.group(4)

            if predicate == PRED_PREFLABEL and obj_literal:
                names[subj_code] = obj_literal
            elif predicate == PRED_BROADER and obj_code:
                broader[subj_code].append(obj_code)

    def classify(code: str, visited: set | None = None) -> str:
        if visited is None:
            visited = set()
        if code in visited:
            return ""
        visited.add(code)
        if code in IGNEOUS_ANCESTORS:
            return "igneous"
        if code in SEDIMENTARY_ANCESTORS:
            return "sedimentary"
        if code in METAMORPHIC_ANCESTORS:
            return "metamorphic"
        for parent in broader.get(code, []):
            result = classify(parent, visited)
            if result:
                return result
        return ""

    results: dict[str, dict] = {}
    skipped_obsolete = 0
    skipped_short = 0

    for code, raw_name in names.items():
        if SKIP_PATTERNS.search(raw_name):
            skipped_obsolete += 1
            continue

        name = CLEAN_SUFFIX.sub("", raw_name).strip()
        if len(name) < 2:
            skipped_short += 1
            continue

        rock_class = classify(code)
        key = name.lower()
        if key not in results:
            results[key] = {"class": rock_class, "source": "bgs"}

    print(f"BGS: {len(names)} raw entries, {skipped_obsolete} obsolete/UDCS skipped, "
          f"{skipped_short} too short, {len(results)} kept")

    class_counts = defaultdict(int)
    for v in results.values():
        class_counts[v["class"] or "unclassified"] += 1
    for cls, cnt in sorted(class_counts.items()):
        print(f"  {cls}: {cnt}")

    return results


SUPPLEMENTAL: dict[str, dict] = {
    "shale": {"class": "sedimentary", "source": "supplement"},
    "marl": {"class": "sedimentary", "source": "supplement"},
    "loess": {"class": "sedimentary", "source": "supplement"},
    "laterite": {"class": "sedimentary", "source": "supplement"},
    "till": {"class": "sedimentary", "source": "supplement"},
    "travertine": {"class": "sedimentary", "source": "supplement"},
    "pumice": {"class": "igneous", "source": "supplement"},
    "scoria": {"class": "igneous", "source": "supplement"},
    "emerald": {"class": "mineral", "source": "supplement"},
    "ruby": {"class": "mineral", "source": "supplement"},
    "sapphire": {"class": "mineral", "source": "supplement"},
    "amethyst": {"class": "mineral", "source": "supplement"},
    "jade": {"class": "mineral", "source": "supplement"},
    "opal": {"class": "mineral", "source": "supplement"},
    "lapis lazuli": {"class": "mineral", "source": "supplement"},
}


def parse_rruff(data_dir: Path) -> dict[str, dict]:
    """Parse RRUFF CSV and return {term_lower: {class, source}}.

    Extracts both individual mineral species AND mineral group names
    from the Structural Groupname / Fleischers Groupname columns.
    """
    csv_files = list(data_dir.glob(RRUFF_GLOB))
    if not csv_files:
        print("RRUFF: no CSV files found matching RRUFF_Export_*.csv")
        return {}

    csv_path = csv_files[0]
    results: dict[str, dict] = {}
    groups: set[str] = set()
    total = 0
    skipped = 0

    with open(csv_path, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = (row.get("Mineral Name") or "").strip()
            if not name or len(name) < 2:
                skipped += 1
                continue
            total += 1
            key = name.lower()
            if key not in results:
                results[key] = {"class": "mineral", "source": "rruff"}

            for col in ("Structural Groupname", "Fleischers Groupname"):
                grp = (row.get(col) or "").strip()
                if grp and grp.lower() not in ("not in a structural group", ""):
                    for part in re.split(r"[,;/]", grp):
                        part = part.strip().split("-")[0].strip()
                        if len(part) >= 3:
                            groups.add(part)

    for g in groups:
        key = g.lower()
        if key not in results:
            results[key] = {"class": "mineral", "source": "rruff-group"}

    print(f"RRUFF: {total} species + {len(groups)} group names = "
          f"{len(results)} unique minerals, {skipped} skipped")
    return results


def spot_check(terms: dict[str, dict]) -> None:
    """Print spot-check for known rocks/minerals."""
    checks = [
        ("granite", "igneous"),
        ("basalt", "igneous"),
        ("rhyolite", "igneous"),
        ("limestone", "sedimentary"),
        ("sandstone", "sedimentary"),
        ("shale", "sedimentary"),
        ("gneiss", "metamorphic"),
        ("schist", "metamorphic"),
        ("marble", "metamorphic"),
        ("quartzite", "metamorphic"),
        ("slate", "metamorphic"),
        ("quartz", "mineral"),
        ("feldspar", "mineral"),
        ("mica", "mineral"),
        ("olivine", "mineral"),
        ("calcite", "mineral"),
        ("garnet", "mineral"),
        ("tourmaline", "mineral"),
        ("topaz", "mineral"),
        ("emerald", "mineral"),
    ]

    print("\n--- Spot Check ---")
    all_pass = True
    for term, expected in checks:
        entry = terms.get(term)
        if entry is None:
            print(f"  MISS  {term:20s}  expected={expected}  NOT FOUND")
            all_pass = False
        elif entry["class"] != expected:
            print(f"  FAIL  {term:20s}  expected={expected}  got={entry['class']}")
            all_pass = False
        else:
            print(f"  OK    {term:20s}  class={entry['class']}  source={entry['source']}")

    if all_pass:
        print("All checks passed!")
    else:
        print("Some checks failed -- review above.")


ROCK_CLASS_KEYWORDS = {
    "granite": "igneous", "basalt": "igneous", "rhyolite": "igneous",
    "andesite": "igneous", "diorite": "igneous", "gabbro": "igneous",
    "syenite": "igneous", "trachyte": "igneous", "dacite": "igneous",
    "phonolite": "igneous", "obsidian": "igneous", "pumice": "igneous",
    "tuff": "igneous", "lava": "igneous", "volcanic": "igneous",
    "plutonic": "igneous", "porphyr": "igneous", "ignimbrite": "igneous",
    "sandstone": "sedimentary", "limestone": "sedimentary",
    "shale": "sedimentary", "mudstone": "sedimentary",
    "conglomerate": "sedimentary", "chalk": "sedimentary",
    "dolomite": "sedimentary", "siltstone": "sedimentary",
    "claystone": "sedimentary", "marl": "sedimentary",
    "chert": "sedimentary", "flint": "sedimentary",
    "gneiss": "metamorphic", "schist": "metamorphic",
    "marble": "metamorphic", "quartzite": "metamorphic",
    "slate": "metamorphic", "phyllite": "metamorphic",
    "hornfels": "metamorphic", "amphibolite": "metamorphic",
    "granulite": "metamorphic", "eclogite": "metamorphic",
    "migmatite": "metamorphic", "mylonite": "metamorphic",
    "serpentinite": "metamorphic", "cataclasite": "metamorphic",
    "skarn": "metamorphic", "greenschist": "metamorphic",
    "blueschist": "metamorphic", "metaconglomerate": "metamorphic",
    "metabasalt": "metamorphic", "metagranite": "metamorphic",
}


def _classify_rock_name(name: str) -> str:
    """Heuristic classification of a rock name by keyword matching."""
    lower = name.lower()
    if lower.startswith("meta"):
        return "metamorphic"
    for keyword, cls in ROCK_CLASS_KEYWORDS.items():
        if keyword in lower:
            return cls
    return ""


def fetch_mindat_rocks(api_key: str) -> dict[str, dict]:
    """Fetch all rock names (entrytype=7) from the Mindat API."""
    results: dict[str, dict] = {}
    page = 1
    total = 0

    while True:
        url = (
            f"https://api.mindat.org/v1/geomaterials/"
            f"?format=json&page_size=100&entrytype=7&fields=id,name&page={page}"
        )
        req = urllib.request.Request(
            url, headers={"Authorization": f"Token {api_key}"}
        )
        try:
            resp = urllib.request.urlopen(req)
            data = json.loads(resp.read())
        except Exception as e:
            print(f"  Mindat API error on page {page}: {e}")
            break

        items = data.get("results", [])
        for item in items:
            name = item.get("name", "").strip()
            if not name or len(name) < 2:
                continue
            key = name.lower()
            if key not in results:
                cls = _classify_rock_name(name)
                results[key] = {"class": cls, "source": "mindat"}
                total += 1

        if not data.get("next"):
            break
        page += 1
        time.sleep(0.1)

    ign = sum(1 for v in results.values() if v["class"] == "igneous")
    sed = sum(1 for v in results.values() if v["class"] == "sedimentary")
    met = sum(1 for v in results.values() if v["class"] == "metamorphic")
    unc = sum(1 for v in results.values() if v["class"] == "")
    print(f"Mindat: {total} rock names fetched in {page} pages")
    print(f"  igneous: {ign}, sedimentary: {sed}, metamorphic: {met}, unclassified: {unc}")
    return results


def main():
    if not BGS_FILE.exists():
        print(f"ERROR: {BGS_FILE} not found")
        sys.exit(1)

    bgs_terms = parse_bgs(BGS_FILE)
    rruff_terms = parse_rruff(ROOT / "data")

    mindat_api_key = os.environ.get("MINDAT_API_KEY", "")
    mindat_terms: dict[str, dict] = {}
    if mindat_api_key:
        mindat_terms = fetch_mindat_rocks(mindat_api_key)
    else:
        print("Mindat: skipped (set MINDAT_API_KEY env var to include)")

    combined = {}
    combined.update(SUPPLEMENTAL)
    if mindat_terms:
        combined.update(mindat_terms)
    combined.update(rruff_terms)
    combined.update(bgs_terms)

    overlap_bgs_rruff = set(bgs_terms) & set(rruff_terms)
    overlap_bgs_mindat = set(bgs_terms) & set(mindat_terms) if mindat_terms else set()
    new_from_mindat = set(mindat_terms) - set(bgs_terms) - set(rruff_terms) if mindat_terms else set()

    print(f"\nCombined: {len(combined)} unique terms "
          f"({len(bgs_terms)} BGS + {len(rruff_terms)} RRUFF + "
          f"{len(mindat_terms)} Mindat + {len(SUPPLEMENTAL)} supplement)")
    print(f"  BGS/RRUFF overlap: {len(overlap_bgs_rruff)}")
    if mindat_terms:
        print(f"  BGS/Mindat overlap: {len(overlap_bgs_mindat)}")
        print(f"  New from Mindat: {len(new_from_mindat)}")

    spot_check(combined)

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(combined, f, ensure_ascii=False, separators=(",", ":"))

    size_kb = OUT_FILE.stat().st_size / 1024
    print(f"\nWrote {OUT_FILE} ({size_kb:.0f} KB, {len(combined)} terms)")


if __name__ == "__main__":
    main()
