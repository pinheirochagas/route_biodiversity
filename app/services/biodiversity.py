import asyncio
import math
import httpx
import gpxpy
from datetime import date

INATURALIST_COUNTS_URL = "https://api.inaturalist.org/v1/observations/species_counts"
INATURALIST_OBS_URL = "https://api.inaturalist.org/v1/observations"
NATIVE_LAND_URL = "https://native-land.ca/api/index.php"
BIGDATACLOUD_URL = "https://api.bigdatacloud.net/data/reverse-geocode-client"

COUNTRY_NAME_MAPPING = {
    "United States of America (the)": "United States",
}

TAXA_LIST = [
    "Mammalia", "Reptilia", "Aves", "Actinopterygii",
    "Amphibia", "Plantae", "Fungi", "Insecta",
    "Arachnida", "Mollusca",
]


def coords_to_bbox(
    coords: list[list[float]], buffer_pct: float = 0.0
) -> tuple[float, float, float, float]:
    """Compute bounding box from coordinates.

    buffer_pct: percentage to shrink (negative) or expand (positive) the bbox.
                e.g. -20 shrinks each side by 20% of the bbox span.
    """
    lats = [c[0] for c in coords]
    lngs = [c[1] for c in coords]
    min_lat, max_lat = min(lats), max(lats)
    min_lng, max_lng = min(lngs), max(lngs)

    if buffer_pct:
        dlat = (max_lat - min_lat) * buffer_pct / 100
        dlng = (max_lng - min_lng) * buffer_pct / 100
        min_lat += dlat
        max_lat -= dlat
        min_lng += dlng
        max_lng -= dlng

    return (min_lat, min_lng, max_lat, max_lng)


def _cross(o, a, b):
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def convex_hull(coords: list[list[float]], buffer_deg: float = 0.002) -> list[list[float]]:
    """Compute convex hull of route coords with a small buffer (~200m at mid-latitudes).

    Returns list of [lat, lng] points forming the hull polygon.
    """
    points = sorted(set((c[0], c[1]) for c in coords))
    if len(points) <= 2:
        return [list(p) for p in points]

    lower = []
    for p in points:
        while len(lower) >= 2 and _cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper = []
    for p in reversed(points):
        while len(upper) >= 2 and _cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    hull = lower[:-1] + upper[:-1]

    if buffer_deg > 0:
        cx = sum(p[0] for p in hull) / len(hull)
        cy = sum(p[1] for p in hull) / len(hull)
        buffered = []
        for p in hull:
            dx, dy = p[0] - cx, p[1] - cy
            dist = math.hypot(dx, dy) or 1e-9
            buffered.append([
                p[0] + (dx / dist) * buffer_deg,
                p[1] + (dy / dist) * buffer_deg,
            ])
        hull = buffered

    return [[p[0], p[1]] for p in hull]


def point_in_hull(lat: float, lng: float, hull: list[list[float]]) -> bool:
    """Ray-casting point-in-polygon test. Hull points are [lat, lng]."""
    n = len(hull)
    if n < 3:
        return True
    inside = False
    j = n - 1
    for i in range(n):
        lat_i, lng_i = hull[i]
        lat_j, lng_j = hull[j]
        if ((lat_i > lat) != (lat_j > lat)) and \
           (lng < (lng_j - lng_i) * (lat - lat_i) / (lat_j - lat_i) + lng_i):
            inside = not inside
        j = i
    return inside


def gpx_to_coords(gpx_bytes: bytes) -> list[list[float]]:
    gpx = gpxpy.parse(gpx_bytes.decode("utf-8"))
    return [
        [pt.latitude, pt.longitude]
        for track in gpx.tracks
        for seg in track.segments
        for pt in seg.points
    ]


