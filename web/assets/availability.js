"use strict";

const DATA_URL = "data/ws_availability_daily.json.gz.b64";
const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_EVENT_MS = 360;
const KOREA_BOUNDS = L.latLngBounds(
  [31.55, 124.20],
  [38.85, 130.75],
);

const elements = {
  loading: document.getElementById("loading-panel"),
  currentDate: document.getElementById("current-date"),
  activeTotal: document.getElementById("active-total"),
  activeTrain: document.getElementById("active-train"),
  activeVerify: document.getElementById("active-verify"),
  dataRange: document.getElementById("data-range"),
  unmappedGroups: document.getElementById("unmapped-groups"),
  slider: document.getElementById("date-slider"),
  sliderDate: document.getElementById("slider-date"),
  play: document.getElementById("play-toggle"),
  previous: document.getElementById("previous-day"),
  next: document.getElementById("next-day"),
  rangePreset: document.getElementById("range-preset"),
  speedButtons: [...document.querySelectorAll("[data-speed]")],
};

const state = {
  payload: null,
  map: null,
  markers: new Map(),
  recordById: new Map(),
  currentIndex: 0,
  rangeStart: 0,
  rangeEnd: 0,
  timer: null,
  playing: false,
  speed: 1,
  activeByDay: [],
  changeIndices: [],
  offsets: new Map(),
};

function isoDayNumber(dateString) {
  return Math.round(Date.parse(`${dateString}T00:00:00Z`) / DAY_MS);
}

function dateAtIndex(index) {
  const start = isoDayNumber(state.payload.time.date_start);
  return new Date((start + index) * DAY_MS).toISOString().slice(0, 10);
}

function indexForDate(dateString) {
  return isoDayNumber(dateString) - isoDayNumber(state.payload.time.date_start);
}

function markerShape(record) {
  if (record.split === "TRAIN") {
    return '<circle class="availability-shape" cx="15" cy="15" r="9"></circle>';
  }
  return '<polygon class="availability-shape" points="15,3 27,26 3,26"></polygon>';
}

function buildVisualOffsets() {
  const membersByPhysicalGroup = new Map();
  for (const record of state.payload.groups) {
    const key = record.physical_site_group || record.station;
    if (!membersByPhysicalGroup.has(key)) {
      membersByPhysicalGroup.set(key, []);
    }
    membersByPhysicalGroup.get(key).push(record);
  }

  for (const records of membersByPhysicalGroup.values()) {
    records.sort((left, right) => left.station.localeCompare(right.station));
    if (records.length === 1) {
      state.offsets.set(records[0].id, {x: 0, y: 0});
      continue;
    }
    const radius = records.length >= 4 ? 17 : 13;
    records.forEach((record, index) => {
      const angle = (-Math.PI / 2) + (2 * Math.PI * index / records.length);
      state.offsets.set(record.id, {
        x: Math.round(radius * Math.cos(angle)),
        y: Math.round(radius * Math.sin(angle)),
      });
    });
  }
}

function markerIcon(record, observed) {
  const splitClass = record.split === "TRAIN" ? "train" : "verify";
  const stateClass = observed ? "is-on" : "is-off";
  const offset = state.offsets.get(record.id) || {x: 0, y: 0};
  const html = (
    `<div class="availability-marker ${splitClass} ${stateClass}">`
    + '<svg width="30" height="30" viewBox="0 0 30 30">'
    + markerShape(record)
    + "</svg></div>"
  );
  return L.divIcon({
    html,
    className: "availability-leaflet-icon",
    iconSize: [30, 30],
    iconAnchor: [15 - offset.x, 15 - offset.y],
    popupAnchor: [-offset.x, -offset.y - 4],
    tooltipAnchor: [-offset.x, -offset.y - 8],
  });
}

