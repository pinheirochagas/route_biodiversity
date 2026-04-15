import asyncio
from fastapi import APIRouter, Request, UploadFile, File, HTTPException, Depends
import dateutil.parser

from app.config import Settings, get_settings
from app.services.strava import (
    build_full_activity_cache,
    fetch_activity,
    fetch_activity_streams,
    fetch_athlete_id,
    fetch_recent_activities,
    get_valid_token,
    get_cached_activities,
    get_cache_status,
    is_cache_ready,
    search_cached_activities,
)
from app.services.biodiversity import (
    convex_hull,
    coords_to_bbox,
    gpx_to_coords,
    fetch_all_taxa_species,
    fetch_all_observations,
    fetch_observations,
    fetch_indigenous_territories,
    identify_location,
    fetch_gbif_species,
    fetch_gbif_observations,
    fetch_gbif_ebird_species,
)
from app.services.ebird import fetch_recent_observations, fetch_notable_observations, enrich_with_photos
from app.services.geology import fetch_geology_along_route, fetch_geology_at_point

router = APIRouter(prefix="/api", tags=["api"])


def _require_strava(request: Request) -> dict:
    strava = request.session.get("strava")
    if not strava or not strava.get("access_token"):
        raise HTTPException(401, "Not authenticated with Strava")
    return strava


async def _ensure_athlete_id(request: Request, strava: dict) -> str:
    """Resolve athlete_id if missing from session, and kick off cache build/refresh."""
    athlete_id = strava.get("athlete_id", "")
    if not athlete_id:
        athlete_id = await fetch_athlete_id(strava["access_token"])
        strava["athlete_id"] = athlete_id
        request.session["strava"] = strava
    if athlete_id:
        asyncio.create_task(
            build_full_activity_cache(
                strava["access_token"], athlete_id, force=is_cache_ready(athlete_id)
            )
        )
    return athlete_id


@router.get("/activities")
async def list_activities(
    request: Request,
    settings: Settings = Depends(get_settings),
):
    strava = _require_strava(request)
    strava = await get_valid_token(settings, strava)
    request.session["strava"] = strava
    athlete_id = await _ensure_athlete_id(request, strava)
    if athlete_id and is_cache_ready(athlete_id):
        return {"activities": get_cached_activities(athlete_id)}
    activities = await fetch_recent_activities(strava["access_token"])
    return {"activities": activities}


@router.get("/activities/search")
async def search_strava_activities(
    request: Request,
    q: str = "",
    settings: Settings = Depends(get_settings),
):
    strava = _require_strava(request)
    strava = await get_valid_token(settings, strava)
    request.session["strava"] = strava
    if not q.strip():
        return {"activities": []}
    athlete_id = await _ensure_athlete_id(request, strava)
    if not athlete_id or not is_cache_ready(athlete_id):
        return {"activities": [], "cache_not_ready": True}
    return {"activities": search_cached_activities(athlete_id, q.strip())}


@router.get("/activities/cache-status")
async def activity_cache_status(
    request: Request,
    settings: Settings = Depends(get_settings),
):
    strava = _require_strava(request)
    strava = await get_valid_token(settings, strava)
    request.session["strava"] = strava
    athlete_id = await _ensure_athlete_id(request, strava)
    if not athlete_id:
        return {"ready": False, "building": False, "count": 0}
    return get_cache_status(athlete_id)


@router.post("/activities/load-more")
async def load_more_activities(
    request: Request,
    settings: Settings = Depends(get_settings),
):
    strava = _require_strava(request)
    strava = await get_valid_token(settings, strava)
    request.session["strava"] = strava
    athlete_id = await _ensure_athlete_id(request, strava)
    current_months = get_cache_status(athlete_id).get("months", 6)
    new_months = current_months + 6
    await build_full_activity_cache(strava["access_token"], athlete_id, force=True, months=new_months)
    return {"activities": get_cached_activities(athlete_id), "months": new_months}


@router.post("/activity")
async def get_activity(
    request: Request,
    body: dict,
    settings: Settings = Depends(get_settings),
):
    strava = _require_strava(request)
    strava = await get_valid_token(settings, strava)
    request.session["strava"] = strava

    activity_url = body.get("url", "")
    activity_id = activity_url.rstrip("/").split("/")[-1]
    if not activity_id.isdigit():
        raise HTTPException(400, "Invalid Strava activity URL")

    activity = await fetch_activity(strava["access_token"], activity_id)
    coords = await fetch_activity_streams(strava["access_token"], activity_id)

    if not coords:
        raise HTTPException(404, "No route data found for this activity")

    hull = convex_hull(coords)
    bbox = coords_to_bbox(hull)
    activity_date = dateutil.parser.parse(activity.get("start_date_local", ""))
    month = activity_date.month

    return {
        "name": activity.get("name", "Untitled"),
        "date": activity.get("start_date_local"),
        "month": month,
        "coords": coords,
        "hull": hull,
        "bbox": list(bbox),
    }


@router.post("/gpx")
async def upload_gpx(file: UploadFile = File(...)):
    content = await file.read()
    try:
        coords = gpx_to_coords(content)
    except Exception:
        raise HTTPException(400, "Invalid GPX file")

    if not coords:
        raise HTTPException(400, "No track points found in GPX")

    hull = convex_hull(coords)
    bbox = coords_to_bbox(hull)
    return {
        "name": file.filename or "GPX Route",
        "month": 0,
        "coords": coords,
        "hull": hull,
        "bbox": list(bbox),
    }


