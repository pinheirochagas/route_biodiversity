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
    "Mammalia", "Reptilia", "Aves", "Plantae",
    "Amphibia", "Fungi", "Insecta", "Arachnida",
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


async def fetch_indigenous_territories(bbox: tuple) -> list[dict]:
    lat, lng = bbox_center(bbox)
    async with httpx.AsyncClient() as client:
        resp = await client.get(NATIVE_LAND_URL, params={
            "maps": "territories",
            "position": f"{lat},{lng}",
        })
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
        species.append({
            "id": taxon.get("id"),
            "name": taxon.get("name", ""),
            "common_name": taxon.get("preferred_common_name", ""),
            "photo_url": photo.get("medium_url", photo.get("square_url", "")),
            "observations": r.get("count", 0),
            "url": f"https://www.inaturalist.org/taxa/{taxon.get('id', '')}",
        })
    return species


async def fetch_all_taxa_species(bbox: tuple, month: int = 0) -> dict[str, list[dict]]:
    result = {}
    for taxa in TAXA_LIST:
        result[taxa] = await fetch_species(bbox, month, taxa=taxa, per_page=10)
    return result


async def fetch_observations(
    bbox: tuple,
    month: int = 0,
    taxa: str = "any",
    taxon_id: int | None = None,
    per_page: int = 10,
) -> list[dict]:
    """Fetch individual observations (with coordinates) from iNaturalist."""
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

        photo_url = ""
        if photos:
            photo_url = (photos[0].get("url") or "").replace("square", "small")

        user = obs.get("user") or {}
        observations.append({
            "id": obs.get("id"),
            "lat": coords[1],
            "lng": coords[0],
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


async def fetch_all_observations(bbox: tuple, month: int = 0) -> list[dict]:
    all_obs = []
    for taxa in TAXA_LIST:
        obs = await fetch_observations(bbox, month, taxa=taxa, per_page=10)
        all_obs.extend(obs)
    return all_obs
