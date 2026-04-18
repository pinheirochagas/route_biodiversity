# Route to Biodiversity

**Route to Biodiversity** situates humans in the living landscape, exploring the biological, geological, and environmental character of any route or location on the planet.

Connect your Strava activities, upload a GPX file, or use **Situate** to find your location or search anywhere. The app aggregates data from multiple sources to show the species observed along your path, the rock formations and minerals beneath it, and long-term trends in temperature, vegetation, and wildfire activity. In the US, it also surfaces the indigenous peoples whose territories the route crosses.

**Live site:** [bioroute.pedrolab.org](https://bioroute.pedrolab.org)

---

## Features

### Route input

- **Strava integration** — OAuth2 login with automatic activity caching (last 6 months). Search and select any activity by name, date, or location.
- **GPX upload** — Upload any GPX file to analyze an arbitrary route.
- **Situate** — Use your current location or search for any place on the planet. Generates a bounding box around the point for analysis.
- **Custom area** — Draw a rectangle directly on the map to define a custom study region.
- **Convex hull filtering** — Route coordinates are used to compute a convex hull with a ~200m buffer. All observations are filtered to this hull, preventing irrelevant results from wide bounding boxes.

### Biodiversity

Species observations are aggregated from three independent databases and deduplicated by scientific name. Each species card shows source badges indicating which databases recorded it.

| Source | What it provides |
|---|---|
| [iNaturalist](https://www.inaturalist.org) | Community species observations across all taxa (mammals, birds, reptiles, fish, amphibians, plants, fungi, insects, arachnids, mollusks) |
| [GBIF](https://www.gbif.org) | Global biodiversity occurrence records, extending coverage beyond iNaturalist |
| [eBird](https://ebird.org) | Bird sightings with configurable time ranges (7/14/30 days recent, or all-time via GBIF's eBird dataset) |

**Filtering and display:**

- Filter by taxonomic group (10 taxa) via sidebar or mobile pills
- Filter by month (year-round or specific month)
- Filter by count (all, top 10, top 25)
- Species cards show common name, scientific name, observation count, photo, and source badges
- Click a species to see individual observations on the map with photos and dates

**Bird sounds:**

- Bird species cards include a play button that streams audio from [Xeno-Canto](https://www.xeno-canto.org)
- Prioritizes high-quality song recordings from the route's country, falling back to global recordings

### Geomaterials

Geological data is assembled from three sources, classified into rock types (ignite, sedimentary, metamorphic, mineral, soil, gem), and displayed as filterable pills.

| Source | What it provides |
|---|---|
| [Macrostrat](https://macrostrat.org) | Rock formations and lithology sampled at points along the route (unit name, age, geological period, description) |
| [Mindat](https://www.mindat.org) | Minerals and localities near the route, resolved by geographic text search |
| [Wikipedia](https://en.wikipedia.org) | Additional rock types from regional geology articles |

**Filtering and display:**

- Filter by geomaterial class (igneous, sedimentary, metamorphic, mineral, soil, gem, or all)
- Expandable gallery with photo cards for each formation or mineral
- Click a card to see details (age, geological period, description)
- Interactive geology map layer (Macrostrat tiles) — click anywhere on the map to query the geology at that point

### Environment

Environmental trends are computed via [Google Earth Engine](https://earthengine.google.com), showing how conditions along the route have changed over decades.

**Temperature anomalies:**

- Annual mean temperature time series relative to a 1951-1980 baseline
- Displayed as warming stripes (blue-to-red gradient)
- Shows current anomaly and warming rate per decade
- Data: [PRISM](https://prism.oregonstate.edu) at 800m resolution for the contiguous US, [ERA5-Land](https://cds.climate.copernicus.eu) at 11km globally

**Vegetation health (NDVI):**

- Annual Normalized Difference Vegetation Index from 2000 to present
- Displayed as green-to-brown stripes
- Shows current NDVI anomaly relative to 2001-2010 baseline and trend per decade
- Data: MODIS MOD13A2 at 1km resolution

**Map trend layers (toggleable):**

| Layer | Dataset | Resolution | Period |
|---|---|---|---|
| Temperature trend | PRISM + ERA5-Land mosaic | 800m / 11km | 1981-2024 |
| Vegetation trend | MODIS MOD13Q1 | 250m | 2000-2024 |
| Fire trend | MODIS MCD64A1 | 500m | 2001-2024 |

Each layer shows per-pixel linear trends (blue = decreasing, red = increasing) computed via `linearFit` over pre-aggregated annual composites.

### Territories

- [Native Land Digital](https://native-land.ca) — Identifies indigenous territories, languages, and treaties that overlap with the route's bounding box
- Currently US-focused
- Territory names are displayed in the route info panel with links to Native Land

### Map

- Interactive [Leaflet.js](https://leafletjs.com) map with [CARTO](https://carto.com) light basemap
- Species observation markers with photo popups
- eBird cluster markers with hotspot grouping
- Geology overlay (Macrostrat tiles) with click-to-query
- Toggleable environment trend layers (temperature, vegetation, fire)
- Custom area drawing tool (rectangle)
- Fullscreen expand/collapse toggle
- Layer legend control (bottom-left)

---

## Tech stack

- **Backend:** Python 3.11+ / FastAPI
- **Frontend:** Vanilla JavaScript + Tailwind CSS (CDN) + Leaflet.js
- **Deployment:** Docker on Railway (auto-deploys from `master`)
- **No database** — sessions in signed cookies, caches in-memory

## Data sources

| Source | API | Used for |
|---|---|---|
| [Strava](https://www.strava.com) | OAuth2 + REST | Activity routes and GPS coordinates |
| [iNaturalist](https://www.inaturalist.org) | REST | Species observations and photos |
| [GBIF](https://www.gbif.org) | REST | Global biodiversity occurrences |
| [eBird](https://ebird.org) | REST | Recent and notable bird sightings |
| [Xeno-Canto](https://www.xeno-canto.org) | REST | Bird sound recordings |
| [Macrostrat](https://macrostrat.org) | REST + tiles | Rock formations and lithology |
| [Mindat](https://www.mindat.org) | REST | Minerals and localities |
| [Wikipedia](https://en.wikipedia.org) | REST | Geological descriptions and rock types |
| [Google Earth Engine](https://earthengine.google.com) | Python SDK | Satellite data processing and tile generation |
| [Native Land Digital](https://native-land.ca) | REST | Indigenous territories |
| [BigDataCloud](https://www.bigdatacloud.com) | REST | Reverse geocoding (country, state, county) |

## Setup

See [INSTALL.md](INSTALL.md) for local development and deployment instructions.

## License

MIT