function popupContent(record, date, observed) {
  const stateLabel = observed ? "ON" : "OFF";
  const coordinate = (
    record.latitude_deg == null || record.longitude_deg == null
      ? "좌표 미확인"
      : `${Number(record.latitude_deg).toFixed(6)}, ${Number(record.longitude_deg).toFixed(6)}`
  );
  const offsetApplied = state.offsets.get(record.id);
  const visualOffsetNote = (
    offsetApplied && (offsetApplied.x !== 0 || offsetApplied.y !== 0)
      ? "<br><small>중복 위치 마커를 구분하기 위해 아이콘만 화면상 소폭 이동했습니다.</small>"
      : ""
  );
  return `
    <div class="availability-popup">
      <h3>${record.label_ko}</h3>
      <b>station:</b> <code>${record.station}</code><br>
      <b>physical_site_group:</b> <code>${record.physical_site_group}</code><br>
      <b>split:</b> ${record.split}<br>
      <b>날짜:</b> ${date}<br>
      <b>관측 상태:</b>
      <strong class="${observed ? "popup-on" : "popup-off"}">${stateLabel}</strong><br>
      <b>일별 판정:</b> 이 station 열에 non-null WS가 1시간 이상 존재<br>
      <b>명목 좌표:</b> ${coordinate}<br>
      <b>coordinate_source:</b> ${record.coordinate_source}<br>
      <b>GT class:</b> ${record.gt_class || "UNKNOWN"}<br>
      <b>전체 관측시간:</b> ${record.observed_unique_hours.toLocaleString()}시간<br>
      <b>전체 관측일:</b> ${record.observed_days.toLocaleString()}일<br>
      <b>최초 관측:</b> ${record.first_observation}<br>
      <b>최종 관측:</b> ${record.last_observation}<br>
      <hr>
      <small>
        OFF는 현재 날짜에 값이 없다는 의미이며, 이 station 열 전체가 빈 것은 아닙니다.
      </small>
      ${visualOffsetNote}
    </div>
  `;
}

function createMap() {
  state.map = L.map("availability-map", {
    zoomControl: true,
    preferCanvas: false,
    minZoom: 6,
    maxZoom: 12,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    maxBounds: KOREA_BOUNDS,
    maxBoundsViscosity: 1.0,
    worldCopyJump: false,
  });

  L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    {
      maxZoom: 19,
      noWrap: true,
      bounds: KOREA_BOUNDS.pad(0.18),
      keepBuffer: 3,
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    },
  ).addTo(state.map);

  const trainLayer = L.layerGroup().addTo(state.map);
  const verifyLayer = L.layerGroup().addTo(state.map);
  const bounds = [];
  const unmapped = [];

  buildVisualOffsets();

  for (const record of state.payload.groups) {
    state.recordById.set(record.id, record);
    if (record.latitude_deg == null || record.longitude_deg == null) {
      unmapped.push(`${record.label_ko} (${record.station})`);
      continue;
    }

    const marker = L.marker(
      [record.latitude_deg, record.longitude_deg],
      {
        icon: markerIcon(record, false),
        title: record.label_ko,
        riseOnHover: true,
      },
    );
    marker.bindTooltip(
      `${record.label_ko} · ${record.split}<br>${record.first_observation.slice(0, 10)} ~ ${record.last_observation.slice(0, 10)}`,
      {direction: "top", offset: [0, -10]},
    );
    marker.bindPopup(
      popupContent(record, state.payload.time.date_start, false),
      {maxWidth: 430},
    );
    marker.addTo(record.split === "TRAIN" ? trainLayer : verifyLayer);
    state.markers.set(record.id, marker);
    bounds.push([record.latitude_deg, record.longitude_deg]);
  }

  L.control.layers(
    null,
    {
      [`TRAIN · 빨간 원 (${state.payload.counts.train_station_ids})`]: trainLayer,
      [`VERIFY · 파란 삼각형 (${state.payload.counts.verify_station_ids})`]: verifyLayer,
    },
    {collapsed: false},
  ).addTo(state.map);

  if (bounds.length > 0) {
    state.map.fitBounds(bounds, {
      paddingTopLeft: [40, 90],
      paddingBottomRight: [40, 115],
      maxZoom: 8,
    });
  } else {
    state.map.fitBounds(KOREA_BOUNDS);
  }

  elements.unmappedGroups.textContent = (
    unmapped.length
      ? `좌표 미확인: ${unmapped.join(", ")}`
      : "좌표 미확인 station 없음"
  );

  for (const delay of [80, 260, 700]) {
    window.setTimeout(() => state.map.invalidateSize(false), delay);
  }
}

