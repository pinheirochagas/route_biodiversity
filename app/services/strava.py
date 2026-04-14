import logging
import time
from datetime import datetime, timedelta
import httpx
from app.config import Settings

log = logging.getLogger(__name__)

STRAVA_AUTH_URL = "https://www.strava.com/oauth/authorize"
STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token"
STRAVA_API_BASE = "https://www.strava.com/api/v3"

_activity_cache: dict[str, list[dict]] = {}
_cache_building: set[str] = set()


def build_authorization_url(settings: Settings, scope: str = "activity:read") -> str:
    return (
        f"{STRAVA_AUTH_URL}"
        f"?client_id={settings.strava_client_id}"
        f"&response_type=code"
        f"&redirect_uri={settings.strava_redirect_uri}"
        f"&scope={scope}"
        f"&approval_prompt=auto"
    )


async def exchange_token(settings: Settings, code: str) -> dict:
    async with httpx.AsyncClient() as client:
        resp = await client.post(STRAVA_TOKEN_URL, data={
            "client_id": settings.strava_client_id,
            "client_secret": settings.strava_client_secret,
            "code": code,
            "grant_type": "authorization_code",
        })
        resp.raise_for_status()
        return resp.json()


async def refresh_access_token(settings: Settings, refresh_token: str) -> dict:
    async with httpx.AsyncClient() as client:
        resp = await client.post(STRAVA_TOKEN_URL, data={
            "client_id": settings.strava_client_id,
            "client_secret": settings.strava_client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        })
        resp.raise_for_status()
        return resp.json()


async def get_valid_token(settings: Settings, token_data: dict) -> dict:
    """Return token_data with a valid access_token, refreshing if expired."""
    if token_data.get("expires_at", 0) < time.time():
        refreshed = await refresh_access_token(settings, token_data["refresh_token"])
        token_data["access_token"] = refreshed["access_token"]
        token_data["refresh_token"] = refreshed["refresh_token"]
        token_data["expires_at"] = refreshed["expires_at"]
    return token_data


def _format_activity(a: dict) -> dict:
    return {
        "id": a["id"],
        "name": a.get("name", "Untitled"),
        "type": a.get("sport_type", a.get("type", "")),
        "date": a.get("start_date_local", ""),
        "distance_km": round(a.get("distance", 0) / 1000, 1),
        "url": f"https://www.strava.com/activities/{a['id']}",
    }


# ── Activity cache ──

async def build_full_activity_cache(access_token: str, athlete_id: str) -> None:
    """Fetch last 6 months of activities from Strava and cache them."""
    if athlete_id in _cache_building:
        return
    _cache_building.add(athlete_id)
    after = int((datetime.now() - timedelta(days=180)).timestamp())
    headers = {"Authorization": f"Bearer {access_token}"}
    all_activities: list[dict] = []
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            page = 1
            while True:
                resp = await client.get(
                    f"{STRAVA_API_BASE}/athlete/activities",
                    params={"per_page": 200, "page": page, "after": after},
                    headers=headers,
                )
                resp.raise_for_status()
                activities = resp.json()
                if not activities:
                    break
                all_activities.extend(_format_activity(a) for a in activities)
                if len(activities) < 200:
                    break
                page += 1
        all_activities.reverse()
        _activity_cache[athlete_id] = all_activities
        log.info("Cached %d activities for athlete %s", len(all_activities), athlete_id)
    except Exception:
        log.exception("Failed to build activity cache for athlete %s", athlete_id)
    finally:
        _cache_building.discard(athlete_id)


def is_cache_ready(athlete_id: str) -> bool:
    return athlete_id in _activity_cache


def get_cache_status(athlete_id: str) -> dict:
    if athlete_id in _activity_cache:
        return {"ready": True, "count": len(_activity_cache[athlete_id])}
    return {"ready": False, "building": athlete_id in _cache_building, "count": 0}


def get_cached_activities(athlete_id: str) -> list[dict]:
    return _activity_cache.get(athlete_id, [])


def search_cached_activities(athlete_id: str, query: str, limit: int = 20) -> list[dict]:
    cached = _activity_cache.get(athlete_id, [])
    q = query.lower()
    return [a for a in cached if q in a["name"].lower()][:limit]


async def fetch_recent_activities(access_token: str, per_page: int = 20) -> list[dict]:
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{STRAVA_API_BASE}/athlete/activities",
            params={"per_page": per_page},
            headers={"Authorization": f"Bearer {access_token}"},
        )
        resp.raise_for_status()
        return [_format_activity(a) for a in resp.json()]


async def fetch_athlete_id(access_token: str) -> str:
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{STRAVA_API_BASE}/athlete",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        resp.raise_for_status()
        return str(resp.json().get("id", ""))


async def fetch_activity(access_token: str, activity_id: str) -> dict:
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{STRAVA_API_BASE}/activities/{activity_id}",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        resp.raise_for_status()
        return resp.json()


async def fetch_activity_streams(access_token: str, activity_id: str) -> list:
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{STRAVA_API_BASE}/activities/{activity_id}/streams",
            params={"keys": "latlng", "key_by_type": "true"},
            headers={"Authorization": f"Bearer {access_token}"},
        )
        resp.raise_for_status()
        data = resp.json()
        if "latlng" in data:
            return data["latlng"]["data"]
        return []
