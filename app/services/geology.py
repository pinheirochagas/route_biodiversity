from __future__ import annotations

import asyncio
import json
import logging
import math
import re
from pathlib import Path

import httpx

log = logging.getLogger(__name__)

MACROSTRAT_URL = "https://macrostrat.org/api/v2/geologic_units/map"
WIKI_SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary"
WIKI_API_URL = "https://en.wikipedia.org/w/api.php"
MINDAT_API_URL = "https://api.mindat.org/v1"

MINDAT_COUNTRY_MAP = {
    "United States": "USA",
    "United States of America": "USA",
    "United States of America (the)": "USA",
    "United Kingdom": "UK",
    "United Kingdom of Great Britain and Northern Ireland (the)": "UK",
    "Russian Federation (the)": "Russia",
    "Korea, Republic of": "South Korea",
    "Congo, Democratic Republic of the": "DR Congo",
}

WIKI_HEADERS = {
    "User-Agent": "RouteBiodiversity/1.0 (https://bioroute.pedrolab.org; contact@pedrolab.org)",
}

_GEO_TERMS_PATH = Path(__file__).resolve().parent.parent / "data" / "geo_terms.json"

GEO_TERMS: dict[str, dict] = {}
if _GEO_TERMS_PATH.exists():
    with open(_GEO_TERMS_PATH, encoding="utf-8") as _f:
        GEO_TERMS = json.load(_f)

_WORD_SPLIT = re.compile(r"[{},;:|/\s]+")


def _lookup_term(term: str) -> dict | None:
    """Look up a term in GEO_TERMS, trying the full term first, then individual words."""
    key = term.lower().strip()
    if key in GEO_TERMS:
        return GEO_TERMS[key]
    clean = re.sub(r"\s*\(.*?\)\s*$", "", key).strip()
    if clean != key and clean in GEO_TERMS:
        return GEO_TERMS[clean]
    return None


def _extract_lith_info(lith_raw: str, name: str) -> dict:
    """Extract rock types, class, and type from Macrostrat lith and name fields."""
    combined = f"{lith_raw} {name}".lower()
    combined = re.sub(r"major:\{|\}|minor:\{", " ", combined)

    words = _WORD_SPLIT.split(combined)
    all_terms = []
    primary_class = ""
    primary_type = ""
    primary_term = ""
    seen: set[str] = set()

    for w in words:
        w = w.strip()
        if not w or w in ("major", "minor") or w in seen:
            continue
        seen.add(w)
        entry = GEO_TERMS.get(w)
        if entry:
            cls = entry.get("class", "")
            all_terms.append({"term": w.capitalize(), "class": cls, "type": cls})
            if not primary_term:
                primary_term = w.capitalize()
                primary_class = cls
                primary_type = cls

    if not primary_class:
        for fallback in ["sedimentary", "igneous", "metamorphic"]:
            if fallback in combined:
                primary_class = fallback
                break

    if not primary_term and not all_terms:
        parts = re.split(r"[{},;:|]+", lith_raw)
        for p in parts:
            p = p.strip().strip("{}")
            if p and p.lower() not in ("major", "minor", ""):
                primary_term = p.capitalize()
                break

    return {
        "term": primary_term,
        "class": primary_class,
        "type": primary_type,
        "all_terms": all_terms,
    }


def _build_formation(unit: dict, lat: float, lng: float) -> dict:
    lith_raw = unit.get("lith", "")
    name = unit.get("name", "")
    lith_info = _extract_lith_info(lith_raw, name)
    return {
        "map_id": unit.get("map_id"),
        "name": name,
        "lith": lith_raw,
        "lith_term": lith_info["term"],
        "lith_class": lith_info["class"],
        "lith_type": lith_info["type"],
        "all_terms": lith_info["all_terms"],
        "age": unit.get("best_int_name", ""),
        "t_age": unit.get("t_age", 0),
        "b_age": unit.get("b_age", 0),
        "t_int_name": unit.get("t_int_name", ""),
        "b_int_name": unit.get("b_int_name", ""),
        "descrip": unit.get("descrip", ""),
        "color": unit.get("color", "#888888"),
        "lat": lat,
        "lng": lng,
    }


