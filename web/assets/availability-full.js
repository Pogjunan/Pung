"use strict";

const DATA_URL = "data/ws_availability_full_history.json.gz.b64";
const HOUR_MS = 60 * 60 * 1000;
const BASE_EVENT_MS = 360;
const KOREA_BOUNDS = L.latLngBounds(
  [31.55, 124.20],
  [38.85, 130.75],
);

const elements = {
  loading: document.getElementById("loading-panel"),
  currentDate: document.getElementById("current-date"),
  activeTotal: document.getElementById("active-total"),
  everOn: document.getElementById("ever-on"),
  activeTrain: document.getElementById("active-train"),
  activeVerify: document.getElementById("active-verify"),
  dataRange: document.getElementById("data-range"),
  coverageAudit: document.getElementById("coverage-audit"),
  unmappedGroups: document.getElementById("unmapped-groups"),
  slider: document.getElementById("time-slider"),
  sliderDate: document.getElementById("slider-date"),
  play: document.getElementById("play-toggle"),
  previous: document.getElementById("previous-hour"),
  next: document.getElementById("next-hour"),
  speedButtons: [...document.querySelectorAll("[data-speed]")],
};

const state = {
  payload: null,
  map: null,
  markers: new Map(),
  currentIndex: 0,
  timer: null,
  playing: false,
  speed: 1,
  changeIndices: [],
  offsets: new Map(),
  startEpochMs: 0,
};

function displayTimestamp(index) {
  return new Date(
    state.startEpochMs + index * HOUR_MS,
  ).toISOString().slice(0, 16).replace("T", " ");
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
    records.sort((left, right) =>
      left.station.localeCompare(right.station),
    );
    if (records.length === 1) {
      state.offsets.set(records[0].id, {x: 0, y: 0});
      continue;
    }
    const radius = records.length >= 4 ? 17 : 13;
    records.forEach((record, index) => {
      const angle = (
        -Math.PI / 2
        + 2 * Math.PI * index / records.length
      );
      state.offsets.set(record.id, {
        x: Math.round(radius * Math.cos(angle)),
        y: Math.round(radius * Math.sin(angle)),
      });
    });
  }
}

function markerShape(record) {
  if (record.split === "TRAIN") {
    return (
      '<circle class="availability-shape" '
      + 'cx="15" cy="15" r="9"></circle>'
    );
  }
  return (
    '<polygon class="availability-shape" '
    + 'points="15,3 27,26 3,26"></polygon>'
  );
}

function markerIcon(record, currentState) {
  const splitClass = (
    record.split === "TRAIN" ? "train" : "verify"
  );
  const stateClass = (
    currentState === "ON"
      ? "is-on"
      : currentState === "NO_SOURCE"
        ? "is-no-source"
        : "is-off"
  );
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

function containsFrame(runs, frameIndex) {
  let left = 0;
  let right = runs.length - 1;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    const [start, end] = runs[middle];
    if (frameIndex < start) {
      right = middle - 1;
    } else if (frameIndex > end) {
      left = middle + 1;
    } else {
      return true;
    }
  }
  return false;
}

function recordState(record, frameIndex) {
  if (frameIndex < state.payload.time.source_start_index) {
    return "NO_SOURCE";
  }
  return containsFrame(record.on_frame_runs, frameIndex)
    ? "ON"
    : "OFF";
}

