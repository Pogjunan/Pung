"use strict";

const DATA_URL = "data/ws_availability_common_hourly.json.gz.b64";
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
  activeTrain: document.getElementById("active-train"),
  activeVerify: document.getElementById("active-verify"),
  dataRange: document.getElementById("data-range"),
  unmappedGroups: document.getElementById("unmapped-groups"),
  slider: document.getElementById("date-slider"),
  sliderDate: document.getElementById("slider-date"),
  play: document.getElementById("play-toggle"),
  previous: document.getElementById("previous-day"),
  next: document.getElementById("next-day"),
  speedButtons: [...document.querySelectorAll("[data-speed]")],
};

const state = {
  payload: null,
  map: null,
  markers: new Map(),
  recordById: new Map(),
  currentIndex: 0,
  timer: null,
  playing: false,
  speed: 1,
  timestamps: [],
  activeByFrame: [],
  trainCountByFrame: [],
  verifyCountByFrame: [],
  changeIndices: [],
  offsets: new Map(),
};

function displayTimestamp(value) {
  return value.slice(0, 16);
}

function expandTimestamps() {
  const frameCount = state.payload.counts.selected_frames;
  state.timestamps = Array(frameCount);

  for (const run of state.payload.time.runs) {
    const startMs = Date.parse(run.start.replace(" ", "T") + "Z");
    if (!Number.isFinite(startMs)) {
      throw new Error(`invalid timestamp run start: ${run.start}`);
    }
    for (let offset = 0; offset < run.count; offset += 1) {
      const frameIndex = run.frame_start + offset;
      state.timestamps[frameIndex] = new Date(
        startMs + offset * HOUR_MS,
      ).toISOString().slice(0, 19).replace("T", " ");
    }
  }

  if (state.timestamps.some((value) => !value)) {
    throw new Error("timestamp runs do not cover every retained frame");
  }
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

function selectedWindowMessage(record) {
  if (record.selected_on_hours > 0) {
    return (
      `${record.selected_first_on} ~ ${record.selected_last_on}`
      + ` (${record.selected_on_hours.toLocaleString()}시간)`
    );
  }
  return "선택한 TRAIN·VERIFY 공통 시간대에서는 관측 없음";
}

function popupContent(record, timestamp, observed) {
  const stateLabel = observed ? "ON" : "OFF";
  const coordinate = (
    record.latitude_deg == null || record.longitude_deg == null
      ? "좌표 미확인"
      : `${Number(record.latitude_deg).toFixed(6)}, ${Number(record.longitude_deg).toFixed(6)}`
  );
  const offsetApplied = state.offsets.get(record.id);
  const visualOffsetNote = (
    offsetApplied && (offsetApplied.x !== 0 || offsetApplied.y !== 0)
      ? "<br><small>중복 위치 핀을 구분하기 위해 아이콘만 화면상 소폭 이동했습니다.</small>"
      : ""
  );
  const noSelectedObservationNote = (
    record.selected_on_hours === 0
      ? "<br><strong class='popup-off'>이 station은 원본 전체 파일에는 관측값이 있지만, 선택한 공통 시간대 밖에서만 관측됐습니다.</strong>"
      : ""
  );

  return `
    <div class="availability-popup">
      <h3>${record.label_ko || record.station}</h3>
      <b>station:</b> <code>${record.station}</code><br>
      <b>physical_site_group:</b> <code>${record.physical_site_group}</code><br>
      <b>split:</b> ${record.split}<br>
      <b>시간:</b> ${displayTimestamp(timestamp)}<br>
      <b>관측 상태:</b>
      <strong class="${observed ? "popup-on" : "popup-off"}">${stateLabel}</strong><br>
      <b>시간별 판정:</b> 업로드 ON/OFF CSV의 값 1이면 ON, 0이면 OFF<br>
      <b>명목 좌표:</b> ${coordinate}<br>
      <b>coordinate_source:</b> ${record.coordinate_source}<br>
      <b>공통구간 관측:</b> ${selectedWindowMessage(record)}<br>
      <b>원본 전체 관측:</b> ${record.full_first_on} ~ ${record.full_last_on}
      (${record.full_on_hours.toLocaleString()}시간)<br>
      <hr>
      <small>
        표시 프레임은 TRAIN과 VERIFY에 각각 하나 이상의 ON station이 존재하는 시간만 남겼습니다.
      </small>
      ${noSelectedObservationNote}
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
      unmapped.push(`${record.label_ko || record.station} (${record.station})`);
      continue;
    }

    const marker = L.marker(
      [record.latitude_deg, record.longitude_deg],
      {
        icon: markerIcon(record, false),
        title: record.label_ko || record.station,
        riseOnHover: true,
      },
    );
    marker.bindTooltip(
      `${record.label_ko || record.station} · ${record.split}<br>`
      + `공통구간 ON ${record.selected_on_hours.toLocaleString()}시간`,
      {direction: "top", offset: [0, -10]},
    );
    marker.bindPopup(
      popupContent(record, state.timestamps[0], false),
      {maxWidth: 460},
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

function buildFrameIndex() {
  const frameCount = state.payload.counts.selected_frames;
  state.activeByFrame = Array.from({length: frameCount}, () => []);
  state.trainCountByFrame = new Uint8Array(frameCount);
  state.verifyCountByFrame = new Uint8Array(frameCount);

  for (const record of state.payload.groups) {
    for (const [startIndex, endIndex] of record.selected_on_runs) {
      for (let frame = startIndex; frame <= endIndex; frame += 1) {
        state.activeByFrame[frame].push(record.id);
        if (record.split === "TRAIN") {
          state.trainCountByFrame[frame] += 1;
        } else {
          state.verifyCountByFrame[frame] += 1;
        }
      }
    }
  }

  for (let frame = 0; frame < frameCount; frame += 1) {
    if (
      state.trainCountByFrame[frame] < 1
      || state.verifyCountByFrame[frame] < 1
    ) {
      throw new Error(`frame ${frame} violates TRAIN/VERIFY common-hour rule`);
    }
  }

  state.changeIndices = [...state.payload.time.change_indices];
  if (state.changeIndices[0] !== 0) {
    state.changeIndices.unshift(0);
  }
}

function observedForFrame(index) {
  return new Set(state.activeByFrame[index] || []);
}

function updateFrame(index) {
  const lastIndex = state.payload.counts.selected_frames - 1;
  state.currentIndex = Math.max(0, Math.min(index, lastIndex));
  elements.slider.value = String(state.currentIndex);

  const timestamp = state.timestamps[state.currentIndex];
  const observedRecords = observedForFrame(state.currentIndex);
  let mappedActive = 0;

  for (const record of state.payload.groups) {
    const observed = observedRecords.has(record.id);
    const marker = state.markers.get(record.id);
    if (!marker) {
      continue;
    }
    if (observed) {
      mappedActive += 1;
    }
    marker.setIcon(markerIcon(record, observed));
    marker.setPopupContent(popupContent(record, timestamp, observed));
  }

  const trainActive = state.trainCountByFrame[state.currentIndex];
  const verifyActive = state.verifyCountByFrame[state.currentIndex];
  const totalActive = trainActive + verifyActive;
  elements.currentDate.textContent = displayTimestamp(timestamp);
  elements.sliderDate.textContent = displayTimestamp(timestamp);
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
  return left < state.changeIndices.length
    ? state.changeIndices[left]
    : null;
}

function startPlayback() {
  stopPlayback();
  const lastIndex = state.payload.counts.selected_frames - 1;
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
      window.setTimeout(() => state.map.invalidateSize(false), 60);
    }
  });
}

async function decodeResponse(response) {
  const encodedPayload = (await response.text()).trim();
  const binary = atob(encodedPayload);
  const compressed = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    compressed[index] = binary.charCodeAt(index);
  }
  if (!("DecompressionStream" in window)) {
    throw new Error("이 브라우저는 gzip DecompressionStream을 지원하지 않습니다");
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
      throw new Error(`availability data request failed: ${response.status}`);
    }
    state.payload = await decodeResponse(response);

    if (
      state.payload.schema_version !== 4
      || state.payload.record_grain !== "station_column"
      || state.payload.encoding !== (
        "filtered_common_hour_sequence_with_per_station_inclusive_frame_runs"
      )
      || !Array.isArray(state.payload.groups)
      || !state.payload.groups.every(
        (record) => record.station && Array.isArray(record.selected_on_runs),
      )
    ) {
      throw new Error("unsupported common-hour availability schema");
    }

    expandTimestamps();
    buildFrameIndex();

    elements.dataRange.textContent = (
      `공통 시간대: ${state.payload.selection.retained_start}`
      + ` ~ ${state.payload.selection.retained_end}`
      + ` · ${state.payload.counts.selected_frames.toLocaleString()}시간`
      + " · 재생은 상태 변화 시점으로 이동"
    );

    elements.slider.min = "0";
    elements.slider.max = String(state.payload.counts.selected_frames - 1);
    elements.slider.value = "0";

    createMap();
    bindControls();
    updateFrame(0);
    elements.loading.remove();
  } catch (error) {
    console.error(error);
    elements.loading.textContent = `자료를 불러오지 못했습니다: ${error.message}`;
    elements.loading.classList.add("error");
  }
}

initialize();
