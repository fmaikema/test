/* Wandelplanner – plan wandelingen door heel Europa. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var store = {
    get: function (key, fallback) {
      try {
        var raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set: function (key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
    }
  };

  var KEY_ROUTES = 'wandel.routes';
  var KEY_DRAFT = 'wandel.draft';
  var KEY_PREFS = 'wandel.prefs';
  var EUROPE = L.latLngBounds([[26, -32], [72.5, 52]]);
  var ROUTE_COLOR = '#c2255c';

  var prefs = Object.assign({ base: 'osm', trails: false, pace: 4.5 }, store.get(KEY_PREFS, {}));
  function savePrefs() { store.set(KEY_PREFS, prefs); }

  /* ---------------- map ---------------- */
  var map = L.map('map', {
    zoomControl: false,
    minZoom: 4,
    maxZoom: 18,
    maxBounds: EUROPE.pad(0.1),
    maxBoundsViscosity: 0.8,
    worldCopyJump: false
  }).setView([50.5, 9.5], 5);
  map.attributionControl.setPrefix(false);

  var baseLayers = {
    osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }),
    topo: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: '&copy; OpenStreetMap, SRTM | <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)'
    })
  };
  var trailsLayer = L.tileLayer('https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png', {
    maxZoom: 18,
    opacity: 0.8,
    attribution: 'Routes: <a href="https://hiking.waymarkedtrails.org">Waymarked Trails</a>'
  });
  var currentBase = null;

  function applyLayers() {
    var next = baseLayers[prefs.base] || baseLayers.osm;
    if (currentBase !== next) {
      if (currentBase) map.removeLayer(currentBase);
      next.addTo(map);
      currentBase = next;
    }
    if (prefs.trails) trailsLayer.addTo(map); else map.removeLayer(trailsLayer);
  }
  applyLayers();

  var routeLayer = L.layerGroup().addTo(map);
  var markerLayer = L.layerGroup().addTo(map);
  var cursorMarker = L.circleMarker([0, 0], { radius: 7, color: '#fff', weight: 3, fillColor: ROUTE_COLOR, fillOpacity: 1, interactive: false });

  /* ---------------- state ---------------- */
  // waypoints: [{lat, lng}], segments[i] joins waypoints[i] and waypoints[i + 1]
  // segment: {coords: [[lat, lng, ele|null], ...], source: 'brouter'|'osrm'|'line', pending: bool}
  var state = { id: null, name: '', waypoints: [], segments: [] };
  var lastStats = null;

  function round5(n) { return Math.round(n * 1e5) / 1e5; }
  function pt(latlng) { return { lat: round5(latlng.lat), lng: round5(latlng.lng) }; }

  /* ---------------- routing ---------------- */
  function fetchJson(url, ms) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, ms);
    return fetch(url, { signal: ctrl.signal }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).finally(function () { clearTimeout(timer); });
  }

  function toCoords(list) {
    // GeoJSON order is [lon, lat, (ele)]
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!Array.isArray(c) || !isFinite(c[0]) || !isFinite(c[1])) continue;
      var ele = c.length > 2 && isFinite(c[2]) && c[2] !== null ? Math.round(Number(c[2]) * 10) / 10 : null;
      out.push([round5(Number(c[1])), round5(Number(c[0])), ele]);
    }
    if (out.length < 2) throw new Error('Geen route');
    return out;
  }

  function viaBrouter(a, b) {
    var url = 'https://brouter.de/brouter?lonlats=' + a.lng + ',' + a.lat + '%7C' + b.lng + ',' + b.lat +
      '&profile=hiking-mountain&alternativeidx=0&format=geojson';
    return fetchJson(url, 15000).then(function (json) {
      return { coords: toCoords(json.features[0].geometry.coordinates), source: 'brouter' };
    });
  }

  function viaOsrm(a, b) {
    var url = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/' + a.lng + ',' + a.lat + ';' + b.lng + ',' + b.lat +
      '?overview=full&geometries=geojson';
    return fetchJson(url, 12000).then(function (json) {
      if (json.code !== 'Ok') throw new Error(json.code || 'Geen route');
      return { coords: toCoords(json.routes[0].geometry.coordinates), source: 'osrm' };
    });
  }

  function straight(a, b) {
    return { coords: [[a.lat, a.lng, null], [b.lat, b.lng, null]], source: 'line' };
  }

  function routeBetween(a, b) {
    return viaBrouter(a, b).catch(function () {
      return viaOsrm(a, b);
    }).catch(function () {
      return straight(a, b);
    });
  }

  function computeSegment(i) {
    var a = state.waypoints[i], b = state.waypoints[i + 1];
    if (!a || !b) return;
    var seg = Object.assign(straight(a, b), { pending: true });
    state.segments[i] = seg;
    routeBetween(a, b).then(function (result) {
      if (state.segments.indexOf(seg) === -1) return; // superseded meanwhile
      seg.coords = result.coords;
      seg.source = result.source;
      seg.pending = false;
      if (result.source === 'line') toast('Geen wandelpad gevonden voor dit stuk; er is een rechte lijn getekend.');
      renderRoute();
      saveDraft();
    });
  }

  /* ---------------- editing ---------------- */
  function addPoint(latlng) {
    if (!EUROPE.contains(latlng)) { toast('Dit punt ligt buiten Europa.'); return; }
    if (state.waypoints.length >= 60) { toast('Een route kan maximaal 60 punten hebben.'); return; }
    state.waypoints.push(pt(latlng));
    if (state.waypoints.length > 1) computeSegment(state.waypoints.length - 2);
    changed(true);
  }

  function moveWaypoint(i, latlng) {
    if (!EUROPE.contains(latlng)) { toast('Dit punt ligt buiten Europa.'); renderMarkers(); return; }
    state.waypoints[i] = pt(latlng);
    if (i > 0) computeSegment(i - 1);
    if (i < state.waypoints.length - 1) computeSegment(i);
    changed(true);
  }

  function removeWaypoint(i) {
    var n = state.waypoints.length;
    state.waypoints.splice(i, 1);
    if (n === 1) {
      state.segments = [];
    } else if (i === 0) {
      state.segments.shift();
    } else if (i === n - 1) {
      state.segments.pop();
    } else {
      state.segments.splice(i - 1, 2, null);
      computeSegment(i - 1);
    }
    changed(true);
  }

  function reverseRoute() {
    state.waypoints.reverse();
    state.segments.reverse();
    state.segments.forEach(function (seg, i) {
      if (!seg || seg.pending) computeSegment(i); else seg.coords.reverse();
    });
    changed(true);
  }

  function clearRoute() {
    state = { id: null, name: '', waypoints: [], segments: [] };
    changed(true);
  }

  function changed(markers) {
    if (markers) renderMarkers();
    renderRoute();
    saveDraft();
  }

  function saveDraft() {
    store.set(KEY_DRAFT, snapshot());
  }

  function snapshot() {
    return {
      id: state.id,
      name: state.name,
      waypoints: state.waypoints,
      segments: state.segments.map(function (s) { return { coords: s.coords, source: s.source }; })
    };
  }

  function loadSnapshot(snap, fit) {
    state = {
      id: snap.id || null,
      name: snap.name || '',
      waypoints: (snap.waypoints || []).slice(),
      segments: (snap.segments || []).map(function (s) { return { coords: s.coords, source: s.source, pending: false }; })
    };
    // repair segments that were still being calculated when the app closed
    for (var i = 0; i < state.waypoints.length - 1; i++) {
      if (!state.segments[i] || !state.segments[i].coords || state.segments[i].coords.length < 2) computeSegment(i);
    }
    state.segments.length = Math.max(0, state.waypoints.length - 1);
    renderMarkers();
    renderRoute();
    if (fit) fitRoute();
  }

  /* ---------------- geometry and statistics ---------------- */
  function haversine(a, b) {
    var R = 6371000, rad = Math.PI / 180;
    var dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function allCoords() {
    var out = [];
    state.segments.forEach(function (seg) {
      if (!seg) return;
      seg.coords.forEach(function (c, j) {
        if (j === 0 && out.length) {
          var last = out[out.length - 1];
          if (last[0] === c[0] && last[1] === c[1]) return;
        }
        out.push(c);
      });
    });
    return out;
  }

  function computeStats(coords) {
    var dist = [0], up = 0, down = 0, ref = null, withEle = 0, min = Infinity, max = -Infinity;
    for (var i = 0; i < coords.length; i++) {
      if (i > 0) dist.push(dist[i - 1] + haversine(coords[i - 1], coords[i]));
      var e = coords[i][2];
      if (e === null || e === undefined) { ref = null; continue; }
      withEle++;
      if (e < min) min = e;
      if (e > max) max = e;
      if (ref === null) { ref = e; continue; }
      var d = e - ref;
      if (d >= 5) { up += d; ref = e; } else if (d <= -5) { down -= d; ref = e; }
    }
    return {
      coords: coords,
      dist: dist,
      total: dist[dist.length - 1] || 0,
      up: up,
      down: down,
      hasEle: withEle > 1,
      fullEle: coords.length > 1 && withEle === coords.length,
      min: min,
      max: max
    };
  }

  function fmtKm(m) {
    var km = m / 1000;
    return (km >= 100 ? Math.round(km).toString() : km.toFixed(1).replace('.', ',')) + ' km';
  }

  function fmtTime(hours) {
    var mins = Math.max(1, Math.round(hours * 60));
    var h = Math.floor(mins / 60), m = mins % 60;
    if (h === 0) return m + ' min';
    return h + ' u ' + (m < 10 ? '0' : '') + m;
  }

  function walkHours(stats) {
    return stats.total / 1000 / prefs.pace + stats.up / 600;
  }

  /* ---------------- rendering ---------------- */
  function renderMarkers() {
    markerLayer.clearLayers();
    var n = state.waypoints.length;
    state.waypoints.forEach(function (wp, i) {
      var cls = 'wp' + (i === 0 ? ' start' : (i === n - 1 ? ' end' : ''));
      var label = i === 0 ? 'S' : (i === n - 1 ? 'E' : String(i));
      var marker = L.marker([wp.lat, wp.lng], {
        draggable: true,
        autoPan: true,
        icon: L.divIcon({ className: '', html: '<div class="' + cls + '">' + label + '</div>', iconSize: [28, 28], iconAnchor: [14, 14] }),
        zIndexOffset: i === 0 || i === n - 1 ? 500 : 0
      });
      marker.on('dragend', function () { moveWaypoint(i, marker.getLatLng()); });
      marker.on('click', function () {
        var box = document.createElement('div');
        var title = document.createElement('strong');
        title.textContent = i === 0 ? 'Startpunt' : (i === n - 1 ? 'Eindpunt' : 'Punt ' + i);
        var hint = document.createElement('div');
        hint.textContent = 'Sleep het punt om het te verplaatsen.';
        hint.style.fontSize = '13px';
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'popup-btn danger';
        del.textContent = 'Punt verwijderen';
        del.addEventListener('click', function () { map.closePopup(); removeWaypoint(i); });
        box.appendChild(title); box.appendChild(hint); box.appendChild(del);
        L.popup({ offset: [0, -8], closeButton: false }).setLatLng(marker.getLatLng()).setContent(box).openOn(map);
      });
      marker.addTo(markerLayer);
    });
  }

  function renderRoute() {
    routeLayer.clearLayers();
    state.segments.forEach(function (seg) {
      if (!seg) return;
      var latlngs = seg.coords.map(function (c) { return [c[0], c[1]]; });
      var loose = seg.pending || seg.source === 'line';
      if (!loose) L.polyline(latlngs, { color: '#fff', weight: 8, opacity: 0.9, interactive: false }).addTo(routeLayer);
      L.polyline(latlngs, {
        color: ROUTE_COLOR,
        weight: loose ? 3 : 5,
        opacity: loose ? 0.7 : 1,
        dashArray: loose ? '6 8' : null,
        interactive: false
      }).addTo(routeLayer);
    });
    renderPanel();
  }

  function renderPanel() {
    var n = state.waypoints.length;
    $('emptyState').hidden = n > 0;
    $('routeState').hidden = n === 0;
    if (n === 0) {
      panel.classList.remove('open');
      document.body.classList.remove('panel-open');
      $('panelToggle').setAttribute('aria-expanded', 'false');
      lastStats = null;
      hideCursor();
      return;
    }
    var stats = computeStats(allCoords());
    lastStats = stats;
    var pending = state.segments.some(function (s) { return s && s.pending; });
    $('statDist').textContent = n < 2 ? '0 km' : fmtKm(stats.total);
    $('statTime').textContent = n < 2 ? '–' : (pending ? '…' : fmtTime(walkHours(stats)));
    $('statUp').textContent = stats.hasEle ? '↑' + Math.round(stats.up) + ' ↓' + Math.round(stats.down) + ' m' : '–';
    $('loopBtn').disabled = n < 2 || samePoint(state.waypoints[0], state.waypoints[n - 1]);
    $('reverseBtn').disabled = n < 2;
    $('saveBtn').textContent = state.id ? 'Wijziging opslaan' : 'Opslaan';
    renderProfile(stats, n, pending);
  }

  function samePoint(a, b) { return a.lat === b.lat && a.lng === b.lng; }

  function renderProfile(stats, n, pending) {
    var wrap = $('profileWrap'), note = $('profileNote');
    hideCursor();
    if (n < 2) {
      wrap.hidden = true;
      note.hidden = false;
      note.textContent = 'Tik op de kaart om het volgende punt toe te voegen.';
      return;
    }
    if (!stats.fullEle || stats.total < 50) {
      wrap.hidden = true;
      note.hidden = pending;
      note.textContent = stats.hasEle
        ? 'Voor een deel van deze route zijn geen hoogtegegevens beschikbaar.'
        : 'Voor deze route zijn geen hoogtegegevens beschikbaar.';
      return;
    }
    note.hidden = true;
    wrap.hidden = false;
    var W = 300, H = 80, pad = 6;
    var span = Math.max(20, stats.max - stats.min);
    var step = Math.max(1, Math.floor(stats.coords.length / 300));
    var d = '';
    for (var i = 0; i < stats.coords.length; i += step) {
      d += point(i);
    }
    if ((stats.coords.length - 1) % step !== 0) d += point(stats.coords.length - 1);
    function point(k) {
      var x = stats.dist[k] / stats.total * W;
      var y = H - pad - (stats.coords[k][2] - stats.min) / span * (H - 2 * pad);
      return (d === '' ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    $('profileLine').setAttribute('d', d);
    $('profileArea').setAttribute('d', d + 'L' + W + ' ' + H + 'L0 ' + H + 'Z');
    $('profileMax').textContent = Math.round(stats.max) + ' m';
    $('profileMin').textContent = Math.round(stats.min) + ' m';
  }

  function hideCursor() {
    $('profileCursor').setAttribute('visibility', 'hidden');
    $('profileRead').hidden = true;
    map.removeLayer(cursorMarker);
  }

  function scrubProfile(ev) {
    var stats = lastStats;
    if (!stats || !stats.fullEle) return;
    var rect = $('profileWrap').getBoundingClientRect();
    var frac = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    var target = frac * stats.total;
    var lo = 0, hi = stats.dist.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (stats.dist[mid] < target) lo = mid + 1; else hi = mid;
    }
    var c = stats.coords[lo];
    var x = frac * 300;
    var cur = $('profileCursor');
    cur.setAttribute('x1', x); cur.setAttribute('x2', x); cur.setAttribute('visibility', 'visible');
    var read = $('profileRead');
    read.hidden = false;
    read.textContent = fmtKm(stats.dist[lo]) + ' · ' + Math.round(c[2]) + ' m';
    cursorMarker.setLatLng([c[0], c[1]]).addTo(map);
  }

  function fitRoute() {
    var coords = allCoords();
    var pts = coords.length ? coords.map(function (c) { return [c[0], c[1]]; })
      : state.waypoints.map(function (w) { return [w.lat, w.lng]; });
    if (!pts.length) return;
    if (pts.length === 1) { map.setView(pts[0], 14); return; }
    map.fitBounds(L.latLngBounds(pts), {
      paddingTopLeft: [30, 90],
      paddingBottomRight: [30, panel.offsetHeight + 30],
      maxZoom: 16
    });
  }

  /* ---------------- panel ---------------- */
  var panel = $('panel');
  function syncPanelHeight() {
    var peek = Math.min(panel.offsetHeight, window.innerHeight * 0.45);
    document.documentElement.style.setProperty('--panel-h', Math.round(peek) + 'px');
  }
  if ('ResizeObserver' in window) new ResizeObserver(syncPanelHeight).observe(panel);
  window.addEventListener('resize', syncPanelHeight);

  $('panelToggle').addEventListener('click', function () {
    if (!state.waypoints.length) return;
    var open = panel.classList.toggle('open');
    document.body.classList.toggle('panel-open', open);
    $('panelToggle').setAttribute('aria-expanded', String(open));
  });
  document.querySelector('.stats').addEventListener('click', function () { $('panelToggle').click(); });

  $('undoBtn').addEventListener('click', function () {
    if (state.waypoints.length) removeWaypoint(state.waypoints.length - 1);
  });
  $('loopBtn').addEventListener('click', function () {
    var first = state.waypoints[0];
    if (first) addPoint(L.latLng(first.lat, first.lng));
  });
  $('reverseBtn').addEventListener('click', reverseRoute);
  $('clearBtn').addEventListener('click', function () {
    if (state.waypoints.length > 1 && !confirm('Deze route van de kaart wissen?')) return;
    clearRoute();
  });

  var paceSelect = $('paceSelect');
  paceSelect.value = String(prefs.pace);
  if (!paceSelect.value) { paceSelect.value = '4.5'; prefs.pace = 4.5; }
  paceSelect.addEventListener('change', function () {
    prefs.pace = Number(paceSelect.value) || 4.5;
    savePrefs();
    renderPanel();
  });

  var profileWrap = $('profileWrap');
  profileWrap.addEventListener('pointerdown', function (ev) {
    try { profileWrap.setPointerCapture(ev.pointerId); } catch (e) { /* not supported */ }
    scrubProfile(ev);
  });
  profileWrap.addEventListener('pointermove', function (ev) {
    if (ev.pointerType === 'mouse' && ev.buttons === 0) return;
    scrubProfile(ev);
  });
  ['pointerup', 'pointercancel'].forEach(function (name) {
    profileWrap.addEventListener(name, function () { setTimeout(hideCursor, 1500); });
  });

  /* ---------------- map interaction ---------------- */
  var popupClosedAt = 0;
  map.on('popupclose', function () { popupClosedAt = Date.now(); });
  map.on('click', function (ev) {
    if (Date.now() - popupClosedAt < 250) return; // this tap only dismissed a popup
    if (!$('layerMenu').hidden) { $('layerMenu').hidden = true; return; }
    if (!$('searchResults').hidden) { closeSearch(); return; }
    addPoint(ev.latlng);
  });

  /* ---------------- layers ---------------- */
  var layerMenu = $('layerMenu');
  $('layerBtn').addEventListener('click', function () { layerMenu.hidden = !layerMenu.hidden; });
  Array.prototype.forEach.call(layerMenu.querySelectorAll('input[name="base"]'), function (input) {
    input.checked = input.value === prefs.base;
    input.addEventListener('change', function () {
      prefs.base = input.value;
      savePrefs();
      applyLayers();
    });
  });
  $('trailsToggle').checked = !!prefs.trails;
  $('trailsToggle').addEventListener('change', function () {
    prefs.trails = $('trailsToggle').checked;
    savePrefs();
    applyLayers();
  });

  /* ---------------- location ---------------- */
  var watchId = null, meMarker = null, meCircle = null, firstFix = false;
  var locateBtn = $('locateBtn');

  function stopLocate() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (meMarker) { map.removeLayer(meMarker); map.removeLayer(meCircle); meMarker = meCircle = null; }
    locateBtn.setAttribute('aria-pressed', 'false');
  }

  locateBtn.addEventListener('click', function () {
    if (watchId !== null) {
      if (meMarker && !map.getBounds().contains(meMarker.getLatLng())) { map.setView(meMarker.getLatLng(), Math.max(map.getZoom(), 15)); return; }
      stopLocate();
      return;
    }
    if (!('geolocation' in navigator)) { toast('Locatie wordt op dit toestel niet ondersteund.'); return; }
    firstFix = true;
    locateBtn.setAttribute('aria-pressed', 'true');
    watchId = navigator.geolocation.watchPosition(function (pos) {
      var ll = L.latLng(pos.coords.latitude, pos.coords.longitude);
      if (!meMarker) {
        meCircle = L.circle(ll, { radius: pos.coords.accuracy, color: '#1a73e8', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
        meMarker = L.marker(ll, { interactive: false, zIndexOffset: 1000, icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(map);
      } else {
        meMarker.setLatLng(ll);
        meCircle.setLatLng(ll).setRadius(pos.coords.accuracy);
      }
      if (firstFix) {
        firstFix = false;
        if (EUROPE.contains(ll)) map.setView(ll, Math.max(map.getZoom(), 15));
        else toast('Je bevindt je buiten Europa; de kaart blijft waar hij is.');
      }
    }, function (err) {
      stopLocate();
      toast(err && err.code === 1
        ? 'Geen toestemming voor locatie. Zet dit aan in Instellingen > Privacy > Locatievoorzieningen.'
        : 'Je locatie kon niet worden bepaald.');
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  });

  /* ---------------- search ---------------- */
  var searchInput = $('searchInput'), searchResults = $('searchResults'), searchClear = $('searchClear');
  var searchTimer = null, searchSeq = 0, searchPin = null;

  function closeSearch() {
    searchResults.hidden = true;
    searchResults.textContent = '';
    searchInput.blur();
  }

  function placeLabel(p) {
    var parts = [];
    [p.city, p.county, p.state, p.country].forEach(function (v) {
      if (v && v !== p.name && parts.indexOf(v) === -1) parts.push(v);
    });
    return parts.slice(0, 3).join(', ');
  }

  function runSearch() {
    var q = searchInput.value.trim();
    var seq = ++searchSeq;
    if (q.length < 2) { searchResults.hidden = true; searchResults.textContent = ''; return; }
    var c = map.getCenter();
    var url = 'https://photon.komoot.io/api/?q=' + encodeURIComponent(q) + '&limit=6&bbox=-25,34,45,72' +
      '&lat=' + c.lat.toFixed(3) + '&lon=' + c.lng.toFixed(3);
    fetchJson(url, 10000).then(function (json) {
      if (seq !== searchSeq) return;
      showResults((json && json.features) || []);
    }).catch(function () {
      if (seq !== searchSeq) return;
      showMessage('Zoeken lukt nu niet. Controleer je internetverbinding.');
    });
  }

  function showMessage(text) {
    searchResults.textContent = '';
    var li = document.createElement('li');
    li.className = 'r-none';
    li.textContent = text;
    searchResults.appendChild(li);
    searchResults.hidden = false;
  }

  function showResults(features) {
    features = features.filter(function (f) {
      return f && f.geometry && Array.isArray(f.geometry.coordinates) && f.properties;
    });
    if (!features.length) { showMessage('Niets gevonden.'); return; }
    searchResults.textContent = '';
    features.forEach(function (f) {
      var p = f.properties;
      var name = p.name || p.street || p.city || 'Onbekende plaats';
      var li = document.createElement('li');
      var btn = document.createElement('button');
      btn.type = 'button';
      var a = document.createElement('span'); a.className = 'r-name'; a.textContent = name;
      var b = document.createElement('span'); b.className = 'r-sub'; b.textContent = placeLabel(p);
      btn.appendChild(a); btn.appendChild(b);
      btn.addEventListener('click', function () {
        var ll = L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]);
        closeSearch();
        searchInput.value = name;
        searchClear.hidden = false;
        goToPlace(ll, name);
      });
      li.appendChild(btn);
      searchResults.appendChild(li);
    });
    searchResults.hidden = false;
  }

  function goToPlace(ll, name) {
    map.setView(ll, 14);
    if (searchPin) map.removeLayer(searchPin);
    var box = document.createElement('div');
    var title = document.createElement('strong');
    title.textContent = name;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'popup-btn';
    btn.textContent = state.waypoints.length ? 'Toevoegen aan route' : 'Hier starten';
    btn.addEventListener('click', function () { map.removeLayer(searchPin); searchPin = null; addPoint(ll); });
    box.appendChild(title); box.appendChild(btn);
    searchPin = L.popup({ closeButton: true, autoClose: false, closeOnClick: false }).setLatLng(ll).setContent(box);
    searchPin.addTo(map);
  }

  searchInput.addEventListener('input', function () {
    searchClear.hidden = !searchInput.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 350);
  });
  searchInput.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); clearTimeout(searchTimer); runSearch(); }
  });
  searchClear.addEventListener('click', function () {
    searchInput.value = '';
    searchClear.hidden = true;
    searchSeq++;
    searchResults.hidden = true;
    searchResults.textContent = '';
    searchInput.focus();
  });

  /* ---------------- saved walks ---------------- */
  var saveDialog = $('saveDialog'), nameInput = $('nameInput');

  function getRoutes() {
    var list = store.get(KEY_ROUTES, []);
    return Array.isArray(list) ? list : [];
  }

  $('saveBtn').addEventListener('click', function () {
    if (state.waypoints.length < 2) { toast('Zet minstens twee punten op de kaart.'); return; }
    if (state.segments.some(function (s) { return !s || s.pending; })) { toast('De route wordt nog berekend. Probeer het zo nog eens.'); return; }
    nameInput.value = state.name || ('Wandeling ' + new Date().toLocaleDateString('nl-NL', { day: 'numeric', month: 'long' }));
    if (typeof saveDialog.showModal === 'function') {
      saveDialog.showModal();
      nameInput.select();
    } else {
      var name = prompt('Naam van de wandeling', nameInput.value);
      if (name) saveRoute(name);
    }
  });
  $('saveCancel').addEventListener('click', function () { saveDialog.close(); });
  $('saveForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var name = nameInput.value.trim();
    if (!name) return;
    saveDialog.close();
    saveRoute(name);
  });

  function saveRoute(name) {
    var stats = computeStats(allCoords());
    state.name = name.trim().slice(0, 60);
    if (!state.id) state.id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    var entry = Object.assign(snapshot(), {
      saved: Date.now(),
      total: Math.round(stats.total),
      up: stats.hasEle ? Math.round(stats.up) : null
    });
    var routes = getRoutes().filter(function (r) { return r.id !== entry.id; });
    routes.unshift(entry);
    if (!store.set(KEY_ROUTES, routes)) {
      toast('Opslaan is niet gelukt: de opslag van dit toestel is vol.');
      return;
    }
    saveDraft();
    renderPanel();
    toast('Opgeslagen in Mijn wandelingen.');
  }

  function renderList() {
    var routes = getRoutes();
    var ul = $('routeList');
    ul.textContent = '';
    $('listEmpty').hidden = routes.length > 0;
    routes.forEach(function (r) {
      var li = document.createElement('li');
      var open = document.createElement('button');
      open.type = 'button';
      open.className = 'route-open';
      var a = document.createElement('span'); a.className = 'r-name'; a.textContent = r.name || 'Naamloos';
      var b = document.createElement('span'); b.className = 'r-sub';
      var bits = [fmtKm(r.total || 0)];
      if (r.up !== null && r.up !== undefined) bits.push('↑' + r.up + ' m');
      if (r.saved) bits.push(new Date(r.saved).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }));
      b.textContent = bits.join(' · ');
      open.appendChild(a); open.appendChild(b);
      open.addEventListener('click', function () {
        $('listSheet').hidden = true;
        loadSnapshot(r, true);
        saveDraft();
      });
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'icon-btn';
      del.setAttribute('aria-label', 'Verwijder ' + (r.name || 'wandeling'));
      del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg>';
      del.addEventListener('click', function () {
        if (!confirm('“' + (r.name || 'Deze wandeling') + '” verwijderen?')) return;
        store.set(KEY_ROUTES, getRoutes().filter(function (x) { return x.id !== r.id; }));
        if (state.id === r.id) { state.id = null; saveDraft(); renderPanel(); }
        renderList();
      });
      li.appendChild(open); li.appendChild(del);
      ul.appendChild(li);
    });
  }

  $('listBtn').addEventListener('click', function () { closeSearch(); renderList(); $('listSheet').hidden = false; });
  $('listClose').addEventListener('click', function () { $('listSheet').hidden = true; });

  /* ---------------- GPX ---------------- */
  function esc(s) {
    return String(s).replace(/[<>&"']/g, function (ch) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch];
    });
  }

  function buildGpx(name) {
    var out = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<gpx version="1.1" creator="Wandelplanner" xmlns="http://www.topografix.com/GPX/1/1">\n' +
      '  <metadata><name>' + esc(name) + '</name></metadata>\n' +
      '  <trk>\n    <name>' + esc(name) + '</name>\n    <trkseg>\n';
    allCoords().forEach(function (c) {
      out += '      <trkpt lat="' + c[0] + '" lon="' + c[1] + '">' +
        (c[2] !== null && c[2] !== undefined ? '<ele>' + c[2] + '</ele>' : '') + '</trkpt>\n';
    });
    return out + '    </trkseg>\n  </trk>\n</gpx>\n';
  }

  $('gpxBtn').addEventListener('click', function () {
    if (state.waypoints.length < 2) { toast('Zet minstens twee punten op de kaart.'); return; }
    var name = state.name || 'Wandeling';
    var fileName = (name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'wandeling') + '.gpx';
    var gpx = buildGpx(name);
    var file = null;
    try { file = new File([gpx], fileName, { type: 'application/gpx+xml' }); } catch (e) { file = null; }
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: name }).catch(function (err) {
        if (err && err.name !== 'AbortError') download(gpx, fileName);
      });
    } else {
      download(gpx, fileName);
    }
  });

  function download(text, fileName) {
    var url = URL.createObjectURL(new Blob([text], { type: 'application/gpx+xml' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  /* ---------------- toast ---------------- */
  var toastTimer = null;
  function toast(text) {
    var el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 4000);
  }

  /* ---------------- start ---------------- */
  var draft = store.get(KEY_DRAFT, null);
  if (draft && Array.isArray(draft.waypoints) && draft.waypoints.length) {
    loadSnapshot(draft, true);
  } else {
    renderPanel();
  }
  syncPanelHeight();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () { /* app works without it */ });
  }

  // small hook for automated tests
  window.__wandel = { map: map, getState: function () { return state; }, buildGpx: buildGpx };
})();
