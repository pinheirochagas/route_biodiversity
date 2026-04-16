import ee
import json
import logging
import tempfile
from typing import Optional

logger = logging.getLogger(__name__)

_ee_initialized = False


def _init_ee(service_account: str, key_file: str, project: str, key_json: str = ""):
    global _ee_initialized
    if _ee_initialized:
        return
    try:
        if key_json:
            credentials = ee.ServiceAccountCredentials(service_account, key_data=key_json)
        else:
            credentials = ee.ServiceAccountCredentials(service_account, key_file)
        ee.Initialize(credentials, project=project)
        _ee_initialized = True
        logger.info("Earth Engine initialized successfully")
    except Exception as e:
        logger.error(f"Failed to initialize Earth Engine: {e}")
        raise


def _is_in_conus(lat: float, lon: float) -> bool:
    """Check if point is roughly within the contiguous US (PRISM coverage)."""
    return 24.5 <= lat <= 49.5 and -125.0 <= lon <= -66.5


async def fetch_temperature_history(
    lat: float,
    lon: float,
    service_account: str,
    key_file: str,
    project: str,
    key_json: str = "",
    start_year: int = 1895,
    end_year: int = 2024,
) -> dict:
    """
    Fetch yearly mean temperature time series.
    Uses PRISM (800m) for CONUS, ERA5-Land (11km) globally.
    Returns yearly values + anomalies relative to 1951-1980 baseline.
    """
    _init_ee(service_account, key_file, project, key_json=key_json)

    point = ee.Geometry.Point([lon, lat])
    use_prism = _is_in_conus(lat, lon)

    if use_prism:
        dataset = "PRISM"
        resolution = 800
        collection = ee.ImageCollection("OREGONSTATE/PRISM/ANm").select("tmean")
        actual_start = max(start_year, 1895)
    else:
        dataset = "ERA5-Land"
        resolution = 11132
        collection = (
            ee.ImageCollection("ECMWF/ERA5_LAND/MONTHLY_AGGR")
            .select("temperature_2m")
        )
        actual_start = max(start_year, 1950)

    years = list(range(actual_start, end_year + 1))

    def yearly_mean(year):
        y = ee.Number(year)
        filtered = collection.filter(ee.Filter.calendarRange(y, y, "year"))
        mean = filtered.mean().reduceRegion(ee.Reducer.mean(), point, resolution)
        band = "tmean" if use_prism else "temperature_2m"
        return ee.Feature(None, {"year": y, "value": mean.get(band)})

    fc = ee.FeatureCollection([yearly_mean(y) for y in years])
    data = fc.getInfo()

    yearly_temps = []
    for f in data["features"]:
        p = f["properties"]
        if p.get("value") is not None:
            temp = p["value"]
            if not use_prism:
                temp -= 273.15
            yearly_temps.append({"year": int(p["year"]), "temp": round(temp, 2)})

    if not yearly_temps:
        return {
            "dataset": dataset,
            "resolution_m": resolution,
            "years": [],
            "anomalies": [],
            "baseline_mean": None,
            "current_anomaly": None,
            "warming_rate": None,
        }

    baseline_temps = [
        t["temp"] for t in yearly_temps if 1951 <= t["year"] <= 1980
    ]
    baseline_mean = (
        round(sum(baseline_temps) / len(baseline_temps), 2) if baseline_temps else None
    )

    anomalies = []
    for t in yearly_temps:
        anom = round(t["temp"] - baseline_mean, 2) if baseline_mean is not None else None
        anomalies.append({"year": t["year"], "temp": t["temp"], "anomaly": anom})

    current_anomaly = anomalies[-1]["anomaly"] if anomalies else None

    warming_rate = _compute_warming_rate(anomalies)

    return {
        "dataset": dataset,
        "resolution_m": resolution,
        "baseline_period": "1951-1980",
        "baseline_mean": baseline_mean,
        "current_anomaly": current_anomaly,
        "warming_rate": warming_rate,
        "years": anomalies,
    }


def _compute_warming_rate(anomalies: list) -> Optional[float]:
    """Linear regression slope in C per decade over the full record."""
    valid = [(a["year"], a["anomaly"]) for a in anomalies if a["anomaly"] is not None]
    n = len(valid)
    if n < 10:
        return None
    sum_x = sum(y for y, _ in valid)
    sum_y = sum(a for _, a in valid)
    sum_xy = sum(y * a for y, a in valid)
    sum_x2 = sum(y * y for y, _ in valid)
    denom = n * sum_x2 - sum_x * sum_x
    if denom == 0:
        return None
    slope = (n * sum_xy - sum_x * sum_y) / denom
    return round(slope * 10, 3)