function buildDailyIndex() {
  const dayCount = state.payload.counts.calendar_days;
  state.activeByDay = Array.from({length: dayCount}, () => []);
  const changeSet = new Set([0, dayCount - 1]);

  for (const record of state.payload.groups) {
    for (const [startIndex, endIndex] of record.on_day_runs) {
      changeSet.add(startIndex);
      if (endIndex + 1 < dayCount) {
        changeSet.add(endIndex + 1);
      }
      for (let index = startIndex; index <= endIndex; index += 1) {
        state.activeByDay[index].push(record.id);
      }
    }
  }
  state.changeIndices = [...changeSet].sort((a, b) => a - b);
}

function observedForDay(index) {
  return new Set(state.activeByDay[index] || []);
}

function updateDay(index) {
  state.currentIndex = Math.max(state.rangeStart, Math.min(index, state.rangeEnd));
  elements.slider.value = String(state.currentIndex);

  const date = dateAtIndex(state.currentIndex);
  const observedRecords = observedForDay(state.currentIndex);
  let trainActive = 0;
  let verifyActive = 0;
  let mappedActive = 0;

  for (const record of state.payload.groups) {
    const observed = observedRecords.has(record.id);
    if (observed) {
      if (record.split === "TRAIN") {
        trainActive += 1;
      } else if (record.split === "VERIFY") {
        verifyActive += 1;
      }
    }

    const marker = state.markers.get(record.id);
    if (!marker) {
      continue;
    }
    if (observed) {
      mappedActive += 1;
    }
    marker.setIcon(markerIcon(record, observed));
    marker.setPopupContent(popupContent(record, date, observed));
  }

  const totalActive = trainActive + verifyActive;
  elements.currentDate.textContent = date;
  elements.sliderDate.textContent = date;
  elements.activeTotal.textContent = (
    `ON ${totalActive}/${state.payload.counts.station_ids}`
    + ` · 지도 ${mappedActive}/${state.payload.counts.mapped_station_ids}`
  );
  elements.activeTrain.textContent = (
    `TRAIN ${trainActive}/${state.payload.counts.train_station_ids}`
  );
  elements.activeVerify.textContent = (
    `VERIFY ${verifyActive}/${state.payload.counts.verify_station_ids}`
  );
}

function stopPlayback() {
  if (state.timer != null) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.playing = false;
  elements.play.textContent = "▶";
  elements.play.classList.remove("playing");
}

function frameInterval() {
  return Math.max(55, Math.round(BASE_EVENT_MS / state.speed));
}

function nextChangeIndex(currentIndex) {
  let left = 0;
  let right = state.changeIndices.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (state.changeIndices[middle] <= currentIndex) {
      left = middle + 1;
    } else {
      right = middle;
    }
  }
  while (left < state.changeIndices.length) {
    const candidate = state.changeIndices[left];
    if (candidate >= state.rangeStart && candidate <= state.rangeEnd) {
      return candidate;
    }
    left += 1;
  }
  return null;
}

function startPlayback() {
  stopPlayback();
  if (state.currentIndex >= state.rangeEnd) {
    updateDay(state.rangeStart);
  }
  state.playing = true;
  elements.play.textContent = "Ⅱ";
  elements.play.classList.add("playing");
  state.timer = setInterval(() => {
    const nextIndex = nextChangeIndex(state.currentIndex);
    if (nextIndex == null) {
      stopPlayback();
      return;
    }
    updateDay(nextIndex);
  }, frameInterval());
}

function togglePlayback() {
  if (state.playing) {
    stopPlayback();
  } else {
    startPlayback();
  }
}

