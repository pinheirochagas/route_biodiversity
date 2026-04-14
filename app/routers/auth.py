import asyncio
from fastapi import APIRouter, Request, Depends
from fastapi.responses import RedirectResponse
from app.config import Settings, get_settings
from app.services.strava import (
    build_authorization_url,
    exchange_token,
    build_full_activity_cache,
)

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/strava")
async def strava_login(settings: Settings = Depends(get_settings)):
    url = build_authorization_url(settings)
    return RedirectResponse(url)


@router.get("/callback")
async def strava_callback(
    request: Request,
    code: str | None = None,
    error: str | None = None,
    settings: Settings = Depends(get_settings),
):
    if error or not code:
        return RedirectResponse("/?auth=error")

    token_data = await exchange_token(settings, code)
    athlete = token_data.get("athlete", {})
    athlete_id = str(athlete.get("id", ""))

    request.session["strava"] = {
        "access_token": token_data["access_token"],
        "refresh_token": token_data["refresh_token"],
        "expires_at": token_data["expires_at"],
        "athlete_id": athlete_id,
    }

    if athlete_id:
        asyncio.create_task(
            build_full_activity_cache(token_data["access_token"], athlete_id)
        )

    return RedirectResponse("/?auth=success")


@router.get("/status")
async def auth_status(request: Request):
    strava = request.session.get("strava")
    if strava and strava.get("access_token"):
        return {
            "authenticated": True,
            "athlete_id": strava.get("athlete_id", ""),
        }
    return {"authenticated": False}


@router.post("/logout")
async def logout(request: Request):
    request.session.clear()
    return {"ok": True}
