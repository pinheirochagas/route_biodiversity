from fastapi import APIRouter, Request, Depends
from fastapi.responses import RedirectResponse
from app.config import Settings, get_settings
from app.services.strava import build_authorization_url, exchange_token

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

    response = RedirectResponse("/?auth=success")
    request.session["strava"] = {
        "access_token": token_data["access_token"],
        "refresh_token": token_data["refresh_token"],
        "expires_at": token_data["expires_at"],
    }
    return response


@router.get("/status")
async def auth_status(request: Request):
    strava = request.session.get("strava")
    if strava and strava.get("access_token"):
        return {"authenticated": True}
    return {"authenticated": False}


@router.post("/logout")
async def logout(request: Request):
    request.session.clear()
    return {"ok": True}
