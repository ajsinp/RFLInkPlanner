const towers = [];
const links = [];
let map;
let connectingFrom = null;
const c = 3e8;

function init() {
  map = L.map("map").setView([20.5937, 78.9629], 5);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap",
  }).addTo(map);

  map.on("click", (e) =>
    addTower({
      lat: e.latlng.lat,
      lng: e.latlng.lng,
      freqGHz: parseFloat(document.getElementById("defaultFreq").value) || 5,
    })
  );

  document.getElementById("exportBtn").onclick = exportGeoJSON;
  document.getElementById("clearBtn").onclick = clearAll;
}
init();

function uuid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function formatDistance(m) {
  return m >= 1000 ? (m / 1000).toFixed(2) + " km" : Math.round(m) + " m";
}
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function addTower(t) {
  t.id = uuid();
  t.name = t.name || `Tower ${towers.length + 1}`;

  t.marker = L.marker([t.lat, t.lng], { draggable: true })
    .addTo(map)
    .bindPopup(popupHtml(t), { minWidth: 220 });

  t.marker.on("popupopen", () => wirePopup(t));

  t.marker.on("click", () => {
    if (connectingFrom && connectingFrom !== t.id) {
      attemptCreateLink(connectingFrom, t.id);
      connectingFrom = null;
    }
  });

  t.marker.on("dragend", (e) => {
    t.lat = e.target.getLatLng().lat;
    t.lng = e.target.getLatLng().lng;
    updateAllPolylines();
    clearAllFresnel();
    refreshUI();
  });

  towers.push(t);
  refreshUI();
}

function popupHtml(t) {
  return `
<div style="font-size:13px">
  <label>Name</label>
  <input id="name-${t.id}" type="text" value="${escapeHtml(
    t.name
  )}" style="width:100%"/>
  <label>Frequency (GHz)</label>
  <input id="freq-${t.id}" type="number" step="0.01" value="${
    t.freqGHz
  }" style="width:100%"/>
  <div style="margin-top:6px;display:flex;gap:6px">
    <button id="save-${t.id}">Save</button>
    <button id="del-${t.id}">Delete</button>
    <button id="connect-${t.id}">Connect</button>
  </div>
  <div style="font-size:12px;color:#555">Click Connect then another tower to link (freq must match)</div>
</div>`;
}

function wirePopup(t) {
  const saveBtn = document.getElementById(`save-${t.id}`);
  const delBtn = document.getElementById(`del-${t.id}`);
  const connBtn = document.getElementById(`connect-${t.id}`);

  if (saveBtn) {
    saveBtn.onclick = () => {
      const nameEl = document.getElementById(`name-${t.id}`);
      const freqEl = document.getElementById(`freq-${t.id}`);
      t.name = nameEl ? nameEl.value || t.name : t.name;
      t.freqGHz = freqEl ? parseFloat(freqEl.value) || t.freqGHz : t.freqGHz;

      t.marker.setPopupContent(popupHtml(t));
      t.marker.openPopup();
      refreshUI();
    };
  }

  if (delBtn) {
    delBtn.onclick = () => removeTower(t.id);
  }

  if (connBtn) {
    connBtn.onclick = () => {
      connectingFrom = t.id;
      t.marker.bindTooltip("Click another tower to connect").openTooltip();
      setTimeout(() => t.marker.closeTooltip(), 1500);
    };
  }
}

function removeTower(id) {
  const idx = towers.findIndex((t) => t.id === id);
  if (idx === -1) return;

  map.removeLayer(towers[idx].marker);
  towers.splice(idx, 1);

  for (let i = links.length - 1; i >= 0; i--) {
    if ([links[i].aId, links[i].bId].includes(id)) {
      map.removeLayer(links[i].polyline);
      if (links[i].fresnelPoly) map.removeLayer(links[i].fresnelPoly);
      links.splice(i, 1);
    }
  }

  refreshUI();
}