async def _fetch_point(client: httpx.AsyncClient, lat: float, lng: float) -> list[dict]:
    try:
        resp = await client.get(MACROSTRAT_URL, params={
            "lat": round(lat, 5), "lng": round(lng, 5), "format": "json",
        })
        if resp.status_code != 200:
            return []
        data = resp.json().get("success", {}).get("data", [])
        return [_build_formation(unit, lat, lng) for unit in data]
    except Exception:
        return []


async def _fetch_wiki_thumbnail(
    client: httpx.AsyncClient, term: str,
) -> tuple[str, str, str]:
    """Return (term_lower, thumbnail_url, wiki_url) for a rock type."""
    try:
        resp = await client.get(
            f"{WIKI_SUMMARY_URL}/{term.replace(' ', '_')}",
            headers=WIKI_HEADERS,
            follow_redirects=True,
        )
        if resp.status_code != 200:
            return (term.lower(), "", "")
        data = resp.json()
        thumb = data.get("thumbnail", {}).get("source", "")
        wiki_url = data.get("content_urls", {}).get("desktop", {}).get("page", "")
        return (term.lower(), thumb, wiki_url)
    except Exception:
        return (term.lower(), "", "")


async def _enrich_with_photos(formations: list[dict]) -> None:
    """Fetch Wikipedia thumbnails for unique rock terms and attach to formations."""
    terms_set: set[str] = set()
    for f in formations:
        if f.get("lith_term"):
            terms_set.add(f["lith_term"])
        for t in f.get("all_terms", []):
            if t.get("term"):
                terms_set.add(t["term"])
    unique_terms = list(terms_set)
    if not unique_terms:
        return

    sem = asyncio.Semaphore(4)

    async def _limited(client: httpx.AsyncClient, term: str):
        async with sem:
            return await _fetch_wiki_thumbnail(client, term)

    async with httpx.AsyncClient(timeout=10) as client:
        results = await asyncio.gather(
            *[_limited(client, t) for t in unique_terms],
            return_exceptions=True,
        )

    photo_map: dict[str, tuple[str, str]] = {}
    for r in results:
        if isinstance(r, tuple) and r[1]:
            photo_map[r[0]] = (r[1], r[2])

    for f in formations:
        term = (f.get("lith_term") or "").lower()
        if term in photo_map:
            f["photo_url"] = photo_map[term][0]
            f["wiki_url"] = photo_map[term][1]
        else:
            f["photo_url"] = ""
            f["wiki_url"] = ""
        for t in f.get("all_terms", []):
            tk = (t.get("term") or "").lower()
            if tk in photo_map:
                t["photo_url"] = photo_map[tk][0]
                t["wiki_url"] = photo_map[tk][1]
            else:
                t["photo_url"] = ""
                t["wiki_url"] = ""


async def _wiki_get_sections(
    client: httpx.AsyncClient, page: str,
) -> list[dict]:
    """Return section list for a Wikipedia article."""
    try:
        resp = await client.get(WIKI_API_URL, params={
            "action": "parse", "page": page, "prop": "sections",
            "redirects": "", "format": "json",
        }, headers=WIKI_HEADERS, follow_redirects=True)
        if resp.status_code != 200:
            return []
        data = resp.json()
        if "error" in data:
            return []
        return data.get("parse", {}).get("sections", [])
    except Exception:
        return []


async def _wiki_get_wikitext(
    client: httpx.AsyncClient, page: str, section: int | None = None,
) -> str:
    """Return raw wikitext for a Wikipedia article (or a specific section)."""
    params: dict = {
        "action": "parse", "page": page, "prop": "wikitext",
        "redirects": "", "format": "json",
    }
    if section is not None:
        params["section"] = section
    try:
        resp = await client.get(
            WIKI_API_URL, params=params, headers=WIKI_HEADERS,
            follow_redirects=True,
        )
        if resp.status_code != 200:
            return ""
        data = resp.json()
        if "error" in data:
            return ""
        return data.get("parse", {}).get("wikitext", {}).get("*", "")
    except Exception:
        return ""


