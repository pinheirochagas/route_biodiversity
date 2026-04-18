# CLAUDE.md — Route to Biodiversity

## Project overview

A web app that situates humans in the living landscape — exploring the biological, geological, and environmental character of any route or location. Users connect Strava, upload a GPX file, or use Situate to search anywhere. The app aggregates data from iNaturalist, GBIF, eBird, Xeno-Canto, Macrostrat, Mindat, Google Earth Engine, and Native Land Digital to show species, geomaterials, environmental trends, and indigenous territories.

**Live site:** https://bioroute.pedrolab.org (deployed on Railway)

## Tech stack

- **Backend:** Python 3.11+ / FastAPI (`app/main.py`)
- **Frontend:** Vanilla JS + Tailwind CSS (CDN) + Leaflet.js — single-page app served as static files
- **Deployment:** Docker → Railway (auto-deploys from `master` branch)
- **No database** — sessions stored in signed cookies, activity cache is in-memory

## Architecture

```
app/
├── main.py                  # FastAPI app, middleware, static mount
├── config.py                # Pydantic Settings (env vars)
├── routers/
│   ├── auth.py              # Strava OAuth flow (login, callback, logout, status)
│   └── api.py               # REST endpoints (activities, species, geology, climate, territories)
├── services/
│   ├── strava.py            # Strava API client, token refresh, activity caching
│   ├── biodiversity.py      # iNaturalist, Native Land, BigDataCloud, GBIF APIs, convex hull
│   ├── ebird.py             # eBird API client (recent + notable observations)
│   ├── geology.py           # Macrostrat, Mindat, Wikipedia geology services
│   └── climate.py           # Google Earth Engine: temperature, NDVI, fire trends
└── static/
    ├── index.html           # SPA shell (3-panel layout: sidebar, center, map)
    ├── styles.css            # Custom CSS (desktop 3-panel + mobile responsive)
    └── app.js               # All client-side logic
```

## Key env vars

| Variable | Purpose |
|---|---|
| `STRAVA_CLIENT_ID` | Strava API app ID |
| `STRAVA_CLIENT_SECRET` | Strava API secret |
| `BASE_URL` | App URL for OAuth redirects (e.g. `https://bioroute.pedrolab.org`) |
| `SESSION_SECRET` | Session cookie signing key |
| `NATIVE_LAND_API_KEY` | Native Land Digital API key |
| `EBIRD_API_KEY` | eBird / Cornell Lab API key |
| `MINDAT_API_KEY` | Mindat mineral database API key |
| `XENOCANTO_API_KEY` | Xeno-Canto bird sound API key |
| `GEE_SERVICE_ACCOUNT` | Google Earth Engine service account |
| `GEE_KEY_FILE` | GEE service account key file path |
| `GEE_KEY_JSON` | Inline GEE key JSON (for Railway) |
| `GEE_PROJECT` | Google Cloud project ID for GEE |

Local dev uses `.env` file. Production uses Railway env vars.

## Running locally

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Then open http://localhost:8000

## Key behaviors

- **Strava activity cache:** On login (and every page load), the last 6 months of activities are fetched from Strava in the background and cached in-memory. Search queries hit this cache for instant results.
- **Convex hull filtering:** Route coordinates are used to compute a convex hull (~200m buffer). Species and observations are filtered to only include those within the hull, preventing irrelevant results from wide bounding boxes.
- **Species fetching:** When a hull is available, species are aggregated from hull-filtered observations (not from `species_counts` API) to ensure accuracy.
- **Token refresh:** Strava tokens are automatically refreshed when expired via `get_valid_token()` in `auth.py`.
- **GBIF data source toggle:** Users can enable GBIF as a secondary data source in the sidebar. GBIF species are merged with iNaturalist data, deduplicated by scientific name. Species cards show source badges (iNat, GBIF, or both).
- **eBird hybrid time ranges:** Recent sightings (7/14/30 days) use the eBird API directly via route sample points. "All time" queries GBIF's eBird dataset (`datasetKey=4fa7b334-...`) for historical data. Note: GBIF's eBird data has a ~2 year lag, so intermediate ranges (6mo, 1yr) aren't offered.

