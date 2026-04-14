(function () {
  "use strict";

  // ── State ──
  let routeData = null;
  let leafletMap = null;
  let hullPoly = null;
  let drawnBbox = null;
  let drawnLayer = null;
  let obsClusterGroup = null;
  let allObsMarkers = [];
  let obsVisible = true;
  let filteredSpeciesId = null;
  let allSpeciesData = {};
  let activeTaxa = new Set();
  let selectedCardEl = null;
  let sortMode = "observations";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ── DOM refs ──
  const btnConnect = $("#btn-connect");
  const authConnected = $("#auth-connected");
  const btnLogout = $("#btn-logout");
  const btnFetch = $("#btn-fetch");
  const activityUrl = $("#activity-url");
  const gpxFile = $("#gpx-file");
  const monthSelect = $("#month-select");
  const showSelect = $("#show-select");
  const sortSelect = $("#sort-select");
  const loadingEl = $("#loading");
  const loadingText = $("#loading-text");
  const errorEl = $("#error");
  const errorText = $("#error-text");
  const speciesLoading = $("#species-loading");
  const speciesContainer = $("#species-container");
  const recentEl = $("#recent-activities");
  const activitiesList = $("#activities-list");
  const activitySearch = $("#activity-search");
  const emptyState = $("#empty-state");
  const panelMap = $("#panel-map");
  const routeInfoEl = $("#route-info");
  const routeNameEl = $("#route-name");
  const routeCountry = $("#route-country");
  const territoriesEl = $("#territories");
  const filtersSection = $("#filters-section");
  const taxaSection = $("#taxa-section");
  const taxaFiltersEl = $("#taxa-filters");
  const mobileMapSection = $("#mobile-map-section");

  // ── Taxa Font Awesome icon classes ──
  const TAXA_ICON_CLASSES = {
    Mammalia: "fa-solid fa-paw",
    Aves: "fa-solid fa-dove",
    Reptilia: "fa-solid fa-dragon",
    Actinopterygii: "fa-solid fa-fish",
    Amphibia: "fa-solid fa-frog",
    Plantae: "fa-solid fa-leaf",
    Fungi: "fa-solid fa-disease",
    Insecta: "fa-solid fa-bug",
    Arachnida: "fa-solid fa-spider",
    Mollusca: "fa-solid fa-shrimp",
  };

  const TAXA_LABELS = {
    Mammalia: "Mammals", Reptilia: "Reptiles", Aves: "Birds",
    Actinopterygii: "Fish", Amphibia: "Amphibians", Plantae: "Plants",
    Fungi: "Fungi", Insecta: "Insects", Arachnida: "Arachnids",
    Mollusca: "Mollusks",
  };

  const TAXA_COLORS = {
    Mammalia: "#f97316", Reptilia: "#84cc16", Aves: "#3b82f6",
    Plantae: "#22c55e", Amphibia: "#a855f7", Fungi: "#ec4899",
    Insecta: "#eab308", Arachnida: "#ef4444",
  };

  const CONSERVATION_LABELS = {
    LC: "Least Concern", NT: "Near Threatened", VU: "Vulnerable",
    EN: "Endangered", CR: "Critically Endangered",
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
        pollCacheStatus();
      }
    } catch (_) {}
  }

  let cacheReady = false;
  let searchTimer = null;

  async function pollCacheStatus() {
    activitySearch.placeholder = "Loading activities...";
    activitySearch.disabled = true;
    for (let i = 0; i < 60; i++) {
      try {
        const resp = await fetch("/api/activities/cache-status");
        if (!resp.ok) break;
        const data = await resp.json();
        if (data.ready) {
          cacheReady = true;
          activitySearch.placeholder = `Search ${data.count.toLocaleString()} activities...`;
          activitySearch.disabled = false;
          return;
        }
      } catch (_) {}
      await new Promise(r => setTimeout(r, 2000));
    }
    activitySearch.placeholder = "Search activities...";
    activitySearch.disabled = false;
  }

  async function loadRecentActivities() {
    try {
      const resp = await fetch("/api/activities");
      if (!resp.ok) return;
      const data = await resp.json();
      if (!data.activities || !data.activities.length) return;
      recentEl.classList.remove("hidden");
      renderActivityRows(data.activities);
    } catch (_) {}
  }

  function renderActivityRows(list) {
    activitiesList.innerHTML = "";
    for (const a of list) {
      const d = new Date(a.date);
      const dateStr = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      const row = document.createElement("button");
      row.type = "button";
      row.className = "w-full flex items-center justify-between px-1.5 py-1.5 rounded text-left hover:bg-gray-50 transition-colors group";
      row.innerHTML =
        `<span class="text-[11px] text-gray-600 group-hover:text-gray-900 truncate mr-1">${a.name}</span>` +
        `<span class="text-[9px] text-gray-400 flex-shrink-0">${dateStr}</span>`;
      row.addEventListener("click", () => {
        activityUrl.value = a.url;
        btnFetch.click();
      });
      activitiesList.appendChild(row);
    }
  }

  async function searchActivities(query) {
    if (!query) {
      loadRecentActivities();
      return;
    }
    if (!cacheReady) {
      activitiesList.innerHTML = `<div class="text-[11px] text-gray-400 py-2 text-center">Still loading activities...</div>`;
      return;
    }
    try {
      const resp = await fetch(`/api/activities/search?q=${encodeURIComponent(query)}`);
      if (!resp.ok) return;
      const data = await resp.json();
      const list = data.activities || [];
      if (list.length === 0) {
        activitiesList.innerHTML = `<div class="text-[11px] text-gray-400 py-2 text-center">No matching activities</div>`;
      } else {
        renderActivityRows(list);
      }
    } catch (_) {
      activitiesList.innerHTML = `<div class="text-[11px] text-gray-400 py-2 text-center">Search failed</div>`;
    }
  }

  activitySearch.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = activitySearch.value.trim();
    searchTimer = setTimeout(() => searchActivities(q), 300);
  });

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

  // ── Mobile map ──
  const mobileMapToggle = $("#mobile-map-toggle");
  const mobileMapClose = $("#mobile-map-close");
  if (mobileMapToggle) {
    mobileMapToggle.addEventListener("click", () => {
      panelMap.classList.add("mobile-open");
      if (leafletMap) setTimeout(() => leafletMap.invalidateSize(), 100);
    });
  }
  if (mobileMapClose) {
    mobileMapClose.addEventListener("click", () => {
      panelMap.classList.remove("mobile-open");
    });
  }

  // ── Helpers ──
  function showLoading(msg) {
    loadingText.textContent = msg;
    loadingEl.classList.remove("hidden");
    errorEl.classList.add("hidden");
    emptyState.classList.add("hidden");
  }
  function hideLoading() { loadingEl.classList.add("hidden"); }
  function showError(msg) {
    errorText.textContent = msg;
    errorEl.classList.remove("hidden");
    hideLoading();
  }
  function hideError() { errorEl.classList.add("hidden"); }

  function stripHtml(html) {
    const div = document.createElement("div");
    div.innerHTML = html;
    return div.textContent || div.innerText || "";
  }
  function truncate(text, maxLen) {
    if (!text || text.length <= maxLen) return text;
    return text.slice(0, maxLen).replace(/\s+\S*$/, "") + "\u2026";
  }

  // ── Bbox ──
  function currentBbox() {
    if (drawnBbox) return drawnBbox;
    if (!routeData) return null;
    return routeData.bbox;
  }

  // ── Reactive filters ──
  let filterDebounce = null;
  function onFilterChange() {
    if (!routeData) return;
    clearTimeout(filterDebounce);
    filterDebounce = setTimeout(() => loadSpecies(), 500);
  }

  monthSelect.addEventListener("change", onFilterChange);
  showSelect.addEventListener("change", () => renderSpeciesCards());
  sortSelect.addEventListener("change", () => {
    sortMode = sortSelect.value;
    renderSpeciesCards();
  });

  // ── Fetch Strava Activity ──
  btnFetch.addEventListener("click", async () => {
    const url = activityUrl.value.trim();
    if (!url) return;
    hideError();
    showLoading("Fetching route from Strava...");

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
      drawnBbox = null;
      drawnLayer = null;
      monthSelect.value = routeData.month || 0;
      await showResults();
    } catch (e) { showError(e.message); }
  });

  // ── GPX Upload ──
  gpxFile.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    hideError();
    showLoading("Processing GPX...");

    const formData = new FormData();
    formData.append("file", file);

    try {
      const resp = await fetch("/api/gpx", { method: "POST", body: formData });
      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.detail || "Failed to process GPX");
      }
      routeData = await resp.json();
      drawnBbox = null;
      drawnLayer = null;
      monthSelect.value = 0;
      await showResults();
    } catch (e) { showError(e.message); }
  });

  // ── Show Results ──
  async function showResults() {
    hideLoading();
    emptyState.classList.add("hidden");

    // Show bars immediately
    const infoBar = $("#route-info-bar");
    infoBar.classList.remove("hidden");
    $("#route-name-top").textContent = routeData.name;

    filtersSection.classList.remove("hidden");

    // Sidebar sections
    routeInfoEl.classList.remove("hidden");
    taxaSection.classList.remove("hidden");
    mobileMapSection.classList.remove("hidden");
    routeNameEl.textContent = routeData.name;

    renderMap(routeData.coords, routeData.bbox);
    fetchTerritories(routeData.bbox);
    loadSpecies();
  }

  // ── Territories ──
  async function fetchTerritories(bbox) {
    territoriesEl.innerHTML = '<span class="text-gray-300" style="font-size:9px">Loading territories...</span>';
    routeCountry.textContent = "";
    const countryTop = $("#route-country-top");
    const terrTop = $("#territories-top");
    try {
      const resp = await fetch("/api/territories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bbox }),
      });
      const data = await resp.json();
      if (data.country) {
        routeCountry.textContent = data.country;
        if (countryTop) countryTop.textContent = data.country;
      }
      if (data.territories && data.territories.length) {
        const links = data.territories
          .map((t) => `<a href="${t.url}" target="_blank" class="territory-link">${t.name}</a>`)
          .join(" ");
        territoriesEl.innerHTML = links;
        if (terrTop) terrTop.innerHTML = links;
      } else {
        territoriesEl.innerHTML = "";
        if (terrTop) terrTop.innerHTML = "";
      }
    } catch (_) {
      territoriesEl.innerHTML = "";
      if (terrTop) terrTop.innerHTML = "";
    }
  }

  // ── Taxa filter rendering ──
  let allTaxaKeys = [];

  function renderTaxaFilters(speciesByTaxa) {
    taxaFiltersEl.innerHTML = "";
    allTaxaKeys = Object.keys(speciesByTaxa).filter((t) => speciesByTaxa[t].length > 0);
    activeTaxa = new Set(allTaxaKeys);

    // "All" button
    const allBtn = document.createElement("div");
    allBtn.className = "taxa-toggle active";
    allBtn.dataset.taxa = "__all__";
    allBtn.innerHTML = `
      <span class="taxa-toggle-icon" style="color:#374151"><svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path fill-rule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clip-rule="evenodd"/></svg></span>
      <span class="taxa-toggle-label">All</span>
      <span class="taxa-toggle-count">${allTaxaKeys.reduce((sum, t) => sum + speciesByTaxa[t].length, 0)}</span>
    `;
    allBtn.addEventListener("click", () => {
      activeTaxa = new Set(allTaxaKeys);
      updateTaxaToggleStyles();
      renderSpeciesCards();
    });
    taxaFiltersEl.appendChild(allBtn);

    for (const taxa of allTaxaKeys) {
      const count = speciesByTaxa[taxa].length;

      const toggle = document.createElement("div");
      toggle.className = "taxa-toggle";
      toggle.dataset.taxa = taxa;
      toggle.innerHTML = `
        <span class="taxa-toggle-icon"><i class="${TAXA_ICON_CLASSES[taxa] || 'fa-solid fa-circle'}"></i></span>
        <span class="taxa-toggle-label">${TAXA_LABELS[taxa] || taxa}</span>
        <span class="taxa-toggle-count">${count}</span>
      `;
      toggle.addEventListener("click", () => {
        const isOnlyActive = activeTaxa.size === 1 && activeTaxa.has(taxa);
        if (isOnlyActive) {
          activeTaxa = new Set(allTaxaKeys);
        } else {
          activeTaxa = new Set([taxa]);
        }
        updateTaxaToggleStyles();
        renderSpeciesCards();
      });
      taxaFiltersEl.appendChild(toggle);
    }
  }

  function updateTaxaToggleStyles() {
    const showingAll = activeTaxa.size === allTaxaKeys.length;
    taxaFiltersEl.querySelectorAll(".taxa-toggle").forEach((el) => {
      const t = el.dataset.taxa;
      if (t === "__all__") {
        el.classList.toggle("active", showingAll);
      } else {
        el.classList.toggle("active", activeTaxa.has(t));
        el.classList.toggle("off", !activeTaxa.has(t));
      }
    });
  }

  // ── Species loading ──
  function pointInHull(lat, lng, hull) {
    if (!hull || hull.length < 3) return true;
    let inside = false;
    for (let i = 0, j = hull.length - 1; i < hull.length; j = i++) {
      const [latI, lngI] = hull[i];
      const [latJ, lngJ] = hull[j];
      if ((latI > lat) !== (latJ > lat) &&
          lng < (lngJ - lngI) * (lat - latI) / (latJ - latI) + lngI) {
        inside = !inside;
      }
    }
    return inside;
  }

  async function loadSpecies() {
    if (!routeData) return;
    hideError();
    speciesLoading.classList.remove("hidden");
    speciesContainer.innerHTML = "";

    const month = parseInt(monthSelect.value, 10);
    const bbox = currentBbox();
    const hull = (!drawnBbox && routeData.hull) ? routeData.hull : null;

    try {
      const resp = await fetch("/api/species", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bbox, month, hull }),
      });
      if (!resp.ok) throw new Error("Failed to load species data");
      const data = await resp.json();
      speciesLoading.classList.add("hidden");
      allSpeciesData = data.species;
      renderTaxaFilters(allSpeciesData);
      renderSpeciesCards();
      loadObservations(bbox, month);
    } catch (e) {
      speciesLoading.classList.add("hidden");
      showError(e.message);
    }
  }

  // ── Species card rendering (flat filtered list) ──
  function renderSpeciesCards() {
    speciesContainer.innerHTML = "";
    selectedCardEl = null;

    let allSpecies = [];
    for (const [taxa, species] of Object.entries(allSpeciesData)) {
      if (!activeTaxa.has(taxa)) continue;
      for (const sp of species) {
        allSpecies.push({ ...sp, taxa });
      }
    }

    // Always sort by observations first for the limit, then re-sort if needed
    allSpecies.sort((a, b) => b.observations - a.observations);

    const showMode = showSelect.value;
    if (showMode === "top10") {
      allSpecies = allSpecies.slice(0, 10);
    } else if (showMode === "top25") {
      allSpecies = allSpecies.slice(0, 25);
    }

    if (sortMode === "name") {
      allSpecies.sort((a, b) => (a.common_name || a.name).localeCompare(b.common_name || b.name));
    }

    if (allSpecies.length === 0) {
      speciesContainer.innerHTML = '<div class="panel-message"><span class="text-xs text-gray-300">No species found for current filters.</span></div>';
      return;
    }

    for (const sp of allSpecies) {
      const card = document.createElement("div");
      card.className = "species-card";
      card.dataset.taxonId = sp.id || "";

      const conservationBadge = sp.conservation_code
        ? `<span class="conservation-badge ${sp.conservation_code.toLowerCase()}" title="${CONSERVATION_LABELS[sp.conservation_code] || sp.conservation_status}">${sp.conservation_code}</span>`
        : "";

      const summaryText = sp.wikipedia_summary ? truncate(stripHtml(sp.wikipedia_summary), 120) : "";
      const tooltip = summaryText
        ? `<div class="species-tooltip"><p>${summaryText}</p></div>`
        : "";

      card.innerHTML = `
        ${sp.photo_url ? `<img class="species-card-img" src="${sp.photo_url}" alt="${sp.common_name || sp.name}" loading="lazy">` : '<div class="species-card-img"></div>'}
        <div class="species-card-body">
          <div class="common-name">${sp.common_name || sp.name}</div>
          ${sp.common_name ? `<div class="sci-name">${sp.name}</div>` : ""}
        </div>
        <div class="species-card-footer">
          <span class="obs-count">${sp.observations.toLocaleString()} obs${conservationBadge}</span>
          <a href="${sp.url}" target="_blank" class="inat-link" title="View on iNaturalist" onclick="event.stopPropagation()">
            <svg viewBox="0 0 20 20" fill="currentColor" width="12" height="12"><path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z"/><path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z"/></svg>
          </a>
        </div>
        ${tooltip}
      `;

      card.addEventListener("click", () => {
        if (selectedCardEl) selectedCardEl.classList.remove("selected");
        card.classList.add("selected");
        selectedCardEl = card;
        if (sp.id) {
          focusSpeciesOnMap(sp.id);
          if (window.innerWidth <= 768) {
            panelMap.classList.add("mobile-open");
            setTimeout(() => leafletMap && leafletMap.invalidateSize(), 100);
          }
        }
      });

      speciesContainer.appendChild(card);
    }
  }

  // ── Map ──
  function renderMap(coords, bbox) {
    if (leafletMap) { leafletMap.remove(); leafletMap = null; }
    hullPoly = null;
    obsClusterGroup = null;
    allObsMarkers = [];

    leafletMap = L.map("map", { zoomControl: true, scrollWheelZoom: true });

    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
      maxZoom: 19,
    }).addTo(leafletMap);

    L.polyline(coords, { color: "#111827", weight: 2.5, opacity: 0.8 }).addTo(leafletMap);

    const hull = routeData.hull;
    if (hull && hull.length >= 3) {
      hullPoly = L.polygon(hull, {
        color: "#6b7280", weight: 1, opacity: 0.4, fillOpacity: 0.04, dashArray: "4 4",
      }).addTo(leafletMap);
      leafletMap.fitBounds(hullPoly.getBounds(), { padding: [30, 30] });
    } else {
      const bounds = [[bbox[0], bbox[1]], [bbox[2], bbox[3]]];
      leafletMap.fitBounds(bounds, { padding: [30, 30] });
    }

    // Draw controls
    const drawnItems = new L.FeatureGroup();
    leafletMap.addLayer(drawnItems);

    const drawControl = new L.Control.Draw({
      position: "topright",
      draw: {
        polyline: false, polygon: false, circle: false,
        circlemarker: false, marker: false,
        rectangle: {
          shapeOptions: { color: "#ef4444", weight: 2, fillOpacity: 0.08, dashArray: "6 4" },
        },
      },
      edit: { featureGroup: drawnItems, remove: true },
    });
    leafletMap.addControl(drawControl);

    leafletMap.on(L.Draw.Event.CREATED, (e) => {
      if (drawnLayer) drawnItems.removeLayer(drawnLayer);
      drawnLayer = e.layer;
      drawnItems.addLayer(drawnLayer);

      const b = drawnLayer.getBounds();
      drawnBbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
      loadSpecies();
    });

    leafletMap.on(L.Draw.Event.DELETED, () => {
      drawnBbox = null;
      drawnLayer = null;
      loadSpecies();
    });

    // Observation controls
    const ObsControls = L.Control.extend({
      options: { position: "bottomright" },
      onAdd: function () {
        const container = L.DomUtil.create("div", "obs-controls");
        L.DomEvent.disableClickPropagation(container);

        const toggleBtn = L.DomUtil.create("button", "obs-toggle-btn", container);
        toggleBtn.innerHTML = "Hide obs";
        toggleBtn.addEventListener("click", () => {
          if (!obsClusterGroup) return;
          obsVisible = !obsVisible;
          if (obsVisible) {
            leafletMap.addLayer(obsClusterGroup);
            toggleBtn.innerHTML = "Hide obs";
          } else {
            leafletMap.removeLayer(obsClusterGroup);
            toggleBtn.innerHTML = "Show obs";
          }
        });

        const clearBtn = L.DomUtil.create("button", "obs-toggle-btn obs-clear-filter-btn hidden", container);
        clearBtn.innerHTML = "All species";
        clearBtn.addEventListener("click", () => {
          showAllMarkers();
          if (hullPoly) leafletMap.fitBounds(hullPoly.getBounds(), { padding: [30, 30] });
          if (selectedCardEl) { selectedCardEl.classList.remove("selected"); selectedCardEl = null; }
        });

        return container;
      },
    });
    new ObsControls().addTo(leafletMap);
  }

  function makeMarkerIcon(taxa) {
    const iconClass = TAXA_ICON_CLASSES[taxa] || "fa-solid fa-circle";
    return L.divIcon({
      className: "obs-marker",
      html: `<div class="obs-marker-dot"><i class="${iconClass}"></i></div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
  }

  function buildMarker(obs) {
    const marker = L.marker([obs.lat, obs.lng], { icon: makeMarkerIcon(obs.taxa) });
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
          ${obs.observer ? `<div class="obs-popup-meta">@${obs.observer}</div>` : ""}
          <a href="${obs.obs_url}" target="_blank" class="obs-popup-link">iNaturalist &rarr;</a>
        </div>
      </div>`;
    marker.bindPopup(popupHtml, { maxWidth: 260, className: "obs-popup-container" });
    return marker;
  }

  function showAllMarkers() {
    if (!leafletMap) return;
    if (obsClusterGroup) leafletMap.removeLayer(obsClusterGroup);

    obsClusterGroup = L.markerClusterGroup({
      maxClusterRadius: 40, spiderfyOnMaxZoom: true, showCoverageOnHover: false,
    });
    for (const m of allObsMarkers) obsClusterGroup.addLayer(m);
    leafletMap.addLayer(obsClusterGroup);
    obsVisible = true;
    filteredSpeciesId = null;

    const toggleBtn = document.querySelector(".obs-toggle-btn");
    if (toggleBtn) toggleBtn.innerHTML = "Hide obs";
    const clearBtn = document.querySelector(".obs-clear-filter-btn");
    if (clearBtn) clearBtn.classList.add("hidden");
  }

  async function loadObservations(bbox, month) {
    if (obsClusterGroup && leafletMap) leafletMap.removeLayer(obsClusterGroup);
    allObsMarkers = [];
    filteredSpeciesId = null;

    try {
      const resp = await fetch("/api/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bbox, month, hull: routeData.hull || null }),
      });
      if (!resp.ok) return;
      const data = await resp.json();
      for (const obs of data.observations) allObsMarkers.push(buildMarker(obs));
      showAllMarkers();
    } catch (_) {}
  }

  async function focusSpeciesOnMap(taxonId) {
    if (!leafletMap || !routeData) return;

    const bbox = currentBbox();
    const month = parseInt(monthSelect.value, 10);

    if (obsClusterGroup) leafletMap.removeLayer(obsClusterGroup);
    obsClusterGroup = L.markerClusterGroup({
      maxClusterRadius: 40, spiderfyOnMaxZoom: true, showCoverageOnHover: false,
    });

    try {
      const resp = await fetch("/api/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bbox, month, taxon_id: taxonId, hull: routeData.hull || null }),
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
      if (toggleBtn) toggleBtn.innerHTML = "Hide obs";
      const clearBtn = document.querySelector(".obs-clear-filter-btn");
      if (clearBtn) clearBtn.classList.remove("hidden");

      const group = L.featureGroup(markers);
      leafletMap.fitBounds(group.getBounds(), { padding: [40, 40], maxZoom: 16 });
      setTimeout(() => markers[0].openPopup(), 400);
    } catch (_) {}
  }

  // ── Init ──
  checkAuth();
})();