function setSpeed(speed) {
  state.speed = speed;
  for (const button of elements.speedButtons) {
    button.classList.toggle(
      "active",
      Number(button.dataset.speed) === speed,
    );
  }
  if (state.playing) {
    startPlayback();
  }
}

function setRange(preset) {
  stopPlayback();
  const lastIndex = state.payload.counts.calendar_days - 1;
  if (preset === "recent") {
    state.rangeStart = Math.max(0, indexForDate("2015-01-01"));
  } else {
    state.rangeStart = 0;
  }
  state.rangeEnd = lastIndex;
  elements.slider.min = String(state.rangeStart);
  elements.slider.max = String(state.rangeEnd);
  updateDay(state.rangeStart);
}

function bindControls() {
  elements.slider.addEventListener("input", () => {
    stopPlayback();
    updateDay(Number(elements.slider.value));
  });
  elements.play.addEventListener("click", togglePlayback);
  elements.previous.addEventListener("click", () => {
    stopPlayback();
    updateDay(state.currentIndex - 1);
  });
  elements.next.addEventListener("click", () => {
    stopPlayback();
    updateDay(state.currentIndex + 1);
  });
  elements.rangePreset.addEventListener("change", () => {
    setRange(elements.rangePreset.value);
  });
  for (const button of elements.speedButtons) {
    button.addEventListener("click", () => {
      setSpeed(Number(button.dataset.speed));
    });
  }
  document.addEventListener("keydown", (event) => {
    if (
      event.target instanceof HTMLInputElement
      || event.target instanceof HTMLSelectElement
    ) {
      return;
    }
    if (event.code === "Space") {
      event.preventDefault();
      togglePlayback();
    } else if (event.code === "ArrowLeft") {
      stopPlayback();
      updateDay(state.currentIndex - 1);
    } else if (event.code === "ArrowRight") {
      stopPlayback();
      updateDay(state.currentIndex + 1);
    }
  });
  window.addEventListener("resize", () => {
    if (state.map) {
      state.map.invalidateSize(false);
    }
  });
  window.addEventListener("pageshow", () => {
    if (state.map) {
      window.setTimeout(() => state.map.invalidateSize(false), 60);
    }
  });
}

async function initialize() {
  try {
    const response = await fetch(DATA_URL, {cache: "no-store"});
    if (!response.ok) {
      throw new Error(`availability data request failed: ${response.status}`);
    }
    const encodedPayload = (await response.text()).trim();
    const binary = atob(encodedPayload);
    const compressed = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      compressed[index] = binary.charCodeAt(index);
    }
    if (!("DecompressionStream" in window)) {
      throw new Error("이 브라우저는 gzip DecompressionStream을 지원하지 않습니다");
    }
    const decompressedStream = new Blob([compressed])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    state.payload = await new Response(decompressedStream).json();

    if (
      state.payload.schema_version !== 3
      || state.payload.encoding !== "per_station_inclusive_day_index_runs"
      || !Array.isArray(state.payload.groups)
      || !state.payload.groups.every(
        (record) => record.station && Array.isArray(record.on_day_runs),
      )
    ) {
      throw new Error("unsupported station-level availability schema");
    }

    const emptyStations = state.payload.groups
      .filter((record) => record.on_day_runs.length === 0)
      .map((record) => record.station);
    if (emptyStations.length) {
      throw new Error(`관측 이력이 없는 station이 포함됨: ${emptyStations.join(", ")}`);
    }

    buildDailyIndex();
    elements.dataRange.textContent = (
      `자료 범위: ${state.payload.time.source_start}`
      + ` ~ ${state.payload.time.source_end}`
      + " · 재생은 상태 변화일로 이동"
    );

    createMap();
    bindControls();
    setRange("full");
    elements.loading.remove();
  } catch (error) {
    console.error(error);
    elements.loading.textContent = `자료를 불러오지 못했습니다: ${error.message}`;
    elements.loading.classList.add("error");
  }
}

initialize();