def _extract_wikilinks(wikitext: str) -> list[str]:
    """Extract unique link targets from wikitext, ignoring files/categories."""
    links = re.findall(r"\[\[([^|\]]+)", wikitext)
    seen: set[str] = set()
    result: list[str] = []
    for link in links:
        link = link.strip()
        if link.startswith(("File:", "Category:", "Image:", "#")):
            continue
        norm = link.replace("_", " ")
        if norm.lower() not in seen:
            seen.add(norm.lower())
            result.append(norm)
    return result


async def _fetch_wiki_geology(
    city: str = "", state: str = "", country: str = "",
) -> list[dict]:
    """Cascade through Wikipedia articles to discover rock/mineral types.

    Tries city -> state -> 'Geology of state' -> 'Geology of country', accumulating
    rock types from wikilinks in geology-related sections. Each wikilink is validated
    against the GEO_TERMS dictionary (built from BGS + RRUFF authoritative data).
    """
    GEO_SECTION_KEYWORDS = {"geolog", "mineral", "mining", "geomorph", "natural resource"}

    candidates: list[str] = []
    if city:
        candidates.append(city.replace(" ", "_"))
    if state:
        candidates.append(state.replace(" ", "_"))
        candidates.append(f"Geology_of_{state.replace(' ', '_')}")
    if country:
        candidates.append(f"Geology_of_{country.replace(' ', '_')}")
        candidates.append(country.replace(" ", "_"))

    all_links: list[str] = []
    seen_terms: set[str] = set()

    async with httpx.AsyncClient(timeout=12) as client:
        for page in candidates:
            sections = await _wiki_get_sections(client, page)
            if not sections:
                continue

            geo_indices: list[int] = []
            for s in sections:
                line = s.get("line", "").lower()
                if any(kw in line for kw in GEO_SECTION_KEYWORDS):
                    geo_indices.append(int(s["index"]))

            if geo_indices:
                for idx in geo_indices:
                    text = await _wiki_get_wikitext(client, page, section=idx)
                    links = _extract_wikilinks(text)
                    for link in links:
                        if link.lower() not in seen_terms:
                            seen_terms.add(link.lower())
                            all_links.append(link)

    known: list[dict] = []
    seen_final: set[str] = set()

    for link in all_links:
        entry = _lookup_term(link)
        if entry:
            display = re.sub(r"\s*\(.*?\)\s*$", "", link).strip()
            key = display.lower()
            if key not in seen_final:
                seen_final.add(key)
                known.append({
                    "term": display.capitalize() if display == display.lower() else display,
                    "class": entry.get("class", ""),
                    "type": entry.get("class", ""),
                    "source": "wikipedia",
                })

    return known


_mindat_name_cache: dict[int, dict] = {}


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlng / 2) ** 2)
    return R * 2 * math.asin(math.sqrt(a))


async def _mindat_search_localities(
    client: httpx.AsyncClient,
    api_key: str,
    country: str,
    search_terms: list[str],
    route_lat: float,
    route_lng: float,
    max_km: float = 150,
) -> dict[int, dict]:
    """Search Mindat localities by text, filtering by distance when coords available."""
    headers = {"Authorization": f"Token {api_key}"}
    all_locs: dict[int, dict] = {}

    for txt in search_terms:
        try:
            resp = await client.get(
                f"{MINDAT_API_URL}/localities/",
                params={
                    "format": "json", "page_size": 50, "country": country,
                    "txt": txt, "fields": "id,txt,latitude,longitude",
                },
                headers=headers,
            )
            if resp.status_code != 200:
                continue
            for r in resp.json().get("results", []):
                if r["id"] in all_locs:
                    continue
                lat = r.get("latitude", 0) or 0
                lng = r.get("longitude", 0) or 0
                has_coords = lat != 0 or lng != 0
                if has_coords:
                    dist = _haversine_km(route_lat, route_lng, lat, lng)
                    if dist <= max_km:
                        all_locs[r["id"]] = r
                else:
                    all_locs[r["id"]] = r
        except Exception:
            log.debug("Mindat locality search failed for txt=%s", txt, exc_info=True)
    return all_locs


