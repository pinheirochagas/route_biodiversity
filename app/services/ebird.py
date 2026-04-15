import asyncio

import httpx

from app.services.biodiversity import point_in_hull

EBIRD_BASE_URL = "https://api.ebird.org/v2"


async def fetch_recent_observations(
    coords: list[list[float]],
    api_key: str,
    dist_km: int = 25,
    back_days: int = 14,
    hull: list[list[float]] | None = None,
) -> list[dict]:
    """Fetch recent eBird observations along a route.

    Samples points every ~10km along the route and merges/deduplicates results.
    If hull is provided, only observations within the hull polygon are kept.
    """
    if not api_key:
        return []

    use_hull = hull and len(hull) >= 3
    sample_points = _sample_route_points(coords, max_points=5)
    headers = {"x-ebirdapitoken": api_key}

    seen = set()
    observations = []

    async with httpx.AsyncClient(timeout=20) as client:
        for lat, lng in sample_points:
            resp = await client.get(
                f"{EBIRD_BASE_URL}/data/obs/geo/recent",
                params={
                    "lat": round(lat, 4),
                    "lng": round(lng, 4),
                    "dist": dist_km,
                    "back": back_days,
                    "maxResults": 100,
                },
                headers=headers,
            )
            if resp.status_code != 200:
                continue

            for obs in resp.json():
                sub_id = obs.get("subId", "")
                sp_code = obs.get("speciesCode", "")
                dedup_key = f"{sub_id}:{sp_code}"
                if dedup_key in seen:
                    continue
                seen.add(dedup_key)

                obs_lat = obs.get("lat")
                obs_lng = obs.get("lng")
                if use_hull and obs_lat is not None and obs_lng is not None:
                    if not point_in_hull(obs_lat, obs_lng, hull):
                        continue

                observations.append({
                    "species_code": sp_code,
                    "common_name": obs.get("comName", ""),
                    "scientific_name": obs.get("sciName", ""),
                    "count": obs.get("howMany", 0),
                    "date": obs.get("obsDt", ""),
                    "location_name": obs.get("locName", ""),
                    "lat": obs_lat,
                    "lng": obs_lng,
                    "location_id": obs.get("locId", ""),
                    "valid": obs.get("obsValid", True),
                    "reviewed": obs.get("obsReviewed", False),
                })

    observations.sort(key=lambda o: o["date"], reverse=True)
    return observations


async def fetch_notable_observations(
    coords: list[list[float]],
    api_key: str,
    dist_km: int = 25,
    back_days: int = 14,
    hull: list[list[float]] | None = None,
) -> list[dict]:
    """Fetch notable/rare eBird observations along a route."""
    if not api_key:
        return []

    use_hull = hull and len(hull) >= 3
    sample_points = _sample_route_points(coords, max_points=5)
    headers = {"x-ebirdapitoken": api_key}

    seen = set()
    observations = []

    async with httpx.AsyncClient(timeout=20) as client:
        for lat, lng in sample_points:
            resp = await client.get(
                f"{EBIRD_BASE_URL}/data/obs/geo/recent/notable",
                params={
                    "lat": round(lat, 4),
                    "lng": round(lng, 4),
                    "dist": dist_km,
                    "back": back_days,
                    "maxResults": 50,
                },
                headers=headers,
            )
            if resp.status_code != 200:
                continue

            for obs in resp.json():
                sub_id = obs.get("subId", "")
                sp_code = obs.get("speciesCode", "")
                dedup_key = f"{sub_id}:{sp_code}"
                if dedup_key in seen:
                    continue
                seen.add(dedup_key)

                obs_lat = obs.get("lat")
                obs_lng = obs.get("lng")
                if use_hull and obs_lat is not None and obs_lng is not None:
                    if not point_in_hull(obs_lat, obs_lng, hull):
                        continue

                observations.append({
                    "species_code": sp_code,
                    "common_name": obs.get("comName", ""),
                    "scientific_name": obs.get("sciName", ""),
                    "count": obs.get("howMany", 0),
                    "date": obs.get("obsDt", ""),
                    "location_name": obs.get("locName", ""),
                    "lat": obs_lat,
                    "lng": obs_lng,
                    "location_id": obs.get("locId", ""),
                    "notable": True,
                })

    observations.sort(key=lambda o: o["date"], reverse=True)
    return observations


INAT_TAXA_URL = "https://api.inaturalist.org/v1/taxa"


async def _fetch_photo_for_name(
    client: httpx.AsyncClient,
    name: str,
) -> tuple[str, str]:
    """Try to find a photo URL on iNaturalist for a scientific name.

    For subspecies (trinomial names like "Genus species subsp"), tries the
    full name first, then falls back to the binomial (species-level) name.
    """
    candidates = [name]
    parts = name.split()
    if len(parts) >= 3:
        candidates.append(f"{parts[0]} {parts[1]}")

    for q in candidates:
        try:
            resp = await client.get(INAT_TAXA_URL, params={
                "q": q, "per_page": 5, "is_active": "true",
            })
            if resp.status_code != 200:
                continue
            results = resp.json().get("results", [])
            q_lower = q.lower()
            genus = q_lower.split()[0]

            for taxon in results:
                taxon_name = (taxon.get("name") or "").lower()
                if taxon_name == q_lower:
                    photo = taxon.get("default_photo") or {}
                    url = photo.get("medium_url") or photo.get("square_url") or ""
                    if url:
                        return (name.lower(), url)

            for taxon in results:
                taxon_name = (taxon.get("name") or "").lower()
                if taxon_name.startswith(genus):
                    photo = taxon.get("default_photo") or {}
                    url = photo.get("medium_url") or photo.get("square_url") or ""
                    if url:
                        return (name.lower(), url)
        except Exception:
            continue

    return (name.lower(), "")


async def enrich_with_photos(observations: list[dict]) -> list[dict]:
    """Fetch species photos from iNaturalist for eBird observations."""
    names = list({
        o.get("scientific_name", "")
        for o in observations if o.get("scientific_name")
    })
    if not names:
        return observations

    sem = asyncio.Semaphore(8)

    async def _limited(client: httpx.AsyncClient, n: str):
        async with sem:
            return await _fetch_photo_for_name(client, n)

    async with httpx.AsyncClient(timeout=15) as client:
        results = await asyncio.gather(
            *[_limited(client, n) for n in names],
            return_exceptions=True,
        )

    photo_map: dict[str, str] = {}
    for r in results:
        if isinstance(r, tuple) and r[1]:
            photo_map[r[0]] = r[1]

    missing = [n for n in names if n.lower() not in photo_map]
    if missing:
        async with httpx.AsyncClient(timeout=15) as client2:
            retry_results = await asyncio.gather(
                *[_limited(client2, n) for n in missing],
                return_exceptions=True,
            )
            for r in retry_results:
                if isinstance(r, tuple) and r[1]:
                    photo_map[r[0]] = r[1]

    for obs in observations:
        sci = (obs.get("scientific_name") or "").lower()
        obs["photo_url"] = photo_map.get(sci, "")

    return observations


def _sample_route_points(
    coords: list[list[float]], max_points: int = 5,
) -> list[tuple[float, float]]:
    """Pick evenly-spaced points along the route for eBird radius queries."""
    if not coords:
        return []
    n = len(coords)
    if n <= max_points:
        return [(c[0], c[1]) for c in coords]
    step = max(1, (n - 1) // (max_points - 1))
    points = []
    for i in range(0, n, step):
        points.append((coords[i][0], coords[i][1]))
        if len(points) >= max_points:
            break
    if len(points) < max_points:
        points.append((coords[-1][0], coords[-1][1]))
    return points
