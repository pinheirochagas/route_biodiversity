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

    warming_rate = _compute_trend_per_decade(anomalies)

    return {
        "dataset": dataset,
        "resolution_m": resolution,
        "baseline_period": "1951-1980",
        "baseline_mean": baseline_mean,
        "current_anomaly": current_anomaly,
        "warming_rate": warming_rate,
        "years": anomalies,
    }


def _compute_trend_per_decade(values: list, year_key: str = "year", val_key: str = "anomaly") -> Optional[float]:
    """Linear regression slope per decade over the full record."""
    valid = [(a[year_key], a[val_key]) for a in values if a.get(val_key) is not None]
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
    return round(slope * 10, 4)


async def fetch_ndvi_history(
    bbox: list,
    service_account: str,
    key_file: str,
    project: str,
    key_json: str = "",
    start_year: int = 2000,
    end_year: int = 2024,
) -> dict:
    """
    Fetch yearly mean NDVI averaged across all pixels in bbox.
    Uses MODIS MOD13A2 (1km, global, 2000-present).
    Returns yearly values + anomalies relative to 2001-2010 baseline.
    bbox: [swlat, swlng, nelat, nelng]
    """
    _init_ee(service_account, key_file, project, key_json=key_json)

    region = ee.Geometry.Rectangle([bbox[1], bbox[0], bbox[3], bbox[2]])
    collection = ee.ImageCollection("MODIS/061/MOD13A2")
    actual_start = max(start_year, 2000)
    years = list(range(actual_start, end_year + 1))

    def yearly_mean_ndvi(year):
        y = ee.Number(year)
        imgs = collection.filter(ee.Filter.calendarRange(y, y, "year"))

        def mask_quality(img):
            good = img.select("SummaryQA").eq(0)
            return img.select("NDVI").updateMask(good)

        masked = imgs.map(mask_quality)
        mean_val = masked.mean().multiply(0.0001).reduceRegion(
            ee.Reducer.mean(), region, 1000, maxPixels=1e7
        ).get("NDVI")
        return ee.Feature(None, {"year": y, "ndvi": mean_val})

    fc = ee.FeatureCollection([yearly_mean_ndvi(y) for y in years])
    data = fc.getInfo()

    yearly_ndvi = []
    for f in data["features"]:
        p = f["properties"]
        if p.get("ndvi") is not None:
            yearly_ndvi.append({
                "year": int(p["year"]),
                "ndvi": round(p["ndvi"], 4),
            })

    if not yearly_ndvi:
        return {
            "dataset": "MODIS MOD13A2",
            "resolution_m": 1000,
            "years": [],
            "baseline_mean": None,
            "current_anomaly": None,
            "trend_per_decade": None,
        }

    baseline = [v["ndvi"] for v in yearly_ndvi if 2001 <= v["year"] <= 2010]
    baseline_mean = round(sum(baseline) / len(baseline), 4) if baseline else None

    for v in yearly_ndvi:
        v["anomaly"] = round(v["ndvi"] - baseline_mean, 4) if baseline_mean is not None else None

    current_anomaly = yearly_ndvi[-1]["anomaly"] if yearly_ndvi else None
    trend = _compute_trend_per_decade(yearly_ndvi)

    return {
        "dataset": "MODIS MOD13A2",
        "resolution_m": 1000,
        "baseline_period": "2001-2010",
        "baseline_mean": baseline_mean,
        "current_anomaly": current_anomaly,
        "trend_per_decade": trend,
        "years": yearly_ndvi,
    }