## Frontend layout

- **Desktop:** 3-panel — sidebar (220px, route input + activities + taxa filters + data sources), center (environment + geomaterials + filters bar + species grid), map (50%)
- **Mobile:** Persistent Activities/Situate nav bar at top. Sidebar opens as dropdown overlay. Map at 50vh with fullscreen toggle. Species grid is 2 columns. Environment starts collapsed.

## External APIs

- **Strava API** — OAuth2 auth, activity list, activity streams (lat/lng)
- **iNaturalist API** — species observations across all taxa
- **GBIF API** — global biodiversity occurrences; also historical eBird data via dataset key
- **eBird API** — recent and notable bird sightings (requires API key)
- **Xeno-Canto API** — bird sound recordings
- **Macrostrat API** — rock formations and lithology at sampled points
- **Mindat API** — minerals and localities near the route
- **Wikipedia API** — geological descriptions and rock types
- **Google Earth Engine** — temperature, NDVI, and fire trend analysis via satellite data (PRISM, ERA5-Land, MODIS)
- **Native Land Digital API** — indigenous territory lookup (requires API key)
- **BigDataCloud** — reverse geocoding for country/state/county

## Deployment

Railway auto-deploys on push to `master`. Uses `Dockerfile` for builds.

```bash
git push origin master
```

To set Railway env vars:
```bash
railway variables set KEY=value
```

## API endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/species` | POST | iNaturalist species by taxa (bbox, month, hull) |
| `/api/observations` | POST | iNaturalist observations (bbox, month, taxon_id, hull) |
| `/api/territories` | POST | Native Land territories + country (bbox) |
| `/api/geology` | POST | Geomaterials for route (Macrostrat + Mindat + Wikipedia) |
| `/api/geology/point` | POST | Geology at a single map click point |
| `/api/climate` | POST | Temperature anomaly time series (PRISM/ERA5-Land) |
| `/api/climate/ndvi` | POST | NDVI vegetation time series (MODIS) |
| `/api/climate/ndvi-tiles` | POST | NDVI trend map tile URL (GEE) |
| `/api/climate/temp-tiles` | POST | Temperature trend map tile URL (GEE) |
| `/api/climate/fire-tiles` | POST | Fire trend map tile URL (GEE) |
| `/api/birdsong` | GET | Bird sound recording from Xeno-Canto |
| `/api/gbif/species` | POST | GBIF species by taxa (bbox, month, hull) |
| `/api/gbif/observations` | POST | GBIF observations (bbox, month, taxon_id, hull) |
| `/api/ebird/recent` | POST | eBird recent sightings (coords, dist_km, back_days) |
| `/api/ebird/notable` | POST | eBird notable sightings (coords, dist_km, back_days) |
| `/api/ebird/historical` | POST | eBird all-time historical via GBIF (bbox, hull) |

## Common tasks

- **Add a new taxa group:** Add to `TAXA_LIST` in `biodiversity.py`, add icon in `TAXA_ICON_CLASSES` and label in `TAXA_LABELS` in `app.js`
- **Change hull buffer:** Modify `buffer_deg` parameter in `convex_hull()` in `biodiversity.py` (0.002 ≈ 200m)
- **Icons:** Using Font Awesome 6 (CDN). Taxa icons defined in `TAXA_ICON_CLASSES` in `app.js`
- **Add a new data source:** Add toggle in `#source-toggles` (index.html), handle in `initSourceToggles()` (app.js), create backend service + endpoint

## Style conventions

- Minimal, clean aesthetic (Vercel/Notion-inspired)
- Font: Inter
- Colors: grays (#111827 primary, #9ca3af secondary, #f3f4f6 borders)
- No emoji in code or UI unless explicitly requested
