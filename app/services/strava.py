import time
import httpx
from app.config import Settings


STRAVA_AUTH_URL = "https://www.strava.com/oauth/authorize"
STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token"
STRAVA_API_BASE = "https://www.strava.com/api/v3"


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


async def fetch_recent_activities(access_token: str, per_page: int = 10) -> list[dict]:
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{STRAVA_API_BASE}/athlete/activities",
            params={"per_page": per_page},
            headers={"Authorization": f"Bearer {access_token}"},
        )
        resp.raise_for_status()
        activities = resp.json()
        return [
            {
                "id": a["id"],
                "name": a.get("name", "Untitled"),
                "type": a.get("sport_type", a.get("type", "")),
                "date": a.get("start_date_local", ""),
                "distance_km": round(a.get("distance", 0) / 1000, 1),
                "url": f"https://www.strava.com/activities/{a['id']}",
            }
            for a in activities
        ]


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
