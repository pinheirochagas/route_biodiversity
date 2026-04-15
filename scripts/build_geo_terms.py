#!/usr/bin/env python3
"""Parse BGS RockName.nt and RRUFF CSV into a single geo_terms.json lookup file.

Usage:
    python scripts/build_geo_terms.py

Reads:
    data/RockName.nt         – BGS Rock Classification Scheme (N-Triples RDF)
    data/RRUFF_Export_*.csv   – RRUFF mineral database export

Writes:
    app/data/geo_terms.json  – {term_lower: {class, source}} for ~9 000 terms
"""

import csv
import json
import re
import sys
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


def main():
    if not BGS_FILE.exists():
        print(f"ERROR: {BGS_FILE} not found")
        sys.exit(1)

    bgs_terms = parse_bgs(BGS_FILE)
    rruff_terms = parse_rruff(ROOT / "data")

    combined = {}
    combined.update(SUPPLEMENTAL)
    combined.update(rruff_terms)
    combined.update(bgs_terms)

    overlap = set(bgs_terms) & set(rruff_terms)
    print(f"\nCombined: {len(combined)} unique terms "
          f"({len(bgs_terms)} BGS + {len(rruff_terms)} RRUFF + "
          f"{len(SUPPLEMENTAL)} supplement, {len(overlap)} BGS/RRUFF overlap)")

    if overlap:
        print(f"  Overlap examples: {list(overlap)[:10]}")

    spot_check(combined)

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(combined, f, ensure_ascii=False, separators=(",", ":"))

    size_kb = OUT_FILE.stat().st_size / 1024
    print(f"\nWrote {OUT_FILE} ({size_kb:.0f} KB, {len(combined)} terms)")


if __name__ == "__main__":
    main()
