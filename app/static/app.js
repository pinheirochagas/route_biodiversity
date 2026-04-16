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
  let gbifSpeciesData = {};
  let activeTaxa = new Set();
  let selectedCardEl = null;
  let sortMode = "observations";
  let gbifEnabled = true;
  let ebirdEnabled = true;
  let ebirdSpeciesData = {};
  let allEbirdObservations = [];
  let ebirdClusterGroup = null;
  let ebirdMarkers = [];
  let expandedBboxPoly = null;
  let geologyEnabled = true;
  let geologyData = [];
  let geologyTileLayer = null;
  let activeGeoClass = null;
  let routeLocation = { city: "", state: "", country: "", county: "" };
  let allSourcesDone = false;
  let routePolyline = null;
  let situateBboxRect = null;
  let drawnItems = null;
  let currentBirdsongAudio = null;
  let currentBirdsongBtn = null;

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
  const mobileTaxaRow = $("#mobile-taxa-row");
  const mobileFetchToggle = $("#mobile-fetch-toggle");
  const sourcesSection = $("#sources-section");
  const ebirdBackSelect = $("#ebird-back");
  const bboxExpandSelect = $("#bbox-expand");
  let geoOverlayCb = null;

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

  const btnLoadMore = $("#btn-load-more");
  const activitiesRange = $("#activities-range");

  function updateActivitiesLabel(months, count) {
    if (activitiesRange) activitiesRange.textContent = `(${months} mo)`;
    if (count !== undefined) activitySearch.placeholder = `Search ${count.toLocaleString()} activities...`;
    if (btnLoadMore) btnLoadMore.classList.remove("hidden");
  }

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
          updateActivitiesLabel(data.months || 6, data.count);
          activitySearch.disabled = false;
          return;
        }
      } catch (_) {}
      await new Promise(r => setTimeout(r, 2000));
    }
    activitySearch.placeholder = "Search activities...";
    activitySearch.disabled = false;
  }

  if (btnLoadMore) {
    btnLoadMore.addEventListener("click", async () => {
      btnLoadMore.disabled = true;
      btnLoadMore.textContent = "Loading...";
      try {
        const resp = await fetch("/api/activities/load-more", { method: "POST" });
        if (resp.ok) {
          const data = await resp.json();
          const months = data.months || 12;
          updateActivitiesLabel(months, (data.activities || []).length);
          renderActivityRows(data.activities || []);
          btnLoadMore.textContent = `Load 6 more months`;
        } else {
          btnLoadMore.textContent = "Load 6 more months";
        }
      } catch (_) {
        btnLoadMore.textContent = "Load 6 more months";
      }
      btnLoadMore.disabled = false;
    });
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
      const loc = a.location ? `<span class="text-[9px] text-gray-400 truncate block">${a.location}</span>` : "";
      row.innerHTML =
        `<div class="truncate mr-1 flex-1 min-w-0"><span class="text-[11px] text-gray-600 group-hover:text-gray-900 truncate block">${a.name}</span>${loc}</div>` +
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

  // ── Mode tabs (Activities / Situate) ──
  $$(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".mode-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      $$(".mode-panel").forEach((p) => p.classList.add("hidden"));
      $(`#mode-${btn.dataset.mode}`).classList.remove("hidden");
    });
  });

  // ── Strava/GPX sub-tabs ──
  $$("#mode-activities .tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$("#mode-activities .tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      $$("#mode-activities .tab-panel").forEach((p) => p.classList.add("hidden"));
      $(`#tab-${btn.dataset.tab}`).classList.remove("hidden");
    });
  });

  // ── Mobile sidebar dropdown ──
  let mobileBackdrop = null;

  function closeMobileSidebar() {
    const sidebar = $("#sidebar");
    sidebar.classList.remove("mobile-expanded");
    mobileFetchToggle.classList.remove("open");
    if (mobileBackdrop) { mobileBackdrop.remove(); mobileBackdrop = null; }
  }

  function openMobileSidebar() {
    const sidebar = $("#sidebar");
    sidebar.classList.add("mobile-expanded");
    mobileFetchToggle.classList.add("open");
    if (!mobileBackdrop) {
      mobileBackdrop = document.createElement("div");
      mobileBackdrop.className = "mobile-sidebar-backdrop";
      mobileBackdrop.addEventListener("click", closeMobileSidebar);
      document.body.appendChild(mobileBackdrop);
    }
  }

  if (mobileFetchToggle) {
    mobileFetchToggle.addEventListener("click", () => {
      const sidebar = $("#sidebar");
      if (sidebar.classList.contains("mobile-expanded")) {
        closeMobileSidebar();
      } else {
        openMobileSidebar();
      }
    });
  }

  const mobileSidebarClose = $("#mobile-sidebar-close");
  if (mobileSidebarClose) {
    mobileSidebarClose.addEventListener("click", closeMobileSidebar);
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
  function expandBbox(bbox, pct) {
    if (!pct || !bbox) return bbox;
    const latSpan = bbox[2] - bbox[0];
    const lngSpan = bbox[3] - bbox[1];
    const dLat = (latSpan * pct) / 100 / 2;
    const dLng = (lngSpan * pct) / 100 / 2;
    return [bbox[0] - dLat, bbox[1] - dLng, bbox[2] + dLat, bbox[3] + dLng];
  }

  function currentBbox() {
    if (drawnBbox) return drawnBbox;
    if (!routeData) return null;
    const pct = bboxExpandSelect ? parseInt(bboxExpandSelect.value, 10) : 0;
    return expandBbox(routeData.bbox, pct);
  }

  function currentHull() {
    if (drawnBbox) return null;
    if (!routeData || !routeData.hull) return null;
    const pct = bboxExpandSelect ? parseInt(bboxExpandSelect.value, 10) : 0;
    return pct === 0 ? routeData.hull : null;
  }

  function ebirdDistFromBbox() {
    const bbox = currentBbox();
    if (!bbox) return 25;
    const latMid = (bbox[0] + bbox[2]) / 2;
    const latKm = (bbox[2] - bbox[0]) * 111;
    const lngKm = (bbox[3] - bbox[1]) * 111 * Math.cos((latMid * Math.PI) / 180);
    const diag = Math.sqrt(latKm * latKm + lngKm * lngKm);
    return Math.min(10, Math.max(2, Math.round(diag / 2)));
  }

  // ── Reactive filters ──
  let filterDebounce = null;
  function onFilterChange() {
    if (!routeData) return;
    clearTimeout(filterDebounce);
    filterDebounce = setTimeout(() => loadAllSpecies(), 500);
  }

  monthSelect.addEventListener("change", onFilterChange);
  showSelect.addEventListener("change", () => renderSpeciesCards());
  sortSelect.addEventListener("change", () => {
    sortMode = sortSelect.value;
    renderSpeciesCards();
  });

  // ── Data source toggles (show/hide filters) ──
  let inatEnabled = true;

  function initSourceToggles() {
    const toggles = $$("#source-toggles .taxa-toggle");
    toggles.forEach((el) => {
      el.addEventListener("click", () => {
        const source = el.dataset.source;
        if (source === "inat") {
          inatEnabled = !inatEnabled;
          el.classList.toggle("active", inatEnabled);
          el.classList.toggle("off", !inatEnabled);
        } else if (source === "gbif") {
          gbifEnabled = !gbifEnabled;
          el.classList.toggle("active", gbifEnabled);
          el.classList.toggle("off", !gbifEnabled);
        } else if (source === "ebird") {
          ebirdEnabled = !ebirdEnabled;
          el.classList.toggle("active", ebirdEnabled);
          el.classList.toggle("off", !ebirdEnabled);
          if (ebirdEnabled) {
            renderEbirdMarkers(allEbirdObservations);
          } else if (ebirdClusterGroup && leafletMap) {
            leafletMap.removeLayer(ebirdClusterGroup);
          }
        } else if (source === "geology") {
          geologyEnabled = !geologyEnabled;
          el.classList.toggle("active", geologyEnabled);
          el.classList.toggle("off", !geologyEnabled);
          toggleGeologyLayer();
          renderGeologyInfo(geologyData);
          return;
        }
        const merged = getMergedSpeciesData();
        renderTaxaFilters(merged);
        renderSpeciesCards();
      });
    });
  }

  // ── eBird time-range filter handler ──
  if (ebirdBackSelect) {
    ebirdBackSelect.addEventListener("change", (e) => {
      e.stopPropagation();
      if (routeData) reloadEbird();
    });
  }

  // ── Bbox expansion handler ──
  if (bboxExpandSelect) {
    bboxExpandSelect.addEventListener("change", () => {
      if (!routeData) return;
      drawExpandedBbox();
      loadAllSpecies();
    });
  }

  // ── Fetch Strava Activity ──
  btnFetch.addEventListener("click", async () => {
    const url = activityUrl.value.trim();
    if (!url) return;
    hideError();
    closeMobileSidebar();
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
    closeMobileSidebar();
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

  // ── Situate (geolocation) ──
  const btnSituate = $("#btn-situate");
  if (btnSituate) {
    btnSituate.addEventListener("click", () => {
      if (!navigator.geolocation) {
        showError("Geolocation is not supported by your browser.");
        return;
      }
      btnSituate.disabled = true;
      hideError();
      closeMobileSidebar();
      showLoading("Getting your location...");

      navigator.geolocation.getCurrentPosition(
        (position) => {
          const lat = position.coords.latitude;
          const lng = position.coords.longitude;
          const latDelta = 0.0225;
          const lngDelta = 0.0225 / Math.cos((lat * Math.PI) / 180);

          routeData = {
            name: "My Location",
            coords: [[lat, lng]],
            bbox: [lat - latDelta, lng - lngDelta, lat + latDelta, lng + lngDelta],
            hull: null,
            month: 0,
            date: new Date().toISOString(),
            situateMe: true,
          };

          drawnBbox = null;
          drawnLayer = null;
          monthSelect.value = 0;
          btnSituate.disabled = false;
          showResults();
        },
        (error) => {
          const lat = 37.7749;
          const lng = -122.4194;
          const latDelta = 0.0225;
          const lngDelta = 0.0225 / Math.cos((lat * Math.PI) / 180);

          routeData = {
            name: "San Francisco (default)",
            coords: [[lat, lng]],
            bbox: [lat - latDelta, lng - lngDelta, lat + latDelta, lng + lngDelta],
            hull: null,
            month: 0,
            date: new Date().toISOString(),
            situateMe: true,
          };

          drawnBbox = null;
          drawnLayer = null;
          monthSelect.value = 0;
          btnSituate.disabled = false;
          showResults();
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });
  }

  // ── Situate (location search with autocomplete) ──
  const situateSearchInput = $("#situate-search");
  const btnSituateSearch = $("#btn-situate-search");
  const suggestionsEl = $("#situate-suggestions");
  let suggestDebounce = null;
  let activeSuggestion = -1;
  let currentSuggestions = [];

  function hideSuggestions() {
    if (suggestionsEl) { suggestionsEl.classList.add("hidden"); suggestionsEl.innerHTML = ""; }
    activeSuggestion = -1;
    currentSuggestions = [];
  }

  function showSuggestions(results) {
    if (!suggestionsEl || !results.length) { hideSuggestions(); return; }
    currentSuggestions = results;
    activeSuggestion = -1;
    suggestionsEl.innerHTML = "";
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const parts = r.display_name.split(",");
      const primary = parts[0].trim();
      const rest = parts.slice(1).map(s => s.trim()).filter(Boolean);
      const country = rest.length ? rest[rest.length - 1] : "";
      const mid = rest.slice(0, -1).join(", ");
      const secondary = [mid, country].filter(Boolean).join(", ");
      const li = document.createElement("li");
      li.innerHTML = `<b>${primary}</b>${secondary ? ", " + secondary : ""}`;
      li.addEventListener("click", () => selectSuggestion(r));
      suggestionsEl.appendChild(li);
    }
    suggestionsEl.classList.remove("hidden");
  }

  function updateActiveSuggestionStyle() {
    if (!suggestionsEl) return;
    const items = suggestionsEl.querySelectorAll("li");
    items.forEach((li, i) => li.classList.toggle("active", i === activeSuggestion));
    if (activeSuggestion >= 0 && items[activeSuggestion]) {
      items[activeSuggestion].scrollIntoView({ block: "nearest" });
    }
  }

  function selectSuggestion(place) {
    hideSuggestions();
    const lat = parseFloat(place.lat);
    const lng = parseFloat(place.lon);
    const displayName = place.display_name.split(",")[0].trim();
    if (situateSearchInput) situateSearchInput.value = displayName;
    launchSituate(lat, lng, displayName);
  }

  function launchSituate(lat, lng, name) {
    hideError();
    closeMobileSidebar();
    showLoading(`Loading ${name}...`);
    const latDelta = 0.0225;
    const lngDelta = 0.0225 / Math.cos((lat * Math.PI) / 180);
    routeData = {
      name: name,
      coords: [[lat, lng]],
      bbox: [lat - latDelta, lng - lngDelta, lat + latDelta, lng + lngDelta],
      hull: null,
      month: 0,
      date: new Date().toISOString(),
      situateMe: true,
    };
    drawnBbox = null;
    drawnLayer = null;
    monthSelect.value = 0;
    showResults();
  }

  async function fetchSuggestions(query) {
    try {
      const resp = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5&addressdetails=0`,
        { headers: { "Accept": "application/json" } }
      );
      return await resp.json();
    } catch { return []; }
  }

  async function searchLocation() {
    const query = (situateSearchInput ? situateSearchInput.value.trim() : "");
    if (!query) return;
    hideSuggestions();
    showLoading(`Searching "${query}"...`);
    const results = await fetchSuggestions(query);
    if (!results || !results.length) {
      hideLoading();
      showError(`No results found for "${query}".`);
      return;
    }
    selectSuggestion(results[0]);
  }

  if (situateSearchInput) {
    situateSearchInput.addEventListener("input", () => {
      clearTimeout(suggestDebounce);
      const q = situateSearchInput.value.trim();
      if (q.length < 2) { hideSuggestions(); return; }
      suggestDebounce = setTimeout(async () => {
        const results = await fetchSuggestions(q);
        if (situateSearchInput.value.trim() === q) showSuggestions(results);
      }, 300);
    });

    situateSearchInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (currentSuggestions.length) {
          activeSuggestion = Math.min(activeSuggestion + 1, currentSuggestions.length - 1);
          updateActiveSuggestionStyle();
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (currentSuggestions.length) {
          activeSuggestion = Math.max(activeSuggestion - 1, 0);
          updateActiveSuggestionStyle();
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (activeSuggestion >= 0 && currentSuggestions[activeSuggestion]) {
          selectSuggestion(currentSuggestions[activeSuggestion]);
        } else {
          searchLocation();
        }
      } else if (e.key === "Escape") {
        hideSuggestions();
      }
    });

    situateSearchInput.addEventListener("blur", () => {
      setTimeout(hideSuggestions, 200);
    });
  }

  if (btnSituateSearch) {
    btnSituateSearch.addEventListener("click", searchLocation);
  }

  // ── Show Results ──
  async function showResults() {
    hideLoading();
    emptyState.classList.add("hidden");

    const infoBar = $("#route-info-bar");
    infoBar.classList.remove("hidden");

    filtersSection.classList.remove("hidden");

    routeInfoEl.classList.remove("hidden");
    taxaSection.classList.remove("hidden");
    routeNameEl.textContent = routeData.name;
    routeCountry.textContent = "";
    const sep = $("#route-loc-sep");
    if (sep) sep.classList.add("hidden");

    const geologyInfoEl = $("#geology-info");
    if (geologyInfoEl) geologyInfoEl.innerHTML = "";
    const geologyGalleryEl = $("#geology-gallery");
    if (geologyGalleryEl) { geologyGalleryEl.classList.add("hidden"); geologyGalleryEl.innerHTML = ""; }
    geologyGalleryOpen = false;
    const routeDateEl = $("#route-date");
    if (routeDateEl) {
      if (routeData.situateMe) {
        routeDateEl.textContent = "";
      } else if (routeData.date) {
        const d = new Date(routeData.date);
        routeDateEl.textContent = d.toLocaleDateString("en-US", {
          weekday: "short", month: "short", day: "numeric", year: "numeric",
          hour: "numeric", minute: "2-digit",
        });
      } else {
        routeDateEl.textContent = "";
      }
    }

    // Show data source section
    if (sourcesSection) sourcesSection.classList.remove("hidden");

    // All sources enabled by default
    inatEnabled = true;
    gbifEnabled = true;
    ebirdEnabled = true;
    geologyEnabled = true;
    gbifSpeciesData = {};
    ebirdSpeciesData = {};
    allEbirdObservations = [];
    geologyData = [];
    activeGeoClass = null;

    for (const src of ["inat", "gbif", "ebird", "geology"]) {
      const toggle = $(`[data-source="${src}"]`);
      if (toggle) { toggle.classList.add("active"); toggle.classList.remove("off"); }
    }
    if (bboxExpandSelect) bboxExpandSelect.value = "0";
    if (ebirdBackSelect) ebirdBackSelect.value = "30";

    document.body.classList.add("route-loaded");
    closeMobileSidebar();
    renderMobileSources();
    setTimeout(() => { if (leafletMap) leafletMap.invalidateSize(); }, 200);

    routeLocation = { city: "", state: "", country: "", county: "" };

    renderMap(routeData.coords, routeData.bbox);
    const locationReady = fetchTerritories(routeData.bbox);
    loadAllSpecies(locationReady);
  }

  function renderMobileSources() {
    const row = $("#mobile-sources-row");
    if (!row) return;
    row.style.display = "";
    row.innerHTML = "";

    const sources = [
      { key: "inat", label: "iNat", icon: "fa-binoculars", color: "#74ac00" },
      { key: "gbif", label: "GBIF", icon: "fa-database", color: "#8b5cf6" },
      { key: "ebird", label: "eBird", icon: "fa-dove", color: "#3b82f6" },
      { key: "geology", label: "Geology", icon: "fa-mountain", color: "#a3724e" },
    ];
    for (const s of sources) {
      const pill = document.createElement("span");
      pill.className = "mobile-taxa-pill active";
      pill.dataset.source = s.key;
      pill.innerHTML = `<i class="fa-solid ${s.icon}" style="color:${s.color}"></i> ${s.label}`;
      pill.addEventListener("click", () => {
        if (s.key === "inat") { inatEnabled = !inatEnabled; pill.classList.toggle("active", inatEnabled); }
        else if (s.key === "gbif") { gbifEnabled = !gbifEnabled; pill.classList.toggle("active", gbifEnabled); }
        else if (s.key === "ebird") {
          ebirdEnabled = !ebirdEnabled;
          pill.classList.toggle("active", ebirdEnabled);
          if (ebirdEnabled) renderEbirdMarkers(allEbirdObservations);
          else if (ebirdClusterGroup && leafletMap) leafletMap.removeLayer(ebirdClusterGroup);
        } else if (s.key === "geology") {
          geologyEnabled = !geologyEnabled;
          pill.classList.toggle("active", geologyEnabled);
          toggleGeologyLayer();
          renderGeologyInfo(geologyData);
        }
        const dtoggle = $(`[data-source="${s.key}"]`);
        if (dtoggle) { dtoggle.classList.toggle("active"); dtoggle.classList.toggle("off"); }
        if (s.key !== "geology") {
          const merged = getMergedSpeciesData();
          renderTaxaFilters(merged);
          renderSpeciesCards();
        }
      });
      row.appendChild(pill);
    }

    const ebirdSel = document.createElement("select");
    ebirdSel.className = "filter-select";
    ebirdSel.style.fontSize = "10px";
    ebirdSel.innerHTML = `<option value="7">7d</option><option value="14">14d</option><option value="30" selected>30d</option><option value="all">All time</option>`;
    ebirdSel.addEventListener("change", () => {
      if (ebirdBackSelect) ebirdBackSelect.value = ebirdSel.value;
      if (routeData) reloadEbird();
    });
    row.appendChild(ebirdSel);

    const bboxSel = document.createElement("select");
    bboxSel.className = "filter-select";
    bboxSel.style.fontSize = "10px";
    bboxSel.innerHTML = `<option value="0" selected>Route only</option><option value="25">+25%</option><option value="50">+50%</option><option value="100">+100%</option><option value="200">+200%</option>`;
    bboxSel.addEventListener("change", () => {
      if (bboxExpandSelect) bboxExpandSelect.value = bboxSel.value;
      if (!routeData) return;
      drawExpandedBbox();
      loadAllSpecies();
    });
    row.appendChild(bboxSel);
  }

  // ── Territories ──
  async function fetchTerritories(bbox) {
    territoriesEl.innerHTML = '<span class="text-gray-300" style="font-size:9px">Loading territories...</span>';
    try {
      const resp = await fetch("/api/territories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bbox }),
      });
      const data = await resp.json();
      if (data.location) {
        const loc = data.location;
        routeLocation = { city: loc.city || "", state: loc.state || "", country: loc.country || "", county: loc.county || "" };
        const parts = [loc.city, loc.state, loc.country].filter(Boolean);
        const locStr = parts.join(", ");
        if (routeData && routeData.situateMe) {
          routeNameEl.textContent = locStr || "My Location";
          routeCountry.textContent = "";
        } else {
          routeCountry.textContent = locStr;
          const sep = $("#route-loc-sep");
          if (sep && locStr) sep.classList.remove("hidden");
        }
      }
      const nativeLandUrl = `https://native-land.ca/maps?position=${((bbox[0]+bbox[2])/2).toFixed(4)},${((bbox[1]+bbox[3])/2).toFixed(4)},11`;
      if (data.territories && data.territories.length) {
        const links = data.territories
          .map((t) => `<a href="${t.url}" target="_blank" class="territory-link">${t.name}</a>`)
          .join(" ");
        const prefix = '<span style="font-size:10px;color:#6b7280;font-weight:500">Native Land: </span>';
        territoriesEl.innerHTML = prefix + links;
      } else {
        const fallback = `<a href="${nativeLandUrl}" target="_blank" class="territory-link">Explore on Native Land &rarr;</a>`;
        territoriesEl.innerHTML = fallback;
      }
    } catch (_) {
      territoriesEl.innerHTML = "";
    }
  }

  // ── Taxa filter rendering ──
  let allTaxaKeys = [];

  function handleTaxaClick(taxa) {
    if (taxa === "__all__") {
      activeTaxa = new Set(allTaxaKeys);
    } else {
      const isOnlyActive = activeTaxa.size === 1 && activeTaxa.has(taxa);
      activeTaxa = isOnlyActive ? new Set(allTaxaKeys) : new Set([taxa]);
    }
    updateTaxaToggleStyles();
    renderSpeciesCards();
  }

  function renderTaxaFilters(mergedSpecies) {
    taxaFiltersEl.innerHTML = "";
    mobileTaxaRow.innerHTML = "";
    allTaxaKeys = Object.keys(mergedSpecies).filter((t) => mergedSpecies[t].length > 0);
    activeTaxa = new Set(allTaxaKeys);

    const totalCount = allTaxaKeys.reduce((sum, t) => sum + mergedSpecies[t].length, 0);

    const allBtn = document.createElement("div");
    allBtn.className = "taxa-toggle active";
    allBtn.dataset.taxa = "__all__";
    allBtn.innerHTML = `
      <span class="taxa-toggle-icon" style="color:#374151"><svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path fill-rule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clip-rule="evenodd"/></svg></span>
      <span class="taxa-toggle-label">All</span>
      <span class="taxa-toggle-count">${totalCount}</span>
    `;
    allBtn.addEventListener("click", () => handleTaxaClick("__all__"));
    taxaFiltersEl.appendChild(allBtn);

    const mAllPill = document.createElement("span");
    mAllPill.className = "mobile-taxa-pill active";
    mAllPill.dataset.taxa = "__all__";
    mAllPill.textContent = `All (${totalCount})`;
    mAllPill.addEventListener("click", () => handleTaxaClick("__all__"));
    mobileTaxaRow.appendChild(mAllPill);

    for (const taxa of allTaxaKeys) {
      const count = mergedSpecies[taxa].length;
      const iconClass = TAXA_ICON_CLASSES[taxa] || "fa-solid fa-circle";
      const label = TAXA_LABELS[taxa] || taxa;

      const toggle = document.createElement("div");
      toggle.className = "taxa-toggle";
      toggle.dataset.taxa = taxa;
      toggle.innerHTML = `
        <span class="taxa-toggle-icon"><i class="${iconClass}"></i></span>
        <span class="taxa-toggle-label">${label}</span>
        <span class="taxa-toggle-count">${count}</span>
      `;
      toggle.addEventListener("click", () => handleTaxaClick(taxa));
      taxaFiltersEl.appendChild(toggle);

      const pill = document.createElement("span");
      pill.className = "mobile-taxa-pill";
      pill.dataset.taxa = taxa;
      pill.innerHTML = `<i class="${iconClass}"></i> ${label}`;
      pill.addEventListener("click", () => handleTaxaClick(taxa));
      mobileTaxaRow.appendChild(pill);
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

    mobileTaxaRow.querySelectorAll(".mobile-taxa-pill").forEach((el) => {
      const t = el.dataset.taxa;
      if (t === "__all__") {
        el.classList.toggle("active", showingAll);
      } else {
        el.classList.toggle("active", activeTaxa.has(t));
        el.classList.toggle("off", !activeTaxa.has(t));
      }
    });
  }

  // ── Merge iNat + GBIF + eBird species data ──
  function getMergedSpeciesData() {
    const merged = {};

    function mergeInto(taxa, sp, sourceTag) {
      if (!merged[taxa]) merged[taxa] = [];
      const existing = merged[taxa].find(
        (s) => s.name && sp.name && s.name.toLowerCase() === sp.name.toLowerCase()
      );
      if (existing) {
        existing.observations += sp.observations || 0;
        if (!existing.sources.includes(sourceTag)) existing.sources.push(sourceTag);
        if (sp.notable && !existing.sources.includes("notable")) existing.sources.push("notable");
        if (!existing.photo_url && sp.photo_url) existing.photo_url = sp.photo_url;
        if (!existing.common_name && sp.common_name) existing.common_name = sp.common_name;
        if (!existing.url && sp.url) existing.url = sp.url;
        if (!existing.species_code && sp.species_code) existing.species_code = sp.species_code;
      } else {
        const sources = [sourceTag];
        if (sp.notable) sources.push("notable");
        merged[taxa].push({ ...sp, sources });
      }
    }

    if (inatEnabled) {
      for (const [taxa, species] of Object.entries(allSpeciesData)) {
        for (const sp of species) mergeInto(taxa, sp, "inat");
      }
    }

    if (gbifEnabled && gbifSpeciesData) {
      for (const [taxa, gbifList] of Object.entries(gbifSpeciesData)) {
        for (const gsp of gbifList) mergeInto(taxa, gsp, "gbif");
      }
    }

    if (ebirdEnabled && ebirdSpeciesData) {
      for (const [taxa, ebirdList] of Object.entries(ebirdSpeciesData)) {
        for (const esp of ebirdList) mergeInto(taxa, esp, "ebird");
      }
    }

    return merged;
  }

  // ── Fetch eBird data and transform to species card format ──
  async function fetchEbirdData() {
    if (!routeData) return { species: {}, observations: [] };

    const backVal = ebirdBackSelect ? ebirdBackSelect.value : "14";
    const distKm = ebirdDistFromBbox();
    const isHistorical = backVal === "all";
    const headers = { "Content-Type": "application/json" };

    let observations = [];

    if (isHistorical) {
      const bbox = currentBbox();
      const hull = currentHull();
      const resp = await fetch("/api/ebird/historical", {
        method: "POST", headers,
        body: JSON.stringify({ bbox, hull }),
      });
      if (resp.ok) {
        const data = await resp.json();
        observations = (data.species || []).map((s) => ({
          common_name: s.common_name, scientific_name: s.scientific_name,
          count: s.count, date: s.date, location_name: s.location_name,
          lat: s.lat, lng: s.lng, notable: false,
          photo_url: s.photo_url || "", species_code: s.species_code || "",
        }));
      }
    } else {
      const backDays = parseInt(backVal, 10);
      const useHull = currentHull() !== null;
      const body = JSON.stringify({ coords: routeData.coords, dist_km: distKm, back_days: backDays, use_hull: useHull });
      const [recentResp, notableResp] = await Promise.all([
        fetch("/api/ebird/recent", { method: "POST", headers, body }),
        fetch("/api/ebird/notable", { method: "POST", headers, body }),
      ]);

      const recentData = recentResp.ok ? await recentResp.json() : { observations: [] };
      const notableData = notableResp.ok ? await notableResp.json() : { observations: [] };

      if (recentData.error) return { species: {}, observations: [], error: recentData.error };

      const notableSet = new Set(
        (notableData.observations || []).map((o) => `${o.scientific_name}:${o.date}:${o.lat}`)
      );
      observations = (recentData.observations || []).map((o) => ({
        ...o, notable: notableSet.has(`${o.scientific_name}:${o.date}:${o.lat}`),
      }));
      for (const o of (notableData.observations || [])) {
        const exists = observations.some(
          (e) => e.scientific_name === o.scientific_name && e.date === o.date && e.lat === o.lat
        );
        if (!exists) observations.push({ ...o, notable: true });
      }
    }

    const speciesMap = {};
    for (const obs of observations) {
      const key = obs.scientific_name || obs.common_name;
      if (!key) continue;
      if (!speciesMap[key]) {
        speciesMap[key] = {
          id: `ebird-${obs.species_code || key.replace(/\s+/g, "-")}`,
          name: obs.scientific_name,
          common_name: obs.common_name,
          observations: obs.count || 1,
          photo_url: obs.photo_url || "",
          url: obs.species_code ? `https://ebird.org/species/${obs.species_code}` : "https://ebird.org",
          notable: obs.notable || false,
          species_code: obs.species_code || "",
        };
      } else {
        if ((obs.count || 0) > speciesMap[key].observations) speciesMap[key].observations = obs.count;
        if (obs.notable) speciesMap[key].notable = true;
        if (!speciesMap[key].photo_url && obs.photo_url) speciesMap[key].photo_url = obs.photo_url;
      }
    }

    return { species: { Aves: Object.values(speciesMap) }, observations };
  }

  // ── Reload only eBird data (when eBird filters change) ──
  async function reloadEbird() {
    if (!routeData) return;
    const ebirdCountEl = $("#ebird-count");
    if (ebirdCountEl) ebirdCountEl.textContent = "...";

    try {
      const ebirdResult = await fetchEbirdData();
      ebirdSpeciesData = ebirdResult.species;
      allEbirdObservations = ebirdResult.observations;

      let ebirdTotal = 0;
      for (const list of Object.values(ebirdSpeciesData)) ebirdTotal += list.length;
      if (ebirdCountEl) ebirdCountEl.textContent = ebirdTotal;

      renderEbirdMarkers(allEbirdObservations);
      const merged = getMergedSpeciesData();
      renderTaxaFilters(merged);
      renderSpeciesCards();
    } catch (_) {
      if (ebirdCountEl) ebirdCountEl.textContent = "err";
    }
  }

  // ── Geology rendering ──
  const GEO_CLASS_LABELS = { igneous: "Igneous", sedimentary: "Sedimentary", metamorphic: "Metamorphic", mineral: "Mineral", other: "Other" };
  const GEO_CLASS_ICONS = { igneous: "fa-fire", sedimentary: "fa-layer-group", metamorphic: "fa-diamond", mineral: "fa-gem", other: "fa-circle" };
  const GEO_CLASS_COLORS = { igneous: "#c0392b", sedimentary: "#d4a017", metamorphic: "#7d5a50", mineral: "#4338ca", other: "#6b7280" };
  const GEO_CLASS_ORDER = ["igneous", "sedimentary", "metamorphic", "mineral", "other"];

  function getGeologyGroups(formations) {
    const groups = {};
    for (const f of formations) {
      if (f.all_terms && f.all_terms.length) {
        for (const t of f.all_terms) {
          const cls = t["class"] || "other";
          if (!groups[cls]) groups[cls] = new Set();
          if (t.term) groups[cls].add(t.term);
        }
      } else {
        const cls = f.lith_class || "other";
        if (!groups[cls]) groups[cls] = new Set();
        if (f.lith_term) groups[cls].add(f.lith_term);
      }
    }
    return groups;
  }

  function handleGeoClassClick(cls) {
    const gallery = $("#geology-gallery");
    if (cls === "__all__") {
      activeGeoClass = null;
      geologyGalleryOpen = !geologyGalleryOpen;
      if (gallery) gallery.classList.toggle("hidden", !geologyGalleryOpen);
      if (geologyGalleryOpen) renderGeologyGallery(geologyData);
      const allPill = gallery && gallery.parentElement && gallery.parentElement.querySelector('.geo-class-pill[data-cls="__all__"]');
      if (allPill) allPill.classList.toggle("active", geologyGalleryOpen);
      return;
    }
    activeGeoClass = activeGeoClass === cls ? null : cls;
    updateGeoClassStyles();
    if (!geologyGalleryOpen) {
      geologyGalleryOpen = true;
      if (gallery) gallery.classList.remove("hidden");
    }
    renderGeologyGallery(geologyData);
  }

  function updateGeoClassStyles() {
    const pills = $$("#geology-info .geo-class-pill");
    pills.forEach((el) => {
      const cls = el.dataset.cls;
      if (cls === "__all__") {
        el.classList.toggle("active", geologyGalleryOpen && activeGeoClass === null);
      } else {
        el.classList.toggle("active", activeGeoClass === cls);
        el.classList.toggle("off", activeGeoClass !== null && activeGeoClass !== cls);
      }
    });
  }

  function renderGeologyInfo(formations) {
    const el = $("#geology-info");
    if (!el) return;
    if (!geologyEnabled || !formations || !formations.length) {
      el.innerHTML = "";
      return;
    }

    const groups = getGeologyGroups(formations);
    let totalCount = 0;
    for (const cls of GEO_CLASS_ORDER) {
      if (groups[cls]) totalCount += groups[cls].size;
    }

    let html = '<div class="geo-class-filters">';
    html += `<span class="geo-class-pill" data-cls="__all__"><i class="fa-solid fa-mountain"></i> Geomaterials <span class="geo-pill-count">${totalCount}</span></span>`;

    for (const cls of GEO_CLASS_ORDER) {
      if (!groups[cls] || groups[cls].size === 0) continue;
      const count = groups[cls].size;
      html += `<span class="geo-class-pill" data-cls="${cls}" style="--geo-color:${GEO_CLASS_COLORS[cls]}"><i class="fa-solid ${GEO_CLASS_ICONS[cls]}"></i> ${GEO_CLASS_LABELS[cls]} <span class="geo-pill-count">${count}</span></span>`;
    }
    html += "</div>";
    el.innerHTML = html;

    el.querySelectorAll(".geo-class-pill").forEach((pill) => {
      pill.addEventListener("click", (e) => {
        e.stopPropagation();
        handleGeoClassClick(pill.dataset.cls);
      });
    });
  }

  let geologyGalleryOpen = false;

  function toggleGeologyGallery() {
    const gallery = $("#geology-gallery");
    if (!gallery) return;
    geologyGalleryOpen = !geologyGalleryOpen;
    gallery.classList.toggle("hidden", !geologyGalleryOpen);
    if (geologyGalleryOpen) renderGeologyGallery(geologyData);
  }

  function renderGeologyGallery(formations) {
    const gallery = $("#geology-gallery");
    if (!gallery || !formations || !formations.length) return;
    gallery.innerHTML = "";

    const seen = new Set();
    const rocks = [];
    for (const f of formations) {
      const src = f.source || "macrostrat";
      if (f.all_terms && f.all_terms.length) {
        for (const t of f.all_terms) {
          const key = t.term.toLowerCase();
          if (key && !seen.has(key)) {
            seen.add(key);
            rocks.push({
              term: t.term,
              lith_class: t["class"] || "",
              formation: f.name,
              age: f.age || "",
              color: f.color,
              photo_url: t.photo_url || f.photo_url || "",
              wiki_url: t.wiki_url || f.wiki_url || "",
              lat: f.lat,
              lng: f.lng,
              source: t.source || src,
              mindat_id: t.mindat_id || f.mindat_id || null,
            });
          }
        }
      } else if (f.lith_term) {
        const key = f.lith_term.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          rocks.push({
            term: f.lith_term,
            lith_class: f.lith_class || "",
            formation: f.name,
            age: f.age || "",
            color: f.color,
            photo_url: f.photo_url || "",
            wiki_url: f.wiki_url || "",
            lat: f.lat,
            lng: f.lng,
            source: src,
            mindat_id: f.mindat_id || null,
          });
        }
      }
    }

    const filtered = activeGeoClass
      ? rocks.filter((r) => (r.lith_class || "other") === activeGeoClass)
      : rocks;

    if (!filtered.length) {
      gallery.innerHTML = '<div style="padding:12px;color:#9ca3af;font-size:11px;text-align:center">No rocks in this category</div>';
      return;
    }

    for (const r of filtered) {
      const card = document.createElement("div");
      card.className = "geology-card";
      const clsColor = GEO_CLASS_COLORS[r.lith_class] || "#6b7280";
      const clsLabel = r.lith_class ? r.lith_class.charAt(0).toUpperCase() + r.lith_class.slice(1) : "";
      const macroUrl = `https://macrostrat.org/map/loc/${r.lng.toFixed(4)}/${r.lat.toFixed(4)}`;

      const isWiki = r.source === "wikipedia";
      const isMindat = r.source === "mindat";
      const srcBadge = isMindat
        ? '<span class="source-badge mindat" title="From Mindat" style="background:#2d6a4f;color:#fff">m</span>'
        : isWiki
        ? '<span class="source-badge wiki" title="From Wikipedia">W</span>'
        : '<span class="source-badge macro" title="From Macrostrat">M</span>';

      const mindatUrl = r.mindat_id ? `https://www.mindat.org/min-${r.mindat_id}.html` : "";

      card.innerHTML = `
        ${r.photo_url ? `<img class="geology-card-img" src="${r.photo_url}" alt="${r.term}" loading="lazy">` : '<div class="geology-card-img"></div>'}
        <div class="geology-card-body">
          ${clsLabel ? `<div class="rock-class" style="color:${clsColor}">${clsLabel} ${srcBadge}</div>` : srcBadge}
          <div class="rock-name" style="border-left:3px solid ${r.color};padding-left:5px">${r.term}</div>
          ${r.formation && !isWiki && !isMindat ? `<div class="rock-formation">${r.formation}</div>` : ""}
          ${r.age ? `<div class="rock-age">${r.age}</div>` : ""}
        </div>
        <div class="geology-card-footer">
          ${r.wiki_url ? `<a href="${r.wiki_url}" target="_blank">Wikipedia &rarr;</a>` : "<span></span>"}
          ${mindatUrl ? `<a href="${mindatUrl}" target="_blank">Mindat &rarr;</a>` : ""}
          ${!isWiki && !isMindat ? `<a href="${macroUrl}" target="_blank">Macrostrat &rarr;</a>` : ""}
        </div>`;

      card.addEventListener("click", (e) => {
        if (e.target.closest("a")) return;
        if (leafletMap) leafletMap.flyTo([r.lat, r.lng], 15);
      });
      gallery.appendChild(card);
    }
  }

  const geoInfoEl = $("#geology-info");

  function toggleGeologyLayer() {
    if (!leafletMap || !geologyTileLayer) return;
    const showOverlay = geologyEnabled && geoOverlayCb && geoOverlayCb.checked;
    if (showOverlay && !leafletMap.hasLayer(geologyTileLayer)) {
      geologyTileLayer.addTo(leafletMap);
    } else if (!showOverlay && leafletMap.hasLayer(geologyTileLayer)) {
      leafletMap.removeLayer(geologyTileLayer);
    }
  }


  function _buildGeologyPopup(f) {
    const ageRange = (f.b_age > 0) ? `${f.t_age}–${f.b_age} Ma` : "";
    const photoHtml = f.photo_url
      ? `<img src="${f.photo_url}" style="width:100%;max-height:120px;object-fit:cover;border-radius:4px;margin-bottom:4px" alt="${f.lith_term || f.name}">`
      : "";
    const wikiLink = f.wiki_url
      ? `<a href="${f.wiki_url}" target="_blank" style="font-size:10px;color:#3b82f6;margin-right:8px">${f.lith_term || "Wikipedia"} &rarr;</a>`
      : "";
    const classLabel = f.lith_class ? `<span style="font-size:9px;font-weight:600;text-transform:uppercase;color:#6b7280;letter-spacing:0.5px">${f.lith_class}</span>` : "";
    const allRocks = (f.all_terms && f.all_terms.length)
      ? f.all_terms.map((t) => t.term).filter(Boolean).join(", ")
      : f.lith_term || "";
    return `<div style="max-width:240px">
      ${photoHtml}
      ${classLabel}
      <div style="font-weight:600;font-size:12px;margin-bottom:2px;border-left:4px solid ${f.color};padding-left:6px">${f.name}</div>
      <div style="font-size:10px;color:#6b7280">${[allRocks, f.age, ageRange].filter(Boolean).join(" · ")}</div>
      ${f.descrip ? `<div style="font-size:10px;color:#9ca3af;margin-top:4px">${f.descrip.slice(0, 200)}${f.descrip.length > 200 ? "..." : ""}</div>` : ""}
      <div style="margin-top:4px">
        ${wikiLink}
        <a href="https://macrostrat.org/map/loc/${f.lng.toFixed(4)}/${f.lat.toFixed(4)}" target="_blank" style="font-size:10px;color:#3b82f6">Macrostrat &rarr;</a>
      </div>
    </div>`;
  }

  async function handleGeologyMapClick(e) {
    if (!geologyEnabled || !geologyTileLayer || !leafletMap.hasLayer(geologyTileLayer)) return;
    const { lat, lng } = e.latlng;
    const popup = L.popup({ maxWidth: 280 })
      .setLatLng(e.latlng)
      .setContent('<div style="font-size:11px;color:#9ca3af;padding:4px">Loading geology...</div>')
      .openOn(leafletMap);
    try {
      const resp = await fetch("/api/geology/point", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat, lng }),
      });
      if (!resp.ok) { popup.remove(); return; }
      const data = await resp.json();
      const formations = data.formations || [];
      if (!formations.length) {
        popup.setContent('<div style="font-size:11px;color:#9ca3af;padding:4px">No geological data at this point</div>');
        return;
      }
      const html = formations.slice(0, 3).map((f) => _buildGeologyPopup(f)).join('<hr style="margin:6px 0;border:none;border-top:1px solid #e5e7eb">');
      popup.setContent(html);
    } catch (_) {
      popup.remove();
    }
  }

  // ── Species loading (all sources in parallel, each independent) ──
  async function loadAllSpecies(locationReady) {
    if (!routeData) return;
    hideError();
    speciesLoading.classList.remove("hidden");
    speciesContainer.innerHTML = "";

    allSpeciesData = {};
    gbifSpeciesData = {};
    ebirdSpeciesData = {};
    allEbirdObservations = [];
    geologyData = [];
    activeGeoClass = null;
    allSourcesDone = false;
    let sourcesFinished = 0;
    const totalSources = 3;

    const month = parseInt(monthSelect.value, 10);
    const bbox = currentBbox();
    const hull = currentHull();

    const inatCountEl = $("#inat-count");
    const gbifCountEl = $("#gbif-count");
    const ebirdCountEl = $("#ebird-count");
    const geologyCountEl = $("#geology-count");
    if (inatCountEl) inatCountEl.textContent = "...";
    if (gbifCountEl) gbifCountEl.textContent = "...";
    if (ebirdCountEl) ebirdCountEl.textContent = "...";
    if (geologyCountEl) geologyCountEl.textContent = "...";

    const reqBody = JSON.stringify({ bbox, month, hull });
    const reqHeaders = { "Content-Type": "application/json" };

    let rendered = false;
    function renderIfReady() {
      sourcesFinished++;
      if (sourcesFinished >= totalSources) allSourcesDone = true;
      if (!rendered) { speciesLoading.classList.add("hidden"); rendered = true; }
      const merged = getMergedSpeciesData();
      renderTaxaFilters(merged);
      renderSpeciesCards();
    }

    async function loadInat() {
      try {
        const resp = await fetch("/api/species", { method: "POST", headers: reqHeaders, body: reqBody });
        if (resp.ok) {
          const data = await resp.json();
          allSpeciesData = data.species;
          let total = 0;
          for (const list of Object.values(allSpeciesData)) total += list.length;
          if (inatCountEl) inatCountEl.textContent = total;
        } else {
          if (inatCountEl) inatCountEl.textContent = "err";
        }
      } catch (e) {
        if (inatCountEl) inatCountEl.textContent = "err";
      }
      renderIfReady();
      loadObservations(bbox, month);
    }

    async function loadGbif() {
      try {
        const resp = await fetch("/api/gbif/species", { method: "POST", headers: reqHeaders, body: reqBody });
        if (resp.ok) {
          const data = await resp.json();
          gbifSpeciesData = data.species;
          let total = 0;
          for (const list of Object.values(gbifSpeciesData)) total += list.length;
          if (gbifCountEl) gbifCountEl.textContent = total;
        } else {
          if (gbifCountEl) gbifCountEl.textContent = "err";
        }
      } catch (e) {
        if (gbifCountEl) gbifCountEl.textContent = "err";
      }
      renderIfReady();
    }

    async function loadEbird() {
      try {
        const result = await fetchEbirdData();
        ebirdSpeciesData = result.species;
        allEbirdObservations = result.observations;
        let total = 0;
        for (const list of Object.values(ebirdSpeciesData)) total += list.length;
        if (ebirdCountEl) ebirdCountEl.textContent = total;
        renderEbirdMarkers(allEbirdObservations);
      } catch (e) {
        if (ebirdCountEl) ebirdCountEl.textContent = "err";
      }
      renderIfReady();
    }

    async function loadGeology() {
      try {
        if (locationReady) await locationReady.catch(() => {});
        const resp = await fetch("/api/geology", {
          method: "POST", headers: reqHeaders,
          body: JSON.stringify({
            coords: routeData.coords,
            city: routeLocation.city,
            state: routeLocation.state,
            country: routeLocation.country,
            county: routeLocation.county,
          }),
        });
        if (resp.ok) {
          const data = await resp.json();
          geologyData = data.formations || [];
          if (geologyCountEl) geologyCountEl.textContent = geologyData.length;
          renderGeologyInfo(geologyData);
        } else {
          if (geologyCountEl) geologyCountEl.textContent = "err";
        }
      } catch (e) {
        if (geologyCountEl) geologyCountEl.textContent = "err";
      }
    }

    await Promise.allSettled([loadInat(), loadGbif(), loadEbird(), loadGeology()]);
  }

  // ── Species card rendering ──
  function renderSpeciesCards() {
    speciesContainer.innerHTML = "";
    selectedCardEl = null;

    const merged = getMergedSpeciesData();
    let allSpecies = [];
    for (const [taxa, species] of Object.entries(merged)) {
      if (!activeTaxa.has(taxa)) continue;
      for (const sp of species) {
        allSpecies.push({ ...sp, taxa });
      }
    }

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
      if (allSourcesDone) {
        speciesContainer.innerHTML = '<div class="panel-message"><span class="text-xs text-gray-300">No species found for current filters.</span></div>';
      }
      return;
    }

    for (const sp of allSpecies) {
      const card = document.createElement("div");
      card.className = "species-card";
      card.dataset.taxonId = sp.id || "";

      const conservationBadge = sp.conservation_code
        ? `<span class="conservation-badge ${sp.conservation_code.toLowerCase()}" title="${CONSERVATION_LABELS[sp.conservation_code] || sp.conservation_status}">${sp.conservation_code}</span>`
        : "";

      const srcSet = new Set(sp.sources || []);
      let sourceBadge = "";
      if (srcSet.has("inat")) sourceBadge += '<span class="source-badge inat">iNat</span>';
      if (srcSet.has("gbif")) sourceBadge += '<span class="source-badge gbif">GBIF</span>';
      if (srcSet.has("ebird")) sourceBadge += '<span class="source-badge ebird">eBird</span>';
      if (srcSet.has("notable")) sourceBadge += '<span class="source-badge notable">Notable</span>';

      const summaryText = sp.wikipedia_summary ? truncate(stripHtml(sp.wikipedia_summary), 120) : "";
      const tooltip = summaryText
        ? `<div class="species-tooltip"><p>${summaryText}</p></div>`
        : "";

      const srcArr = sp.sources || [];
      const linkDomain = srcArr.includes("ebird") && !srcArr.includes("inat") ? "eBird"
        : srcArr.includes("gbif") && !srcArr.includes("inat") ? "GBIF" : "iNaturalist";
      const linkTitle = `View on ${linkDomain}`;

      const birdsongBtn = sp.taxa === "Aves"
        ? `<button class="birdsong-btn" data-sciname="${sp.name}" title="Play bird song" onclick="event.stopPropagation()"><i class="fa-solid fa-volume-high"></i></button>`
        : "";

      card.innerHTML = `
        ${sp.photo_url ? `<img class="species-card-img" src="${sp.photo_url}" alt="${sp.common_name || sp.name}" loading="lazy">` : '<div class="species-card-img"></div>'}
        <div class="species-card-body">
          <div class="common-name">${sp.common_name || sp.name}</div>
          ${sp.common_name ? `<div class="sci-name">${sp.name}</div>` : ""}
        </div>
        <div class="species-card-footer">
          <span class="obs-count">${sp.observations.toLocaleString()} obs${conservationBadge}${sourceBadge}</span>
          <span class="footer-actions">
            ${birdsongBtn}
            <a href="${sp.url}" target="_blank" class="inat-link" title="${linkTitle}" onclick="event.stopPropagation()">
              <svg viewBox="0 0 20 20" fill="currentColor" width="12" height="12"><path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z"/><path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z"/></svg>
            </a>
          </span>
        </div>
        ${tooltip}
      `;

      const songBtn = card.querySelector(".birdsong-btn");
      if (songBtn) {
        songBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          handleBirdsongClick(songBtn);
        });
      }

      card.addEventListener("click", () => {
        if (selectedCardEl) selectedCardEl.classList.remove("selected");
        card.classList.add("selected");
        selectedCardEl = card;
        const srcArr = sp.sources || [];
        const isEbirdOnly = srcArr.includes("ebird") && !srcArr.includes("inat") && !srcArr.includes("gbif");
        const isGbifOnly = srcArr.includes("gbif") && !srcArr.includes("inat");
        if (isEbirdOnly) {
          focusEbirdSpeciesOnMap(sp.name);
        } else if (isGbifOnly && sp.id) {
          focusGbifSpeciesOnMap(sp.name);
        } else if (sp.id) {
          focusSpeciesOnMap(sp.id);
        }
        if (window.innerWidth <= 768) {
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
      });

      speciesContainer.appendChild(card);
    }
  }

  async function handleBirdsongClick(btn) {
    const sciName = btn.dataset.sciname;
    const icon = btn.querySelector("i");

    if (currentBirdsongAudio && currentBirdsongBtn === btn) {
      if (currentBirdsongAudio.paused) {
        currentBirdsongAudio.play();
        icon.className = "fa-solid fa-pause";
      } else {
        currentBirdsongAudio.pause();
        icon.className = "fa-solid fa-play";
      }
      return;
    }

    stopCurrentBirdsong();

    icon.className = "fa-solid fa-spinner fa-spin";
    btn.disabled = true;

    try {
      const locParams = routeLocation.country ? `&country=${encodeURIComponent(routeLocation.country)}` : "";
      const resp = await fetch(`/api/birdsong?name=${encodeURIComponent(sciName)}${locParams}`);
      const data = await resp.json();

      if (!data.url) {
        icon.className = "fa-solid fa-volume-xmark";
        btn.title = "No recording available";
        btn.disabled = false;
        setTimeout(() => {
          icon.className = "fa-solid fa-volume-high";
          btn.title = "Play bird song";
        }, 2000);
        return;
      }

      const audio = new Audio(data.url);
      currentBirdsongAudio = audio;
      currentBirdsongBtn = btn;

      audio.addEventListener("canplay", () => {
        btn.disabled = false;
        icon.className = "fa-solid fa-pause";
        if (data.recordist) {
          btn.title = `Recording by ${data.recordist}`;
        }
        audio.play();
      }, { once: true });

      audio.addEventListener("ended", () => {
        icon.className = "fa-solid fa-volume-high";
        btn.title = "Play bird song";
        currentBirdsongAudio = null;
        currentBirdsongBtn = null;
      });

      audio.addEventListener("error", () => {
        icon.className = "fa-solid fa-volume-xmark";
        btn.disabled = false;
        btn.title = "Playback error";
        currentBirdsongAudio = null;
        currentBirdsongBtn = null;
        setTimeout(() => {
          icon.className = "fa-solid fa-volume-high";
          btn.title = "Play bird song";
        }, 2000);
      });

      audio.load();
    } catch (_) {
      icon.className = "fa-solid fa-volume-high";
      btn.disabled = false;
      currentBirdsongAudio = null;
      currentBirdsongBtn = null;
    }
  }

  function stopCurrentBirdsong() {
    if (currentBirdsongAudio) {
      currentBirdsongAudio.pause();
      currentBirdsongAudio.src = "";
      currentBirdsongAudio = null;
    }
    if (currentBirdsongBtn) {
      const icon = currentBirdsongBtn.querySelector("i");
      if (icon) icon.className = "fa-solid fa-volume-high";
      currentBirdsongBtn.title = "Play bird song";
      currentBirdsongBtn = null;
    }
  }

  // ── Focus eBird species on map ──
  function focusEbirdSpeciesOnMap(scientificName) {
    if (!leafletMap || !allEbirdObservations.length) return;

    const filtered = allEbirdObservations.filter(
      (o) => o.scientific_name && o.scientific_name.toLowerCase() === scientificName.toLowerCase() && o.lat && o.lng
    );
    if (!filtered.length) return;

    if (obsClusterGroup) leafletMap.removeLayer(obsClusterGroup);
    const focusGroup = L.featureGroup();

    const markers = [];
    for (const obs of filtered) {
      const icon = L.divIcon({
        className: "obs-marker",
        html: '<div class="ebird-marker-dot"><i class="fa-solid fa-dove"></i></div>',
        iconSize: [22, 22], iconAnchor: [11, 11],
      });
      const marker = L.marker([obs.lat, obs.lng], { icon });
      const dateStr = obs.date
        ? new Date(obs.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : "";
      const ebirdUrl = obs.species_code
        ? `https://ebird.org/species/${obs.species_code}` : "https://ebird.org";
      const popupHtml = `
        <div class="obs-popup">
          ${obs.photo_url ? `<img src="${obs.photo_url}" alt="${obs.common_name || obs.scientific_name}">` : ""}
          <div class="obs-popup-info">
            <a href="${ebirdUrl}" target="_blank" class="obs-popup-name">${obs.common_name || obs.scientific_name}</a>
            ${obs.common_name && obs.scientific_name ? `<div class="obs-popup-sci">${obs.scientific_name}</div>` : ""}
            ${dateStr ? `<div class="obs-popup-meta">${dateStr}</div>` : ""}
            ${obs.location_name ? `<div class="obs-popup-meta">${obs.location_name}</div>` : ""}
            ${obs.count ? `<div class="obs-popup-meta">${obs.count} individual${obs.count > 1 ? "s" : ""}</div>` : ""}
            <a href="${ebirdUrl}" target="_blank" class="obs-popup-link">eBird &rarr;</a>
          </div>
        </div>`;
      marker.bindPopup(popupHtml, { maxWidth: 240, className: "obs-popup-container" });
      focusGroup.addLayer(marker);
      markers.push(marker);
    }

    obsClusterGroup = focusGroup;
    leafletMap.addLayer(focusGroup);
    obsVisible = true;

    const toggleBtn = document.querySelector(".obs-toggle-btn");
    if (toggleBtn) toggleBtn.innerHTML = "Hide obs";
    const clearBtn = document.querySelector(".obs-clear-filter-btn");
    if (clearBtn) clearBtn.classList.remove("hidden");

    leafletMap.fitBounds(focusGroup.getBounds(), { padding: [40, 40], maxZoom: 18 });
    if (markers.length) setTimeout(() => markers[0].openPopup(), 400);
  }

  function renderEbirdMarkers(observations) {
    if (!leafletMap) return;

    if (ebirdClusterGroup) {
      leafletMap.removeLayer(ebirdClusterGroup);
    }
    ebirdMarkers = [];
    ebirdClusterGroup = L.markerClusterGroup({
      maxClusterRadius: 40,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
    });

    for (const obs of observations) {
      if (!obs.lat || !obs.lng) continue;

      const icon = L.divIcon({
        className: "obs-marker",
        html: '<div class="ebird-marker-dot"><i class="fa-solid fa-dove"></i></div>',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });

      const marker = L.marker([obs.lat, obs.lng], { icon });
      const dateStr = obs.date
        ? new Date(obs.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : "";

      const obsEbirdUrl = obs.species_code
        ? `https://ebird.org/species/${obs.species_code}`
        : "https://ebird.org";

      const popupHtml = `
        <div class="obs-popup">
          ${obs.photo_url ? `<img src="${obs.photo_url}" alt="${obs.common_name || obs.scientific_name}">` : ""}
          <div class="obs-popup-info">
            <a href="${obsEbirdUrl}" target="_blank" class="obs-popup-name">${obs.common_name || obs.scientific_name}</a>
            ${obs.common_name && obs.scientific_name ? `<div class="obs-popup-sci">${obs.scientific_name}</div>` : ""}
            ${dateStr ? `<div class="obs-popup-meta">${dateStr}</div>` : ""}
            ${obs.location_name ? `<div class="obs-popup-meta">${obs.location_name}</div>` : ""}
            ${obs.count ? `<div class="obs-popup-meta">${obs.count} individual${obs.count > 1 ? "s" : ""}</div>` : ""}
            <a href="${obsEbirdUrl}" target="_blank" class="obs-popup-link">eBird &rarr;</a>
          </div>
        </div>`;
      marker.bindPopup(popupHtml, { maxWidth: 240, className: "obs-popup-container" });
      ebirdClusterGroup.addLayer(marker);
      ebirdMarkers.push(marker);
    }

    leafletMap.addLayer(ebirdClusterGroup);
  }

  // ── Expanded bbox overlay ──
  function drawExpandedBbox() {
    if (!leafletMap || !routeData) return;
    if (expandedBboxPoly) { leafletMap.removeLayer(expandedBboxPoly); expandedBboxPoly = null; }

    const pct = bboxExpandSelect ? parseInt(bboxExpandSelect.value, 10) : 0;
    if (pct <= 0) return;

    const eBbox = expandBbox(routeData.bbox, pct);
    expandedBboxPoly = L.rectangle(
      [[eBbox[0], eBbox[1]], [eBbox[2], eBbox[3]]],
      { color: "#9ca3af", weight: 1, opacity: 0.5, fillOpacity: 0.02, dashArray: "6 4" }
    ).addTo(leafletMap);

    leafletMap.fitBounds(expandedBboxPoly.getBounds(), { padding: [30, 30] });
  }

  // ── Map ──
  function initMap() {
    leafletMap = L.map("map", { zoomControl: true, scrollWheelZoom: true });

    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
      maxZoom: 19,
    }).addTo(leafletMap);

    leafletMap.setView([37.7749, -122.4194], 12);

    geologyTileLayer = L.tileLayer("https://tiles.macrostrat.org/carto/{z}/{x}/{y}.png", {
      opacity: 0.5,
      maxZoom: 19,
      attribution: '&copy; <a href="https://macrostrat.org">Macrostrat</a>',
    });

    const GeoControl = L.Control.extend({
      options: { position: "bottomleft" },
      onAdd: function () {
        const container = L.DomUtil.create("label", "geo-overlay-control");
        const cb = L.DomUtil.create("input", "", container);
        cb.type = "checkbox";
        cb.checked = false;
        geoOverlayCb = cb;
        L.DomUtil.create("i", "fa-solid fa-mountain", container);
        const text = L.DomUtil.create("span", "", container);
        text.textContent = "Geology";
        L.DomEvent.disableClickPropagation(container);
        cb.addEventListener("change", toggleGeologyLayer);
        return container;
      },
    });
    leafletMap.addControl(new GeoControl());

    leafletMap.on("click", handleGeologyMapClick);

    drawnItems = new L.FeatureGroup();
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

      if (!routeData) {
        const centerLat = (drawnBbox[0] + drawnBbox[2]) / 2;
        const centerLng = (drawnBbox[1] + drawnBbox[3]) / 2;
        routeData = {
          name: "Custom Area",
          coords: [[centerLat, centerLng]],
          bbox: [...drawnBbox],
          hull: null,
          month: 0,
          date: new Date().toISOString(),
          situateMe: true,
          fromDraw: true,
        };
        monthSelect.value = 0;
        showResults();
      } else {
        loadAllSpecies();
      }
    });

    leafletMap.on(L.Draw.Event.DELETED, () => {
      drawnBbox = null;
      drawnLayer = null;
      if (routeData && routeData.fromDraw) {
        routeData = null;
        emptyState.classList.remove("hidden");
        const infoBar = $("#route-info-bar");
        if (infoBar) infoBar.classList.add("hidden");
        speciesContainer.innerHTML = "";
        document.body.classList.remove("route-loaded");
      } else {
        loadAllSpecies();
      }
    });

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
          else if (routeData) leafletMap.fitBounds([[routeData.bbox[0], routeData.bbox[1]], [routeData.bbox[2], routeData.bbox[3]]], { padding: [30, 30] });
          if (selectedCardEl) { selectedCardEl.classList.remove("selected"); selectedCardEl = null; }
        });

        return container;
      },
    });
    new ObsControls().addTo(leafletMap);
  }

  function renderMap(coords, bbox) {
    if (routePolyline) { leafletMap.removeLayer(routePolyline); routePolyline = null; }
    if (hullPoly) { leafletMap.removeLayer(hullPoly); hullPoly = null; }
    if (expandedBboxPoly) { leafletMap.removeLayer(expandedBboxPoly); expandedBboxPoly = null; }
    if (situateBboxRect) { leafletMap.removeLayer(situateBboxRect); situateBboxRect = null; }
    if (obsClusterGroup) { leafletMap.removeLayer(obsClusterGroup); obsClusterGroup = null; }
    if (ebirdClusterGroup) { leafletMap.removeLayer(ebirdClusterGroup); ebirdClusterGroup = null; }
    const keepDrawn = routeData && routeData.fromDraw;
    if (!keepDrawn && drawnLayer && drawnItems) { drawnItems.removeLayer(drawnLayer); drawnLayer = null; }
    if (geologyEnabled && geologyTileLayer && !leafletMap.hasLayer(geologyTileLayer)) {
      geologyTileLayer.addTo(leafletMap);
      if (geoOverlayCb) geoOverlayCb.checked = true;
    }
    allObsMarkers = [];
    ebirdMarkers = [];
    if (!keepDrawn) drawnBbox = null;

    if (routeData && routeData.situateMe && !routeData.fromDraw) {
      const sitLayers = L.layerGroup();
      const rect = L.rectangle(
        [[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
        { color: "#6b7280", weight: 1.5, opacity: 0.5, fillOpacity: 0.04, dashArray: "4 4" }
      );
      const centerLat = (bbox[0] + bbox[2]) / 2;
      const centerLng = (bbox[1] + bbox[3]) / 2;
      const centerDot = L.circleMarker([centerLat, centerLng], {
        radius: 6, fillColor: "#111827", fillOpacity: 0.8, color: "#fff", weight: 2,
      });
      sitLayers.addLayer(rect);
      sitLayers.addLayer(centerDot);
      sitLayers.addTo(leafletMap);
      situateBboxRect = sitLayers;
      leafletMap.fitBounds(rect.getBounds(), { padding: [30, 30] });
    } else {
      routePolyline = L.polyline(coords, { color: "#111827", weight: 2.5, opacity: 0.8 }).addTo(leafletMap);
      const hull = routeData.hull;
      if (hull && hull.length >= 3) {
        hullPoly = L.polygon(hull, {
          color: "#6b7280", weight: 1, opacity: 0.4, fillOpacity: 0.04, dashArray: "4 4",
        }).addTo(leafletMap);
        leafletMap.fitBounds(hullPoly.getBounds(), { padding: [30, 30] });
      } else {
        leafletMap.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: [30, 30] });
      }
    }
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
        body: JSON.stringify({ bbox, month, hull: currentHull() }),
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

    try {
      const resp = await fetch("/api/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bbox, month, taxon_id: taxonId, hull: currentHull() }),
      });
      if (!resp.ok) return;
      const data = await resp.json();
      if (!data.observations.length) return;

      const focusGroup = L.featureGroup();
      const markers = [];
      for (const obs of data.observations) {
        const marker = buildMarker(obs);
        focusGroup.addLayer(marker);
        markers.push(marker);
      }

      obsClusterGroup = focusGroup;
      leafletMap.addLayer(focusGroup);
      obsVisible = true;
      filteredSpeciesId = taxonId;

      const toggleBtn = document.querySelector(".obs-toggle-btn");
      if (toggleBtn) toggleBtn.innerHTML = "Hide obs";
      const clearBtn = document.querySelector(".obs-clear-filter-btn");
      if (clearBtn) clearBtn.classList.remove("hidden");

      leafletMap.fitBounds(focusGroup.getBounds(), { padding: [40, 40], maxZoom: 18 });
      setTimeout(() => markers[0].openPopup(), 400);
    } catch (_) {}
  }

  async function focusGbifSpeciesOnMap(scientificName) {
    if (!leafletMap || !routeData) return;

    const bbox = currentBbox();
    const hull = currentHull();

    if (obsClusterGroup) leafletMap.removeLayer(obsClusterGroup);

    try {
      const resp = await fetch("/api/gbif/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bbox, hull, scientific_name: scientificName }),
      });
      if (!resp.ok) return;
      const data = await resp.json();
      if (!data.observations.length) return;

      const focusGroup = L.featureGroup();
      const markers = [];
      for (const obs of data.observations) {
        const icon = L.divIcon({
          className: "obs-marker",
          html: '<div class="obs-marker-dot"><i class="fa-solid fa-globe"></i></div>',
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        });

        const marker = L.marker([obs.lat, obs.lng], { icon });
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
              ${obs.observer ? `<div class="obs-popup-meta">${obs.observer}</div>` : ""}
              <a href="${obs.obs_url}" target="_blank" class="obs-popup-link">GBIF &rarr;</a>
            </div>
          </div>`;
        marker.bindPopup(popupHtml, { maxWidth: 260, className: "obs-popup-container" });
        focusGroup.addLayer(marker);
        markers.push(marker);
      }

      obsClusterGroup = focusGroup;
      leafletMap.addLayer(focusGroup);
      obsVisible = true;

      const toggleBtn = document.querySelector(".obs-toggle-btn");
      if (toggleBtn) toggleBtn.innerHTML = "Hide obs";
      const clearBtn = document.querySelector(".obs-clear-filter-btn");
      if (clearBtn) clearBtn.classList.remove("hidden");

      leafletMap.fitBounds(focusGroup.getBounds(), { padding: [40, 40], maxZoom: 18 });
      setTimeout(() => markers[0].openPopup(), 400);
    } catch (_) {}
  }

  // ── Init ──
  initMap();
  initSourceToggles();
  checkAuth();
})();