def bbox_center(bbox: tuple) -> tuple[float, float]:
    return ((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)


async def identify_country(bbox: tuple) -> str | None:
    lat, lng = bbox_center(bbox)
    async with httpx.AsyncClient() as client:
        resp = await client.get(BIGDATACLOUD_URL, params={
            "latitude": lat, "longitude": lng, "localityLanguage": "en",
        })
        if resp.status_code == 200:
            country = resp.json().get("countryName")
            return COUNTRY_NAME_MAPPING.get(country, country)
    return None


async def fetch_indigenous_territories(bbox: tuple, api_key: str = "") -> list[dict]:
    lat, lng = bbox_center(bbox)
    params = {
        "maps": "territories",
        "position": f"{lat},{lng}",
    }
    if api_key:
        params["key"] = api_key
    async with httpx.AsyncClient() as client:
        resp = await client.get(NATIVE_LAND_URL, params=params)
        if resp.status_code != 200:
            return []
        territories = resp.json()
        return [
            {"name": t["properties"]["Name"], "url": t["properties"]["description"]}
            for t in territories
        ]


async def fetch_species(
    bbox: tuple,
    month: int = 0,
    taxa: str = "any",
    per_page: int = 10,
) -> list[dict]:
    params = {
        "d1": "2000-01-01",
        "d2": date.today().isoformat(),
        "geo": "true",
        "place_id": "any",
        "verifiable": "true",
        "iconic_taxa": taxa,
        "swlat": bbox[0],
        "swlng": bbox[1],
        "nelat": bbox[2],
        "nelng": bbox[3],
        "order": "desc",
        "order_by": "observations",
        "per_page": per_page,
    }
    if month and month != 0:
        params["month"] = month

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(INATURALIST_COUNTS_URL, params=params)
        if resp.status_code != 200:
            return []
        results = resp.json().get("results", [])

    species = []
    for r in results:
        taxon = r.get("taxon", {})
        photo = taxon.get("default_photo", {})
        cs = taxon.get("conservation_status") or {}
        species.append({
            "id": taxon.get("id"),
            "name": taxon.get("name", ""),
            "common_name": taxon.get("preferred_common_name", ""),
            "photo_url": photo.get("medium_url", photo.get("square_url", "")),
            "observations": r.get("count", 0),
            "url": f"https://www.inaturalist.org/taxa/{taxon.get('id', '')}",
            "wikipedia_summary": taxon.get("wikipedia_summary", ""),
            "conservation_status": cs.get("status_name", ""),
            "conservation_code": cs.get("status", ""),
        })
    return species


async def _species_from_observations(
    bbox: tuple, month: int, taxa: str, hull: list[list[float]],
) -> list[dict]:
    """Build a species list from observations filtered by hull."""
    params = {
        "geo": "true",
        "verifiable": "true",
        "iconic_taxa": taxa,
        "swlat": bbox[0], "swlng": bbox[1],
        "nelat": bbox[2], "nelng": bbox[3],
        "order": "desc", "order_by": "observed_on",
        "per_page": 200,
    }
    if month and month != 0:
        params["month"] = month
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(INATURALIST_OBS_URL, params=params)
        if resp.status_code != 200:
            return []
        results = resp.json().get("results", [])

    species_map: dict[int, dict] = {}
    for obs in results:
        geojson = obs.get("geojson") or {}
        coords = geojson.get("coordinates", [])
        if len(coords) < 2:
            continue
        if not point_in_hull(coords[1], coords[0], hull):
            continue
        taxon = obs.get("taxon") or {}
        tid = taxon.get("id")
        if not tid or tid in species_map:
            if tid and tid in species_map:
                species_map[tid]["observations"] += 1
            continue
        photo = taxon.get("default_photo") or {}
        cs = taxon.get("conservation_status") or {}
        species_map[tid] = {
            "id": tid,
            "name": taxon.get("name", ""),
            "common_name": taxon.get("preferred_common_name", ""),
            "photo_url": photo.get("medium_url", photo.get("square_url", "")),
            "observations": 1,
            "url": f"https://www.inaturalist.org/taxa/{tid}",
            "wikipedia_summary": taxon.get("wikipedia_summary", ""),
            "conservation_status": cs.get("status_name", ""),
            "conservation_code": cs.get("status", ""),
        }

    return sorted(species_map.values(), key=lambda s: s["observations"], reverse=True)


async def fetch_all_taxa_species(
    bbox: tuple, month: int = 0, per_page: int = 50,
    hull: list[list[float]] | None = None,
) -> dict[str, list[dict]]:
    use_hull = hull and len(hull) >= 3

    async def _fetch_one(taxa: str) -> tuple[str, list[dict]]:
        if use_hull:
            return taxa, await _species_from_observations(bbox, month, taxa, hull)
        return taxa, await fetch_species(bbox, month, taxa=taxa, per_page=per_page)

    results = await asyncio.gather(*(_fetch_one(t) for t in TAXA_LIST))
    return {taxa: species for taxa, species in results}


async def fetch_observations(
    bbox: tuple,
    month: int = 0,
    taxa: str = "any",
    taxon_id: int | None = None,
    per_page: int = 10,
    hull: list[list[float]] | None = None,
) -> list[dict]:
    """Fetch individual observations from iNaturalist, optionally filtered by hull."""
    params = {
        "geo": "true",
        "verifiable": "true",
        "swlat": bbox[0],
        "swlng": bbox[1],
        "nelat": bbox[2],
        "nelng": bbox[3],
        "order": "desc",
        "order_by": "observed_on",
        "per_page": per_page,
    }
    if taxon_id:
        params["taxon_id"] = taxon_id
    else:
        params["iconic_taxa"] = taxa
    if month and month != 0:
        params["month"] = month

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(INATURALIST_OBS_URL, params=params)
        if resp.status_code != 200:
            return []
        results = resp.json().get("results", [])

    observations = []
    for obs in results:
        taxon = obs.get("taxon") or {}
        photos = obs.get("photos") or []
        geojson = obs.get("geojson") or {}
        coords = geojson.get("coordinates", [])
        if len(coords) < 2:
            continue

        lat, lng = coords[1], coords[0]
        if hull and not point_in_hull(lat, lng, hull):
            continue

        photo_url = ""
        if photos:
            photo_url = (photos[0].get("url") or "").replace("square", "small")

        user = obs.get("user") or {}
        observations.append({
            "id": obs.get("id"),
            "lat": lat,
            "lng": lng,
            "species_name": taxon.get("name", obs.get("species_guess", "")),
            "common_name": taxon.get("preferred_common_name", ""),
            "taxon_id": taxon.get("id"),
            "taxa": taxa,
            "photo_url": photo_url,
            "date": obs.get("observed_on", ""),
            "observer": user.get("login", ""),
            "obs_url": f"https://www.inaturalist.org/observations/{obs.get('id', '')}",
        })
    return observations


async def fetch_all_observations(
    bbox: tuple, month: int = 0, hull: list[list[float]] | None = None,
) -> list[dict]:
    all_obs = []
    for taxa in TAXA_LIST:
        obs = await fetch_observations(bbox, month, taxa=taxa, per_page=10, hull=hull)
        all_obs.extend(obs)
    return all_obs
