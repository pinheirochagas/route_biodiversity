from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    strava_client_id: str
    strava_client_secret: str
    base_url: str = "http://localhost:8000"
    session_secret: str = "change-me-in-production"
    native_land_api_key: str = ""
    ebird_api_key: str = ""
    mindat_api_key: str = ""
    google_api_key: str = ""
    xenocanto_api_key: str = ""
    gee_service_account: str = ""
    gee_key_file: str = ""
    gee_project: str = ""

    @property
    def strava_redirect_uri(self) -> str:
        return f"{self.base_url}/auth/callback"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


@lru_cache
def get_settings() -> Settings:
    return Settings()