def get_ndvi_trend_tile_url(
    service_account: str,
    key_file: str,
    project: str,
    key_json: str = "",
) -> dict:
    """
    Generate a GEE tile URL showing per-pixel NDVI linear trend (2001-2024)
    at 250m resolution (MOD13Q1). Pre-aggregates to annual composites (24 images)
    before linearFit for fast tile rendering with negligible quality loss.
    """
    _init_ee(service_account, key_file, project, key_json=key_json)

    collection = ee.ImageCollection("MODIS/061/MOD13Q1")

    def mask_quality(img):
        good = img.select("SummaryQA").eq(0)
        return img.select("NDVI").updateMask(good)

    masked = collection.filterDate("2001-01-01", "2025-01-01").map(mask_quality)

    years = list(range(2001, 2025))
    annual_images = []
    for yr in years:
        annual = masked.filterDate(f"{yr}-01-01", f"{yr + 1}-01-01").mean().multiply(0.0001)
        t_val = yr - 2001
        with_time = annual.addBands(ee.Image.constant(t_val).float().rename("t"))
        annual_images.append(with_time)

    annual_col = ee.ImageCollection(annual_images)

    trend = annual_col.select(["t", "NDVI"]).reduce(ee.Reducer.linearFit())
    slope = trend.select("scale")
    slope_decade = slope.multiply(10)

    vis_params = {
        "min": -0.05,
        "max": 0.05,
        "palette": [
            "#8B0000", "#D32F2F", "#E57373", "#FFCDD2",
            "#F5F5F5",
            "#C8E6C9", "#66BB6A", "#2E7D32", "#1B5E20",
        ],
    }

    map_id = slope_decade.getMapId(vis_params)
    tile_url = map_id["tile_fetcher"].url_format

    return {
        "tile_url": tile_url,
        "dataset": "MODIS MOD13Q1 trend",
        "resolution_m": 250,
        "period": "2001-2024",
        "units": "NDVI change per decade",
    }


def _build_annual_trend(collection, band, start_year, end_year):
    """Server-side annual compositing + linearFit trend (°C per decade)."""
    years_list = ee.List.sequence(start_year, end_year)

    def annual_with_time(y):
        y = ee.Number(y)
        annual = (
            collection
            .filter(ee.Filter.date(
                ee.Date.fromYMD(y, 1, 1),
                ee.Date.fromYMD(y.add(1), 1, 1),
            ))
            .mean()
            .rename("val")
        )
        t = ee.Image(y.subtract(start_year)).float().rename("t")
        return annual.addBands(t).set("year", y)

    annual_col = ee.ImageCollection(years_list.map(annual_with_time))
    trend = annual_col.select(["t", "val"]).reduce(ee.Reducer.linearFit())
    return trend.select("scale").multiply(10)


def get_temperature_trend_tile_url(
    service_account: str,
    key_file: str,
    project: str,
    key_json: str = "",
) -> dict:
    """
    Per-pixel air temperature trend:
    PRISM (~4km, CONUS) on top of ERA5-Land (11km, global).
    Uses server-side annual compositing for efficient tile serving.
    """
    _init_ee(service_account, key_file, project, key_json=key_json)

    start_yr, end_yr = 1981, 2024

    # PRISM: monthly tmean → annual mean (CONUS, ~4km)
    prism = ee.ImageCollection("OREGONSTATE/PRISM/ANm").select("tmean")
    prism_trend = _build_annual_trend(prism, "tmean", start_yr, end_yr)

    # ERA5-Land: monthly → annual mean, K→C (global, 11km)
    era5_raw = ee.ImageCollection("ECMWF/ERA5_LAND/MONTHLY_AGGR").select("temperature_2m")
    era5_c = era5_raw.map(
        lambda img: img.subtract(273.15).rename("val")
            .copyProperties(img, ["system:time_start"])
    )
    era5_trend = _build_annual_trend(era5_c, "val", start_yr, end_yr)

    # PRISM on top where available, ERA5-Land fills globally
    combined = prism_trend.unmask(era5_trend)

    vis_params = {
        "min": -0.5,
        "max": 0.5,
        "palette": [
            "#08519c", "#3182bd", "#6baed6", "#bdd7e7",
            "#F5F5F5",
            "#fcae91", "#fb6a4a", "#cb181d", "#67000d",
        ],
    }

    map_id = combined.getMapId(vis_params)
    tile_url = map_id["tile_fetcher"].url_format

    return {
        "tile_url": tile_url,
        "dataset": "PRISM ~4km (US) + ERA5-Land 11km (global)",
        "resolution_m": 4000,
        "period": "1981-2024",
        "units": "°C change per decade",
    }