function popupContent(record, frameIndex, currentState) {
  const timestamp = displayTimestamp(frameIndex);
  const stateLabel = (
    currentState === "ON"
      ? "ON"
      : currentState === "NO_SOURCE"
        ? "NO SOURCE"
        : "OFF"
  );
  const stateClass = (
    currentState === "ON"
      ? "popup-on"
      : currentState === "NO_SOURCE"
        ? "popup-no-source"
        : "popup-off"
  );
  const coordinate = (
    record.latitude_deg == null || record.longitude_deg == null
      ? "좌표 미확인"
      : (
        `${Number(record.latitude_deg).toFixed(6)}, `
        + `${Number(record.longitude_deg).toFixed(6)}`
      )
  );
  const offset = state.offsets.get(record.id) || {x: 0, y: 0};
  const offsetNote = (
    offset.x !== 0 || offset.y !== 0
      ? (
        "<br><small>중복 위치 핀을 구분하려고 "
        + "아이콘만 화면상 소폭 분리했습니다.</small>"
      )
      : ""
  );

  return `
    <div class="availability-popup">
      <h3>${record.label_ko}</h3>
      <b>station:</b> <code>${record.station}</code><br>
      <b>physical_site_group:</b>
      <code>${record.physical_site_group}</code><br>
      <b>split:</b> ${record.split}<br>
      <b>현재 시간:</b> ${timestamp}<br>
      <b>현재 상태:</b>
      <strong class="${stateClass}">${stateLabel}</strong><br>
      <b>명목 좌표:</b> ${coordinate}<br>
      <b>coordinate_source:</b> ${record.coordinate_source}<br>
      <b>전체 ON 시간:</b>
      ${Number(record.on_hours).toLocaleString()}시간<br>
      <b>최초 ON:</b> ${record.first_on}<br>
      <b>최종 ON:</b> ${record.last_on}<br>
      <hr>
      <small>
        1990-01-01부터 원본 시작 전까지는 NO SOURCE입니다.
        OFF는 원본 시간축 안에서 현재 station 값이 없다는 뜻입니다.
      </small>
      ${offsetNote}
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
      attribution:
        "&copy; OpenStreetMap contributors &copy; CARTO",
    },
  ).addTo(state.map);

  const trainLayer = L.layerGroup().addTo(state.map);
  const verifyLayer = L.layerGroup().addTo(state.map);
  const bounds = [];
  const unmapped = [];

  buildVisualOffsets();

  for (const record of state.payload.groups) {
    if (
      record.latitude_deg == null
      || record.longitude_deg == null
    ) {
      unmapped.push(`${record.label_ko} (${record.station})`);
      continue;
    }

    const currentState = recordState(record, 0);
    const marker = L.marker(
      [record.latitude_deg, record.longitude_deg],
      {
        icon: markerIcon(record, currentState),
        title: record.label_ko,
        riseOnHover: true,
      },
    );
    marker.bindTooltip(
      (
        `${record.label_ko} · ${record.split}<br>`
        + `${record.first_on} ~ ${record.last_on}`
      ),
      {direction: "top", offset: [0, -10]},
    );
    marker.bindPopup(
      popupContent(record, 0, currentState),
      {maxWidth: 430},
    );
    marker.addTo(
      record.split === "TRAIN" ? trainLayer : verifyLayer,
    );
    state.markers.set(record.id, marker);
    bounds.push([record.latitude_deg, record.longitude_deg]);
  }

  L.control.layers(
    null,
    {
      [`TRAIN · 빨간 원 (${state.payload.counts.train_station_ids})`]:
        trainLayer,
      [`VERIFY · 파란 삼각형 (${state.payload.counts.verify_station_ids})`]:
        verifyLayer,
    },
    {collapsed: false},
  ).addTo(state.map);

  if (bounds.length) {
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
    window.setTimeout(
      () => state.map.invalidateSize(false),
      delay,
    );
  }
}

function buildChangeIndices() {
  const changes = new Set([
    0,
    state.payload.time.source_start_index,
    state.payload.time.source_end_index,
  ]);
  const frameCount = state.payload.time.frame_count;

  for (const record of state.payload.groups) {
    for (const [start, end] of record.on_frame_runs) {
      changes.add(start);
      if (end + 1 < frameCount) {
        changes.add(end + 1);
      }
    }
  }
  state.changeIndices = [...changes].sort(
    (left, right) => left - right,
  );
}

function updateFrame(index) {
  const frameCount = state.payload.time.frame_count;
  state.currentIndex = Math.max(
    0,
    Math.min(index, frameCount - 1),
  );
  elements.slider.value = String(state.currentIndex);

  const timestamp = displayTimestamp(state.currentIndex);
  let trainActive = 0;
  let verifyActive = 0;
  let mappedActive = 0;

  for (const record of state.payload.groups) {
    const currentState = recordState(
      record,
      state.currentIndex,
    );
    if (currentState === "ON") {
      if (record.split === "TRAIN") {
        trainActive += 1;
      } else {
        verifyActive += 1;
      }
    }

    const marker = state.markers.get(record.id);
    if (!marker) {
      continue;
    }
    if (currentState === "ON") {
      mappedActive += 1;
    }
    marker.setIcon(markerIcon(record, currentState));
    marker.setPopupContent(
      popupContent(record, state.currentIndex, currentState),
    );
  }

  const totalActive = trainActive + verifyActive;
  elements.currentDate.textContent = timestamp;
  elements.sliderDate.textContent = timestamp;
  elements.activeTotal.textContent = (
    `ON ${totalActive}/${state.payload.counts.station_ids}`
    + ` · 지도 ${mappedActive}/`
    + `${state.payload.counts.mapped_station_ids}`
  );
  elements.everOn.textContent = (
    `EVER ON ${state.payload.counts.stations_ever_on}/`
    + `${state.payload.counts.station_ids}`
  );
  elements.activeTrain.textContent = (
    `TRAIN ${trainActive}/`
    + `${state.payload.counts.train_station_ids}`
  );
  elements.activeVerify.textContent = (
    `VERIFY ${verifyActive}/`
    + `${state.payload.counts.verify_station_ids}`
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
  return Math.max(
    55,
    Math.round(BASE_EVENT_MS / state.speed),
  );
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
  return (
    left < state.changeIndices.length
      ? state.changeIndices[left]
      : null
  );
}

function startPlayback() {
  stopPlayback();
  const lastIndex = state.payload.time.frame_count - 1;
  if (state.currentIndex >= lastIndex) {
    updateFrame(0);
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
    updateFrame(nextIndex);
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

function bindControls() {
  elements.slider.addEventListener("input", () => {
    stopPlayback();
    updateFrame(Number(elements.slider.value));
  });
  elements.play.addEventListener("click", togglePlayback);
  elements.previous.addEventListener("click", () => {
    stopPlayback();
    updateFrame(state.currentIndex - 1);
  });
  elements.next.addEventListener("click", () => {
    stopPlayback();
    updateFrame(state.currentIndex + 1);
  });
  for (const button of elements.speedButtons) {
    button.addEventListener("click", () => {
      setSpeed(Number(button.dataset.speed));
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement) {
      return;
    }
    if (event.code === "Space") {
      event.preventDefault();
      togglePlayback();
    } else if (event.code === "ArrowLeft") {
      stopPlayback();
      updateFrame(state.currentIndex - 1);
    } else if (event.code === "ArrowRight") {
      stopPlayback();
      updateFrame(state.currentIndex + 1);
    }
  });

  window.addEventListener("resize", () => {
    if (state.map) {
      state.map.invalidateSize(false);
    }
  });
  window.addEventListener("pageshow", () => {
    if (state.map) {
      window.setTimeout(
        () => state.map.invalidateSize(false),
        60,
      );
    }
  });
}

async function decodePayload(response) {
  const encodedPayload = (await response.text()).trim();
  const binary = atob(encodedPayload);
  const compressed = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    compressed[index] = binary.charCodeAt(index);
  }
  if (!("DecompressionStream" in window)) {
    throw new Error(
      "이 브라우저는 gzip DecompressionStream을 지원하지 않습니다",
    );
  }
  const stream = new Blob([compressed])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).json();
}

async function initialize() {
  try {
    const response = await fetch(DATA_URL, {cache: "no-store"});
    if (!response.ok) {
      throw new Error(
        `full-history data request failed: ${response.status}`,
      );
    }
    state.payload = await decodePayload(response);

    if (
      state.payload.schema_version !== 5
      || state.payload.record_grain !== "station_column"
      || state.payload.encoding
        !== (
          "continuous_hour_sequence_from_1990_"
          + "with_per_station_inclusive_frame_runs"
        )
      || !Array.isArray(state.payload.groups)
    ) {
      throw new Error("unsupported full-history schema");
    }

    const neverOn = state.payload.groups
      .filter((record) => record.on_hours <= 0)
      .map((record) => record.station);
    if (neverOn.length) {
      throw new Error(
        `한 번도 ON이 없는 WS station: ${neverOn.join(", ")}`,
      );
    }

    state.startEpochMs = Date.parse(
      `${state.payload.time.timeline_start.replace(" ", "T")}Z`,
    );
    elements.slider.min = "0";
    elements.slider.max = String(
      state.payload.time.frame_count - 1,
    );

    buildChangeIndices();
    createMap();
    bindControls();
    updateFrame(0);

    elements.dataRange.textContent = (
      `표시: ${state.payload.time.timeline_start}`
      + ` ~ ${state.payload.time.source_end}`
      + ` · 원본 시작 ${state.payload.time.source_start}`
    );
    elements.coverageAudit.textContent = (
      `전체 ON 이력: `
      + `${state.payload.counts.stations_ever_on}/`
      + `${state.payload.counts.station_ids}`
      + ` · 한 번도 ON 없음: `
      + `${state.payload.counts.stations_never_on}`
    );

    elements.loading.remove();
  } catch (error) {
    console.error(error);
    elements.loading.textContent = (
      `자료를 불러오지 못했습니다: ${error.message}`
    );
    elements.loading.classList.add("error");
  }
}

initialize();