@router.post("/species")
async def get_species(body: dict):
    bbox = body.get("bbox")
    month = body.get("month", 0)
    hull = body.get("hull")
    if not bbox or len(bbox) != 4:
        raise HTTPException(400, "bbox must be [swlat, swlng, nelat, nelng]")

    species_by_taxa = await fetch_all_taxa_species(tuple(bbox), month, hull=hull)
    return {"species": species_by_taxa}


@router.post("/observations")
async def get_observations(body: dict):
    bbox = body.get("bbox")
    month = body.get("month", 0)
    taxon_id = body.get("taxon_id")
    hull = body.get("hull")
    if not bbox or len(bbox) != 4:
        raise HTTPException(400, "bbox must be [swlat, swlng, nelat, nelng]")

    if taxon_id:
        observations = await fetch_observations(
            tuple(bbox), month, taxon_id=int(taxon_id), per_page=10, hull=hull,
        )
    else:
        observations = await fetch_all_observations(tuple(bbox), month, hull=hull)
    return {"observations": observations}


@router.post("/territories")
async def get_territories(body: dict, settings: Settings = Depends(get_settings)):
    bbox = body.get("bbox")
    if not bbox or len(bbox) != 4:
        raise HTTPException(400, "bbox must be [swlat, swlng, nelat, nelng]")

    territories = await fetch_indigenous_territories(
        tuple(bbox), api_key=settings.native_land_api_key
    )
    location = await identify_location(tuple(bbox))
    return {"territories": territories, "location": location}


@router.post("/geology")
async def get_geology(body: dict, settings: Settings = Depends(get_settings)):
    coords = body.get("coords")
    if not coords or len(coords) < 1:
        raise HTTPException(400, "coords must be a list of [lat, lng] points")
    city = body.get("city", "")
    state = body.get("state", "")
    country = body.get("country", "")
    county = body.get("county", "")
    formations = await fetch_geology_along_route(
        coords, city=city, state=state, country=country,
        county=county, mindat_api_key=settings.mindat_api_key,
    )
    return {"formations": formations}


@router.post("/geology/point")
async def get_geology_point(body: dict):
    lat = body.get("lat")
    lng = body.get("lng")
    if lat is None or lng is None:
        raise HTTPException(400, "lat and lng are required")
    formations = await fetch_geology_at_point(float(lat), float(lng))
    return {"formations": formations}


@router.post("/gbif/species")
async def get_gbif_species(body: dict):
    bbox = body.get("bbox")
    month = body.get("month", 0)
    hull = body.get("hull")
    if not bbox or len(bbox) != 4:
        raise HTTPException(400, "bbox must be [swlat, swlng, nelat, nelng]")

    species_by_taxa = await fetch_gbif_species(tuple(bbox), month, hull=hull)
    return {"species": species_by_taxa}


@router.post("/gbif/observations")
async def get_gbif_observations(body: dict):
    bbox = body.get("bbox")
    hull = body.get("hull")
    scientific_name = body.get("scientific_name", "")
    if not bbox or len(bbox) != 4:
        raise HTTPException(400, "bbox must be [swlat, swlng, nelat, nelng]")
    if not scientific_name:
        raise HTTPException(400, "scientific_name is required")

    observations = await fetch_gbif_observations(
        tuple(bbox), scientific_name, hull=hull,
    )
    return {"observations": observations}


@router.post("/ebird/recent")
async def get_ebird_recent(body: dict, settings: Settings = Depends(get_settings)):
    coords = body.get("coords")
    dist_km = body.get("dist_km", 25)
    back_days = body.get("back_days", 14)
    if not coords or len(coords) < 2:
        raise HTTPException(400, "coords must be a list of [lat, lng] points")

    if not settings.ebird_api_key:
        return {"observations": [], "error": "eBird API key not configured"}

    use_hull = body.get("use_hull", True)
    ebird_hull = convex_hull(coords, buffer_deg=0.005) if use_hull else None
    observations = await fetch_recent_observations(
        coords, settings.ebird_api_key, dist_km=dist_km, back_days=back_days,
        hull=ebird_hull,
    )
    observations = await enrich_with_photos(observations)
    return {"observations": observations}


@router.post("/ebird/notable")
async def get_ebird_notable(body: dict, settings: Settings = Depends(get_settings)):
    coords = body.get("coords")
    dist_km = body.get("dist_km", 25)
    back_days = body.get("back_days", 14)
    if not coords or len(coords) < 2:
        raise HTTPException(400, "coords must be a list of [lat, lng] points")

    if not settings.ebird_api_key:
        return {"observations": [], "error": "eBird API key not configured"}

    use_hull = body.get("use_hull", True)
    ebird_hull = convex_hull(coords, buffer_deg=0.005) if use_hull else None
    observations = await fetch_notable_observations(
        coords, settings.ebird_api_key, dist_km=dist_km, back_days=back_days,
        hull=ebird_hull,
    )
    observations = await enrich_with_photos(observations)
    return {"observations": observations}


@router.post("/ebird/historical")
async def get_ebird_historical(body: dict):
    bbox = body.get("bbox")
    hull = body.get("hull")
    if not bbox or len(bbox) != 4:
        raise HTTPException(400, "bbox must be [swlat, swlng, nelat, nelng]")

    wide_hull = convex_hull(hull, buffer_deg=0.005) if hull and len(hull) >= 3 else hull
    species = await fetch_gbif_ebird_species(tuple(bbox), hull=wide_hull)
    species = await enrich_with_photos(species)
    return {"species": species}