def get_fire_trend_tile_url(
    service_account: str,
    key_file: str,
    project: str,
    key_json: str = "",
) -> dict:
    """
    Per-pixel fire frequency trend (2001-2024) from MODIS MCD64A1 (500m).
    For each year a binary burned mask is created (1 = burned, 0 = not).
    linearFit across the 24 annual masks gives the trend in burn frequency.
    """
    _init_ee(service_account, key_file, project, key_json=key_json)

    collection = ee.ImageCollection("MODIS/061/MCD64A1")
    years = list(range(2001, 2025))
    annual_images = []

    for yr in years:
        annual_burned = (
            collection
            .filterDate(f"{yr}-01-01", f"{yr + 1}-01-01")
            .select("BurnDate")
            .max()
            .gt(0)
            .unmask(0)
            .rename("burned")
        )
        t_val = yr - 2001
        with_time = annual_burned.addBands(
            ee.Image.constant(t_val).float().rename("t")
        )
        annual_images.append(with_time)

    annual_col = ee.ImageCollection(annual_images)
    trend = annual_col.select(["t", "burned"]).reduce(ee.Reducer.linearFit())
    slope_decade = trend.select("scale").multiply(10)

    vis_params = {
        "min": -0.15,
        "max": 0.15,
        "palette": [
            "#08519c", "#6baed6", "#bdd7e7",
            "#F5F5F5",
            "#fdae6b", "#e6550d", "#7f2704",
        ],
    }

    map_id = slope_decade.getMapId(vis_params)
    tile_url = map_id["tile_fetcher"].url_format

    return {
        "tile_url": tile_url,
        "dataset": "MODIS MCD64A1 trend",
        "resolution_m": 500,
        "period": "2001-2024",
        "units": "fire freq. change per decade",
    }


async def fetch_fire_history(
    bbox: list,
    service_account: str,
    key_file: str,
    project: str,
    key_json: str = "",
    start_year: int = 2001,
    end_year: int = 2024,
) -> dict:
    """
    Fetch yearly burned-area fraction averaged across all pixels in bbox.
    Uses MODIS MCD64A1 (500m, global, 2000-present).
    Returns yearly values + anomalies relative to 2001-2010 baseline.
    bbox: [swlat, swlng, nelat, nelng]
    """
    _init_ee(service_account, key_file, project, key_json=key_json)

    region = ee.Geometry.Rectangle([bbox[1], bbox[0], bbox[3], bbox[2]])
    collection = ee.ImageCollection("MODIS/061/MCD64A1")
    actual_start = max(start_year, 2001)
    years = list(range(actual_start, end_year + 1))

    def yearly_burn_fraction(year):
        y = ee.Number(year)
        burned = (
            collection
            .filter(ee.Filter.calendarRange(y, y, "year"))
            .select("BurnDate")
            .max()
            .gt(0)
            .unmask(0)
        )
        frac = burned.reduceRegion(
            ee.Reducer.mean(), region, 500, maxPixels=1e7
        ).get("BurnDate")
        return ee.Feature(None, {"year": y, "burned_fraction": frac})

    fc = ee.FeatureCollection([yearly_burn_fraction(y) for y in years])
    data = fc.getInfo()

    yearly_fire = []
    for f in data["features"]:
        p = f["properties"]
        if p.get("burned_fraction") is not None:
            yearly_fire.append({
                "year": int(p["year"]),
                "burned_fraction": round(p["burned_fraction"], 6),
            })

    if not yearly_fire:
        return {
            "dataset": "MODIS MCD64A1",
            "resolution_m": 500,
            "years": [],
            "baseline_mean": None,
            "current_anomaly": None,
            "trend_per_decade": None,
        }

    baseline = [v["burned_fraction"] for v in yearly_fire if 2001 <= v["year"] <= 2010]
    baseline_mean = round(sum(baseline) / len(baseline), 6) if baseline else None

    for v in yearly_fire:
        v["anomaly"] = (
            round(v["burned_fraction"] - baseline_mean, 6)
            if baseline_mean is not None else None
        )

    current_anomaly = yearly_fire[-1]["anomaly"] if yearly_fire else None
    trend = _compute_trend_per_decade(yearly_fire, val_key="anomaly")

    return {
        "dataset": "MODIS MCD64A1",
        "resolution_m": 500,
        "baseline_period": "2001-2010",
        "baseline_mean": baseline_mean,
        "current_anomaly": current_anomaly,
        "trend_per_decade": trend,
        "years": yearly_fire,
    }