function attemptCreateLink(aId, bId) {
  const a = towers.find((t) => t.id === aId);
  const b = towers.find((t) => t.id === bId);

  if (!a || !b) return;

  if (Math.abs(a.freqGHz - b.freqGHz) > 1e-6) return;

  if (
    links.find(
      (l) =>
        (l.aId === aId && l.bId === bId) || (l.aId === bId && l.bId === aId)
    )
  )
    return;

  const id = uuid();
  const poly = L.polyline(
    [
      [a.lat, a.lng],
      [b.lat, b.lng],
    ],
    { color: "#0b74ff", weight: 3 }
  ).addTo(map);

  poly
    .on("click", () => onLinkClicked(id))
    .on("mouseover", () =>
      poly
        .bindTooltip(
          `${formatDistance(map.distance([a.lat, a.lng], [b.lat, b.lng]))} • ${
            a.freqGHz
          } GHz`
        )
        .openTooltip()
    );

  links.push({
    id,
    aId,
    bId,
    freqGHz: a.freqGHz,
    polyline: poly,
    fresnelPoly: null,
  });

  refreshUI();
}

async function onLinkClicked(id) {
  clearAllFresnel();
  const l = links.find((x) => x.id === id);
  if (!l) return;
  const a = towers.find((t) => t.id === l.aId),
    b = towers.find((t) => t.id === l.bId);
  if (!a || !b) return;

  const N = 40;
  const samples = [];
  for (let i = 0; i <= N; i++) {
    const f = i / N;
    samples.push({
      lat: a.lat + (b.lat - a.lat) * f,
      lng: a.lng + (b.lng - a.lng) * f,
    });
  }

  showLoading(true);
  let elevations = [];
  try {
    const resp = await fetch(
      `https://api.open-elevation.com/api/v1/lookup?locations=${encodeURIComponent(
        samples.map((s) => `${s.lat},${s.lng}`).join("|")
      )}`
    );
    const json = await resp.json();
    elevations = (json.results || []).map((r) => r.elevation || 0);
    if (elevations.length !== samples.length) elevations = samples.map(() => 0);
  } catch (e) {
    elevations = samples.map(() => 0);
    console.warn(e);
  } finally {
    showLoading(false);
  }

  const fHz = l.freqGHz * 1e9;
  const lambda = c / fHz;

  const radii = samples.map((s, i) => {
    const d1 = dist(a, s);
    const d2 = dist(s, b);
    return Math.sqrt((lambda * d1 * d2) / (d1 + d2));
  });

  const left = [];
  const right = [];

  for (let i = 0; i < samples.length; i++) {
    const p = samples[i];
    const prev = i === 0 ? samples[i] : samples[i - 1];
    const next = i === samples.length - 1 ? samples[i] : samples[i + 1];

    const dx = next.lng - prev.lng;
    const dy = next.lat - prev.lat;
    const len = Math.sqrt(dx * dx + dy * dy) || 1e-9;
    const nx = -dy / len;
    const ny = dx / len;

    const rLat = radii[i] / 111320;
    const rLng = radii[i] / (111320 * Math.cos((p.lat * Math.PI) / 180));

    left.push([p.lat + ny * rLat, p.lng + nx * rLng]);
    right.push([p.lat - ny * rLat, p.lng - nx * rLng]);
  }

  l.fresnelPoly = L.polygon(left.concat(right.reverse()), {
    color: "#16a34a",
    fillColor: "#a7f3d0",
    fillOpacity: 0.45,
  }).addTo(map);

  map.fitBounds(l.fresnelPoly.getBounds(), { padding: [40, 40] });
}