async def _mindat_get_mineral_ids(
    client: httpx.AsyncClient,
    api_key: str,
    locality_ids: list[int],
    sem: asyncio.Semaphore,
) -> set[int]:
    """Fetch geomaterial IDs from each locality."""
    headers = {"Authorization": f"Token {api_key}"}
    all_ids: set[int] = set()

    async def _fetch_one(lid: int):
        async with sem:
            try:
                resp = await client.get(
                    f"{MINDAT_API_URL}/localities/{lid}/",
                    params={"format": "json", "expand": "geomaterials"},
                    headers=headers,
                )
                if resp.status_code == 200:
                    gm = resp.json().get("geomaterials", [])
                    all_ids.update(gm)
            except Exception:
                pass

    await asyncio.gather(*[_fetch_one(lid) for lid in locality_ids])
    return all_ids


async def _mindat_resolve_names(
    client: httpx.AsyncClient,
    api_key: str,
    gm_ids: set[int],
    sem: asyncio.Semaphore,
) -> list[dict]:
    """Resolve geomaterial IDs to name + type, using a module-level cache."""
    headers = {"Authorization": f"Token {api_key}"}
    to_fetch = [gid for gid in gm_ids if gid not in _mindat_name_cache]

    async def _fetch_one(gid: int):
        async with sem:
            try:
                resp = await client.get(
                    f"{MINDAT_API_URL}/geomaterials/{gid}/",
                    params={"format": "json", "fields": "id,name,entrytype_text"},
                    headers=headers,
                )
                if resp.status_code == 200:
                    data = resp.json()
                    _mindat_name_cache[gid] = {
                        "name": data.get("name", ""),
                        "entrytype": data.get("entrytype_text", "mineral"),
                    }
            except Exception:
                pass

    await asyncio.gather(*[_fetch_one(gid) for gid in to_fetch])

    results: list[dict] = []
    for gid in gm_ids:
        info = _mindat_name_cache.get(gid)
        if info and info["name"]:
            results.append({
                "term": info["name"],
                "class": "mineral",
                "type": "mineral",
                "source": "mindat",
                "mindat_id": gid,
            })
    return results


async def _fetch_mindat_minerals(
    country: str = "",
    state: str = "",
    county: str = "",
    city: str = "",
    route_lat: float = 0,
    route_lng: float = 0,
    api_key: str = "",
) -> list[dict]:
    """Query Mindat for minerals near a route using county/city text search."""
    if not api_key or not country:
        return []

    country = MINDAT_COUNTRY_MAP.get(country, country)

    search_terms: list[str] = []
    if county and state:
        search_terms.append(f"{county}, {state}")
    elif county:
        search_terms.append(county)
    if city:
        search_terms.append(city)
    if not search_terms:
        return []

    sem = asyncio.Semaphore(5)
    async with httpx.AsyncClient(timeout=15) as client:
        localities = await _mindat_search_localities(
            client, api_key, country, search_terms, route_lat, route_lng,
        )
        if not localities:
            return []

        gm_ids = await _mindat_get_mineral_ids(
            client, api_key, list(localities.keys()), sem,
        )
        if not gm_ids:
            return []

        minerals = await _mindat_resolve_names(client, api_key, gm_ids, sem)

    log.info(
        "Mindat: %d localities, %d mineral IDs, %d resolved for %s/%s/%s",
        len(localities), len(gm_ids), len(minerals), country, state, county,
    )
    return minerals


