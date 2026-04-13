(function () {
  "use strict";

  // ── State ──
  let routeData = null;
  let leafletMap = null;
  let bboxRect = null;
  let obsClusterGroup = null;
  let obsMarkersById = {};
  let allObsMarkers = [];
  let obsVisible = true;
  let filteredSpeciesId = null;

  // ── DOM refs ──
  const $  = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const btnConnect      = $("#btn-connect");
  const authConnected   = $("#auth-connected");
  const btnLogout       = $("#btn-logout");
  const btnFetch        = $("#btn-fetch");
  const activityUrl     = $("#activity-url");
  const gpxFile         = $("#gpx-file");
  const btnSpecies      = $("#btn-species");
  const monthSelect     = $("#month-select");
  const loadingEl       = $("#loading");
  const loadingText     = $("#loading-text");
  const errorEl         = $("#error");
  const errorText       = $("#error-text");
  const resultsEl       = $("#results");
  const routeNameEl     = $("#route-name");
  const routeCountry    = $("#route-country");
  const territoriesEl   = $("#territories");
  const speciesLoading  = $("#species-loading");
  const speciesContainer = $("#species-container");
  const recentEl        = $("#recent-activities");
  const activitiesList  = $("#activities-list");

  // Taxa color palette
  const TAXA_COLORS = {
    Mammalia:  "#f97316",
    Reptilia:  "#84cc16",
    Aves:      "#3b82f6",
    Plantae:   "#22c55e",
    Amphibia:  "#a855f7",
    Fungi:     "#ec4899",
    Insecta:   "#eab308",
    Arachnida: "#ef4444",
  };

  const TAXA_LABELS = {
    Mammalia: "Mammals",
    Reptilia: "Reptiles",
    Aves: "Birds",
    Plantae: "Plants",
    Amphibia: "Amphibians",
    Fungi: "Fungi",
    Insecta: "Insects",
    Arachnida: "Arachnids",
  };

  // ── Auth ──
  async function checkAuth() {
    try {
      const resp = await fetch("/auth/status");
      const data = await resp.json();
      if (data.authenticated) {
        btnConnect.classList.add("hidden");
        authConnected.classList.remove("hidden");
        authConnected.classList.add("flex");
        loadRecentActivities();
      }
    } catch (_) {}
  }

  async function loadRecentActivities() {
    try {
      const resp = await fetch("/api/activities");
      if (!resp.ok) return;
      const data = await resp.json();
      if (!data.activities || !data.activities.length) return;

      recentEl.classList.remove("hidden");
      activitiesList.innerHTML = "";

      for (const a of data.activities) {
        const d = new Date(a.date);
        const dateStr = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        const row = document.createElement("button");
        row.type = "button";
        row.className =
          "w-full flex flex-col sm:flex-row sm:items-center sm:justify-between px-3 py-2.5 rounded-lg text-left " +
          "hover:bg-gray-50 transition-colors group min-h-[44px]";
        row.innerHTML =
          `<span class="text-sm text-gray-700 group-hover:text-gray-900">${a.name}</span>` +
          `<span class="flex items-center gap-3 text-xs text-gray-400 mt-0.5 sm:mt-0">` +
          `<span>${a.type}</span>` +
          `<span>${a.distance_km} km</span>` +
          `<span>${dateStr}</span>` +
          `</span>`;
        row.addEventListener("click", () => {
          activityUrl.value = a.url;
          btnFetch.click();
        });
        activitiesList.appendChild(row);
      }
    } catch (_) {}
  }

  btnLogout.addEventListener("click", async () => {
    await fetch("/auth/logout", { method: "POST" });
    location.reload();
  });

  const params = new URLSearchParams(location.search);
  if (params.get("auth") === "success") {
    history.replaceState({}, "", "/");
  } else if (params.get("auth") === "error") {
    showError("Strava authorization failed. Please try again.");
    history.replaceState({}, "", "/");
  }

  // ── Tabs ──
  $$(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      $$(".tab-panel").forEach((p) => p.classList.add("hidden"));
      $(`#tab-${btn.dataset.tab}`).classList.remove("hidden");
    });
  });

  // ── Helpers ──
  function showLoading(msg) {
    loadingText.textContent = msg;
    loadingEl.classList.remove("hidden");
    errorEl.classList.add("hidden");
  }
  function hideLoading() { loadingEl.classList.add("hidden"); }
  function showError(msg) {
    errorText.textContent = msg;
    errorEl.classList.remove("hidden");
    hideLoading();
  }
  function hideError() { errorEl.classList.add("hidden"); }

  // ── Fetch Strava Activity ──
  btnFetch.addEventListener("click", async () => {
    const url = activityUrl.value.trim();
    if (!url) return;
    hideError();
    showLoading("Fetching route data from Strava...");
    resultsEl.classList.add("hidden");

    try {
      const resp = await fetch("/api/activity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.detail || "Failed to fetch activity");
      }
      routeData = await resp.json();
      monthSelect.value = routeData.month || 0;
      await showResults();
    } catch (e) { showError(e.message); }
  });

  // ── GPX Upload ──
  gpxFile.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    hideError();
    showLoading("Processing GPX file...");
    resultsEl.classList.add("hidden");

    const formData = new FormData();
    formData.append("file", file);

    try {
      const resp = await fetch("/api/gpx", { method: "POST", body: formData });
      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.detail || "Failed to process GPX");
      }
      routeData = await resp.json();
      monthSelect.value = 0;
      await showResults();
    } catch (e) { showError(e.message); }
  });

  // ── Show Results ──
  async function showResults() {
    hideLoading();
    resultsEl.classList.remove("hidden");
    routeNameEl.textContent = routeData.name;
    speciesContainer.innerHTML = "";

    renderMap(routeData.coords, routeData.bbox);
    fetchTerritories(routeData.bbox);
  }

  // ── Territories ──
  async function fetchTerritories(bbox) {
    territoriesEl.innerHTML = '<span class="text-gray-300 text-xs">Loading territories...</span>';
    routeCountry.textContent = "";
    try {
      const resp = await fetch("/api/territories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bbox }),
      });
      const data = await resp.json();
      if (data.country) routeCountry.textContent = data.country;
      if (data.territories && data.territories.length) {
        territoriesEl.innerHTML =
          '<span class="text-xs text-gray-400 mr-1">Indigenous territories:</span>' +
          data.territories
            .map((t) => `<a href="${t.url}" target="_blank" class="territory-link">${t.name}</a>`)
            .join("");
      } else {
        territoriesEl.innerHTML = "";
      }
    } catch (_) {
      territoriesEl.innerHTML = '<span class="text-xs text-gray-300">Could not load territory data</span>';
    }
  }

  // ── Bbox helpers ──
  const bufferRange = $("#buffer-range");
  const bufferLabel = $("#buffer-label");

  function adjustedBbox(bbox, bufferPct) {
    const dlat = (bbox[2] - bbox[0]) * bufferPct / 100;
    const dlng = (bbox[3] - bbox[1]) * bufferPct / 100;
    return [bbox[0] + dlat, bbox[1] + dlng, bbox[2] - dlat, bbox[3] - dlng];
  }

  function currentBbox() {
    if (!routeData) return null;
    return adjustedBbox(routeData.bbox, parseFloat(bufferRange.value));
  }

  function updateBboxRect() {
    const bbox = currentBbox();
    if (!bbox || !leafletMap) return;
    if (bboxRect) bboxRect.setBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]]);
  }

  bufferRange.addEventListener("input", () => {
    const v = parseInt(bufferRange.value, 10);
    bufferLabel.textContent = (v > 0 ? "+" : "") + v + "%";
    updateBboxRect();
  });

  // ── Map ──
  function renderMap(coords, bbox) {
    const mapEl = $("#map");
    if (leafletMap) { leafletMap.remove(); leafletMap = null; }
    bboxRect = null;
    obsClusterGroup = null;
    obsMarkersById = {};
    bufferRange.value = 0;
    bufferLabel.textContent = "0%";

    leafletMap = L.map(mapEl, { zoomControl: true, scrollWheelZoom: true });

    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
      maxZoom: 19,
    }).addTo(leafletMap);

    L.polyline(coords, { color: "#111827", weight: 2.5, opacity: 0.8 }).addTo(leafletMap);

    const bounds = [[bbox[0], bbox[1]], [bbox[2], bbox[3]]];
    bboxRect = L.rectangle(bounds, {
      color: "#ef4444", weight: 1.5, opacity: 0.5, fillOpacity: 0.04, dashArray: "6 4",
    }).addTo(leafletMap);

    leafletMap.fitBounds(bounds, { padding: [30, 30] });

    // Observation map controls
    const ObsControls = L.Control.extend({
      options: { position: "topright" },
      onAdd: function () {
        const container = L.DomUtil.create("div", "obs-controls");
        L.DomEvent.disableClickPropagation(container);

        const toggleBtn = L.DomUtil.create("button", "obs-toggle-btn", container);
        toggleBtn.innerHTML = "Hide observations";
        toggleBtn.title = "Toggle observation markers";
        toggleBtn.addEventListener("click", () => {
          if (!obsClusterGroup) return;
          obsVisible = !obsVisible;
          if (obsVisible) {
            leafletMap.addLayer(obsClusterGroup);
            toggleBtn.innerHTML = "Hide observations";
          } else {
            leafletMap.removeLayer(obsClusterGroup);
            toggleBtn.innerHTML = "Show observations";
          }
        });

        const clearBtn = L.DomUtil.create("button", "obs-toggle-btn obs-clear-filter-btn hidden", container);
        clearBtn.innerHTML = "Show all species";
        clearBtn.title = "Clear species filter";
        clearBtn.addEventListener("click", () => {
          showAllMarkers();
          if (bboxRect) {
            leafletMap.fitBounds(bboxRect.getBounds(), { padding: [30, 30] });
          }
        });

        return container;
      },
    });
    new ObsControls().addTo(leafletMap);
  }

  // ── Observation markers ──
  function makeMarkerIcon(taxa) {
    const color = TAXA_COLORS[taxa] || "#6b7280";
    return L.divIcon({
      className: "obs-marker",
      html: `<div style="background:${color};width:12px;height:12px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.3)"></div>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6],
    });
  }

  function buildMarker(obs) {
    const marker = L.marker([obs.lat, obs.lng], {
      icon: makeMarkerIcon(obs.taxa),
    });

    const dateStr = obs.date
      ? new Date(obs.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : "";

    const popupHtml = `
      <div class="obs-popup">
        ${obs.photo_url ? `<img src="${obs.photo_url}" alt="${obs.common_name || obs.species_name}">` : ""}
        <div class="obs-popup-info">
          <a href="${obs.obs_url}" target="_blank" class="obs-popup-name">${obs.common_name || obs.species_name}</a>
          ${obs.common_name && obs.species_name ? `<div class="obs-popup-sci">${obs.species_name}</div>` : ""}
          ${dateStr ? `<div class="obs-popup-meta">${dateStr}</div>` : ""}
          ${obs.observer ? `<div class="obs-popup-meta">by @${obs.observer}</div>` : ""}
          <a href="${obs.obs_url}" target="_blank" class="obs-popup-link">View on iNaturalist &rarr;</a>
        </div>
      </div>`;
    marker.bindPopup(popupHtml, { maxWidth: 280, className: "obs-popup-container" });
    return marker;
  }

  function showAllMarkers() {
    if (!leafletMap) return;
    if (obsClusterGroup) leafletMap.removeLayer(obsClusterGroup);

    obsClusterGroup = L.markerClusterGroup({
      maxClusterRadius: 40,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
    });

    for (const m of allObsMarkers) obsClusterGroup.addLayer(m);
    leafletMap.addLayer(obsClusterGroup);
    obsVisible = true;
    filteredSpeciesId = null;

    const toggleBtn = document.querySelector(".obs-toggle-btn");
    if (toggleBtn) toggleBtn.innerHTML = "Hide observations";

    const clearBtn = document.querySelector(".obs-clear-filter-btn");
    if (clearBtn) clearBtn.classList.add("hidden");
  }

  async function loadObservations(bbox, month) {
    if (obsClusterGroup && leafletMap) {
      leafletMap.removeLayer(obsClusterGroup);
    }
    obsMarkersById = {};
    allObsMarkers = [];
    filteredSpeciesId = null;

    try {
      const resp = await fetch("/api/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bbox, month }),
      });
      if (!resp.ok) return;
      const data = await resp.json();

      for (const obs of data.observations) {
        const marker = buildMarker(obs);
        const key = obs.taxon_id || obs.species_name;
        if (!obsMarkersById[key]) obsMarkersById[key] = [];
        obsMarkersById[key].push(marker);
        allObsMarkers.push(marker);
      }

      showAllMarkers();
    } catch (_) {}
  }

  async function focusSpeciesOnMap(taxonId) {
    if (!leafletMap || !routeData) return;

    const bbox = currentBbox();
    const month = parseInt(monthSelect.value, 10);

    if (obsClusterGroup) leafletMap.removeLayer(obsClusterGroup);

    obsClusterGroup = L.markerClusterGroup({
      maxClusterRadius: 40,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
    });

    try {
      const resp = await fetch("/api/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bbox, month, taxon_id: taxonId }),
      });
      if (!resp.ok) return;
      const data = await resp.json();

      if (!data.observations.length) return;

      const markers = [];
      for (const obs of data.observations) {
        const marker = buildMarker(obs);
        obsClusterGroup.addLayer(marker);
        markers.push(marker);
      }

      leafletMap.addLayer(obsClusterGroup);
      obsVisible = true;
      filteredSpeciesId = taxonId;

      const toggleBtn = document.querySelector(".obs-toggle-btn");
      if (toggleBtn) toggleBtn.innerHTML = "Hide observations";

      const clearBtn = document.querySelector(".obs-clear-filter-btn");
      if (clearBtn) clearBtn.classList.remove("hidden");

      const group = L.featureGroup(markers);
      leafletMap.fitBounds(group.getBounds(), { padding: [60, 60], maxZoom: 16 });

      setTimeout(() => { markers[0].openPopup(); }, 400);
    } catch (_) {}
  }

  // ── Species ──
  btnSpecies.addEventListener("click", async () => {
    if (!routeData) return;
    hideError();
    speciesLoading.classList.remove("hidden");
    speciesContainer.innerHTML = "";

    const month = parseInt(monthSelect.value, 10);
    const bbox = currentBbox();

    try {
      const resp = await fetch("/api/species", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bbox, month }),
      });
      if (!resp.ok) throw new Error("Failed to load species data");
      const data = await resp.json();
      speciesLoading.classList.add("hidden");
      renderSpecies(data.species);

      loadObservations(bbox, month);
    } catch (e) {
      speciesLoading.classList.add("hidden");
      showError(e.message);
    }
  });

  function renderSpecies(speciesByTaxa) {
    speciesContainer.innerHTML = "";

    for (const [taxa, species] of Object.entries(speciesByTaxa)) {
      if (!species.length) continue;

      const section = document.createElement("div");
      section.className = "taxa-section open";

      const color = TAXA_COLORS[taxa] || "#6b7280";

      const header = document.createElement("div");
      header.className = "taxa-header";
      header.innerHTML = `
        <svg class="taxa-chevron" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clip-rule="evenodd" />
        </svg>
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};flex-shrink:0"></span>
        <h3>${TAXA_LABELS[taxa] || taxa}</h3>
        <span class="count">${species.length}</span>
      `;

      const grid = document.createElement("div");
      grid.className = "taxa-grid";

      for (const sp of species) {
        const card = document.createElement("div");
        card.className = "species-card";
        card.innerHTML = `
          <a href="${sp.url}" target="_blank" rel="noopener">
            ${sp.photo_url ? `<img src="${sp.photo_url}" alt="${sp.common_name || sp.name}" loading="lazy">` : '<div style="aspect-ratio:1;background:#f3f4f6"></div>'}
            <div class="info">
              <div class="common-name">${sp.common_name || sp.name}</div>
              ${sp.common_name ? `<div class="sci-name">${sp.name}</div>` : ""}
              <div class="obs-count">${sp.observations.toLocaleString()} observations</div>
            </div>
          </a>
        `;

        if (sp.id) {
          const mapBtn = document.createElement("button");
          mapBtn.type = "button";
          mapBtn.className = "map-link-btn";
          mapBtn.title = "Show on map";
          mapBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="currentColor" width="12" height="12"><path fill-rule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clip-rule="evenodd"/></svg> Show on map`;
          mapBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            focusSpeciesOnMap(sp.id);
            $("#map").scrollIntoView({ behavior: "smooth", block: "center" });
          });
          card.querySelector(".info").appendChild(mapBtn);
        }

        grid.appendChild(card);
      }

      header.addEventListener("click", () => {
        section.classList.toggle("open");
        grid.classList.toggle("collapsed");
      });

      section.appendChild(header);
      section.appendChild(grid);
      speciesContainer.appendChild(section);
    }
  }

  // ── Init ──
  checkAuth();
})();