function dist(a, b) {
  const R = 6371000;
  const d2r = (d) => (d * Math.PI) / 180;
  const dLat = d2r(b.lat - a.lat);
  const dLon = d2r(b.lng - a.lng);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(d2r(a.lat)) * Math.cos(d2r(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function updateAllPolylines() {
  links.forEach((l) => {
    const a = towers.find((t) => t.id === l.aId);
    const b = towers.find((t) => t.id === l.bId);
    if (a && b && l.polyline)
      l.polyline.setLatLngs([
        [a.lat, a.lng],
        [b.lat, b.lng],
      ]);
  });
}

function clearAllFresnel() {
  links.forEach((l) => {
    if (l.fresnelPoly) map.removeLayer(l.fresnelPoly);
    l.fresnelPoly = null;
  });
}
function showFresnel(id) {
  const l = links.find((x) => x.id === id);
  if (l) onLinkClicked(id);
}
function openPopup(id) {
  const t = towers.find((x) => x.id === id);
  if (t && t.marker) t.marker.openPopup();
}

function removeLink(id) {
  const idx = links.findIndex((x) => x.id === id);
  if (idx === -1) return;
  map.removeLayer(links[idx].polyline);
  if (links[idx].fresnelPoly) map.removeLayer(links[idx].fresnelPoly);
  links.splice(idx, 1);
  refreshUI();
}

function exportGeoJSON() {
  const features = [
    ...towers.map((t) => ({
      type: "Feature",
      properties: { id: t.id, name: t.name, freqGHz: t.freqGHz, type: "tower" },
      geometry: { type: "Point", coordinates: [t.lng, t.lat] },
    })),
    ...links
      .map((l) => {
        const a = towers.find((t) => t.id === l.aId);
        const b = towers.find((t) => t.id === l.bId);
        return a && b
          ? {
              type: "Feature",
              properties: { id: l.id, freqGHz: l.freqGHz, type: "link" },
              geometry: {
                type: "LineString",
                coordinates: [
                  [a.lng, a.lat],
                  [b.lng, b.lat],
                ],
              },
            }
          : null;
      })
      .filter(Boolean),
  ];

  const blob = new Blob(
    [JSON.stringify({ type: "FeatureCollection", features }, null, 2)],
    {
      type: "application/json",
    }
  );
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "scene.geojson";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function clearAll() {
  towers.forEach((t) => map.removeLayer(t.marker));
  links.forEach((l) => {
    map.removeLayer(l.polyline);
    if (l.fresnelPoly) map.removeLayer(l.fresnelPoly);
  });
  towers.length = 0;
  links.length = 0;
  refreshUI();
}

function showLoading(v) {
  const el = document.getElementById("loading");
  if (el) el.style.display = v ? "block" : "none";
}

function refreshUI() {
  const towerListEl = document.getElementById("towerList");
  const linkListEl = document.getElementById("linkList");

  if (towerListEl) {
    towerListEl.innerHTML = towers
      .map(
        (t) => `<div class="item"><div><b>${escapeHtml(
          t.name
        )}</b><div class="meta">${t.freqGHz} GHz • ${t.lat.toFixed(
          4
        )}, ${t.lng.toFixed(4)}</div></div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <button onclick="openPopup('${t.id}')">Edit</button>
        <button onclick="removeTower('${t.id}')">Delete</button>
      </div></div>`
      )
      .join("");
  }

  if (linkListEl) {
    linkListEl.innerHTML = links
      .map((l) => {
        const a = towers.find((t) => t.id === l.aId);
        const b = towers.find((t) => t.id === l.bId);
        const d = a && b ? map.distance([a.lat, a.lng], [b.lat, b.lng]) : 0;
        return `<div class="item"><div><b>${escapeHtml(
          a?.name || "—"
        )} ↔ ${escapeHtml(b?.name || "—")}</b><div class="meta">${
          l.freqGHz
        } GHz • ${formatDistance(d)}</div></div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <button onclick="showFresnel('${l.id}')">Show Fresnel</button>
        <button onclick="removeLink('${l.id}')">Delete</button>
      </div></div>`;
      })
      .join("");
  }
}

window.openPopup = openPopup;
window.removeLink = removeLink;
window.removeTower = removeTower;
window.showFresnel = showFresnel;

window.addEventListener("resize", () => {
  setTimeout(() => {
    try {
      if (map && typeof map.invalidateSize === "function") map.invalidateSize();
    } catch (e) {}
  }, 200);
});