def _sample_points(coords: list[list[float]], n: int = 30) -> list[tuple[float, float]]:
    """Pick n evenly spaced points along the route coordinates."""
    if len(coords) <= n:
        return [(c[0], c[1]) for c in coords]
    step = max(1, (len(coords) - 1) / (n - 1))
    points = []
    for i in range(n):
        idx = min(int(i * step), len(coords) - 1)
        points.append((coords[idx][0], coords[idx][1]))
    return points


async def fetch_geology_along_route(
    coords: list[list[float]],
    city: str = "",
    state: str = "",
    country: str = "",
    county: str = "",
    mindat_api_key: str = "",
) -> list[dict]:
    """Sample points along a route and return unique geological formations with photos.

    Combines Macrostrat point API data with Wikipedia-sourced rock types and
    Mindat locality minerals for comprehensive geomaterial coverage.
    """
    sample = _sample_points(coords)
    center_lat = sum(c[0] for c in coords) / len(coords)
    center_lng = sum(c[1] for c in coords) / len(coords)
    sem = asyncio.Semaphore(10)

    macrostrat_task = _fetch_macrostrat(sample, sem)
    wiki_task = _fetch_wiki_geology(city, state, country)
    mindat_task = _fetch_mindat_minerals(
        country=country, state=state, county=county, city=city,
        route_lat=center_lat, route_lng=center_lng,
        api_key=mindat_api_key,
    )
    macro_results, wiki_rocks, mindat_minerals = await asyncio.gather(
        macrostrat_task, wiki_task, mindat_task, return_exceptions=True,
    )

    seen_ids: set[int] = set()
    formations: list[dict] = []
    if isinstance(macro_results, list):
        for unit in macro_results:
            mid = unit.get("map_id")
            if mid and mid not in seen_ids:
                seen_ids.add(mid)
                formations.append(unit)

    formations.sort(key=lambda f: f.get("b_age") or 0, reverse=True)

    existing_terms: set[str] = set()
    for f in formations:
        if f.get("lith_term"):
            existing_terms.add(f["lith_term"].lower())
        for t in f.get("all_terms", []):
            if t.get("term"):
                existing_terms.add(t["term"].lower())

    def _append_extra(items: list[dict], source: str) -> None:
        for item in items:
            term_lower = item["term"].lower()
            if term_lower not in existing_terms:
                existing_terms.add(term_lower)
                entry = {
                    "map_id": None,
                    "name": item["term"],
                    "lith": "",
                    "lith_term": item["term"],
                    "lith_class": item["class"],
                    "lith_type": item["type"],
                    "all_terms": [item],
                    "age": "",
                    "t_age": 0,
                    "b_age": 0,
                    "t_int_name": "",
                    "b_int_name": "",
                    "descrip": "",
                    "color": "#888888",
                    "lat": center_lat,
                    "lng": center_lng,
                    "source": source,
                }
                if "mindat_id" in item:
                    entry["mindat_id"] = item["mindat_id"]
                formations.append(entry)

    if isinstance(wiki_rocks, list):
        _append_extra(wiki_rocks, "wikipedia")

    if isinstance(mindat_minerals, list):
        _append_extra(mindat_minerals, "mindat")

    await _enrich_with_photos(formations)
    return formations


async def _fetch_macrostrat(
    sample: list[tuple[float, float]],
    sem: asyncio.Semaphore,
) -> list[dict]:
    """Fetch Macrostrat data for sampled points."""
    async def _limited(client: httpx.AsyncClient, lat: float, lng: float):
        async with sem:
            return await _fetch_point(client, lat, lng)

    async with httpx.AsyncClient(timeout=15) as client:
        results = await asyncio.gather(
            *[_limited(client, lat, lng) for lat, lng in sample],
            return_exceptions=True,
        )

    all_units: list[dict] = []
    for r in results:
        if isinstance(r, list):
            all_units.extend(r)
    return all_units


async def fetch_geology_at_point(lat: float, lng: float) -> list[dict]:
    """Fetch geology for a single point with photo enrichment."""
    async with httpx.AsyncClient(timeout=15) as client:
        formations = await _fetch_point(client, lat, lng)
    if formations:
        await _enrich_with_photos(formations)
    return formations
