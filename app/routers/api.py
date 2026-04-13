from fastapi import APIRouter, Request, UploadFile, File, HTTPException, Depends
import dateutil.parser

from app.config import Settings, get_settings
from app.services.strava import (
    fetch_activity,
    fetch_activity_streams,
    fetch_recent_activities,
    get_valid_token,
)
from app.services.biodiversity import (
    coords_to_bbox,
    gpx_to_coords,
    fetch_all_taxa_species,
    fetch_all_observations,
    fetch_observations,
    fetch_indigenous_territories,
    identify_country,
)

router = APIRouter(prefix="/api", tags=["api"])


def _require_strava(request: Request) -> dict:
    strava = request.session.get("strava")
    if not strava or not strava.get("access_token"):
        raise HTTPException(401, "Not authenticated with Strava")
    return strava


@router.get("/activities")
async def list_activities(
    request: Request,
    settings: Settings = Depends(get_settings),
):
    strava = _require_strava(request)
    strava = await get_valid_token(settings, strava)
    request.session["strava"] = strava
    activities = await fetch_recent_activities(strava["access_token"])
    return {"activities": activities}


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

    bbox = coords_to_bbox(coords)
    activity_date = dateutil.parser.parse(activity.get("start_date_local", ""))
    month = activity_date.month

    return {
        "name": activity.get("name", "Untitled"),
        "date": activity.get("start_date_local"),
        "month": month,
        "coords": coords,
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

    bbox = coords_to_bbox(coords)
    return {
        "name": file.filename or "GPX Route",
        "month": 0,
        "coords": coords,
        "bbox": list(bbox),
    }


@router.post("/species")
async def get_species(body: dict):
    bbox = body.get("bbox")
    month = body.get("month", 0)
    if not bbox or len(bbox) != 4:
        raise HTTPException(400, "bbox must be [swlat, swlng, nelat, nelng]")

    species_by_taxa = await fetch_all_taxa_species(tuple(bbox), month)
    return {"species": species_by_taxa}


@router.post("/observations")
async def get_observations(body: dict):
    bbox = body.get("bbox")
    month = body.get("month", 0)
    taxon_id = body.get("taxon_id")
    if not bbox or len(bbox) != 4:
        raise HTTPException(400, "bbox must be [swlat, swlng, nelat, nelng]")

    if taxon_id:
        observations = await fetch_observations(
            tuple(bbox), month, taxon_id=int(taxon_id), per_page=10,
        )
    else:
        observations = await fetch_all_observations(tuple(bbox), month)
    return {"observations": observations}


@router.post("/territories")
async def get_territories(body: dict):
    bbox = body.get("bbox")
    if not bbox or len(bbox) != 4:
        raise HTTPException(400, "bbox must be [swlat, swlng, nelat, nelng]")

    territories = await fetch_indigenous_territories(tuple(bbox))
    country = await identify_country(tuple(bbox))
    return {"territories": territories, "country": country}
