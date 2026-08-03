"use strict";

const DAY_MS = 24 * 60 * 60 * 1000;
const TIMELINE_START = "1990-01-01";
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
  offsets: new Map(),
  currentIndex: 0,
  timer: null,
  playing: false,
  speed: 1,
  changeIndices: [],
  timelineStartDay: 0,
  sourceOffset: 0,
  frameCount: 0,
};

function dayNumber(dateString) {
  return Math.round(
    Date.parse(`${dateString}T00:00:00Z`) / DAY_MS,
  );
}

function displayDate(index) {
  return new Date(
    (state.timelineStartDay + index) * DAY_MS,
  ).toISOString().slice(0, 10);
}

function shiftedRuns(record) {
  return record.on_day_runs.map(([start, end]) => [
    start + state.sourceOffset,
    end + state.sourceOffset,
  ]);
}

function containsFrame(runs, index) {
  let left = 0;
  let right = runs.length - 1;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    const [start, end] = runs[middle];
    if (index < start) {
      right = middle - 1;
    } else if (index > end) {
      left = middle + 1;
    } else {
      return true;
    }
  }
  return false;
}

function recordState(record, index) {
  if (index < state.sourceOffset) {
    return "NO_SOURCE";
  }
  return containsFrame(record.shifted_on_day_runs, index)
    ? "ON"
    : "OFF";
}

function buildVisualOffsets() {
  const members = new Map();
  for (const record of state.payload.groups) {
    const key = record.physical_site_group || record.station;
    if (!members.has(key)) {
      members.set(key, []);
    }
    members.get(key).push(record);
  }

  for (const records of members.values()) {
    records.sort((a, b) => a.station.localeCompare(b.station));
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

function popupContent(record, currentState) {
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

  return `
    <div class="availability-popup">
      <h3>${record.label_ko}</h3>
      <b>station:</b> <code>${record.station}</code><br>
      <b>physical_site_group:</b>
      <code>${record.physical_site_group}</code><br>
      <b>split:</b> ${record.split}<br>
      <b>현재 날짜:</b> ${displayDate(state.currentIndex)}<br>
      <b>현재 상태:</b>
      <strong class="${stateClass}">${stateLabel}</strong><br>
      <b>명목 좌표:</b> ${coordinate}<br>
      <b>coordinate_source:</b> ${record.coordinate_source}<br>
      <b>전체 관측시간:</b>
      ${Number(record.observed_unique_hours).toLocaleString()}시간<br>
      <b>전체 관측일:</b>
      ${Number(record.observed_days).toLocaleString()}일<br>
      <b>최초 관측:</b> ${record.first_observation}<br>
      <b>최종 관측:</b> ${record.last_observation}<br>
      <hr>
      <small>
        1990-01-01부터 원본 시작 전까지는 NO SOURCE입니다.
        EVER ON은 전체 원본 기간에서 최소 한 날짜 이상 ON인지 검증합니다.
      </small>
    </div>
  `;
}

function createMap() {
  state.map = L.map("availability-map", {
    zoomControl: true,
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
    record.shifted_on_day_runs = shiftedRuns(record);
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
        + `${record.first_observation.slice(0, 10)}`
        + ` ~ ${record.last_observation.slice(0, 10)}`
      ),
      {direction: "top", offset: [0, -10]},
    );
    marker.bindPopup(
      popupContent(record, currentState),
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
    state.sourceOffset,
    state.frameCount - 1,
  ]);
  for (const record of state.payload.groups) {
    for (const [start, end] of record.shifted_on_day_runs) {
      changes.add(start);
      if (end + 1 < state.frameCount) {
        changes.add(end + 1);
      }
    }
  }
  state.changeIndices = [...changes].sort(
    (left, right) => left - right,
  );
}

function updateFrame(index) {
  state.currentIndex = Math.max(
    0,
    Math.min(index, state.frameCount - 1),
  );
  elements.slider.value = String(state.currentIndex);

  let trainActive = 0;
  let verifyActive = 0;
  let mappedActive = 0;

  for (const record of state.payload.groups) {
    const currentState = recordState(record, state.currentIndex);
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
    marker.setPopupContent(popupContent(record, currentState));
  }

  const totalActive = trainActive + verifyActive;
  const date = displayDate(state.currentIndex);
  elements.currentDate.textContent = date;
  elements.sliderDate.textContent = date;
  elements.activeTotal.textContent = (
    `ON ${totalActive}/${state.payload.counts.station_ids}`
    + ` · 지도 ${mappedActive}/`
    + `${state.payload.counts.mapped_station_ids}`
  );
  elements.everOn.textContent = (
    `EVER ON ${state.payload.counts.station_ids}/`
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
  if (state.currentIndex >= state.frameCount - 1) {
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
}

function initialize() {
  try {
    state.payload = window.FULL_HISTORY_DATA;
    if (!state.payload) {
      throw new Error("full-history-data.js가 로드되지 않았습니다");
    }
    if (
      state.payload.schema_version !== 3
      || state.payload.record_grain !== "station_column"
      || state.payload.encoding
        !== "per_station_inclusive_day_index_runs"
    ) {
      throw new Error("unsupported full daily schema");
    }

    const neverOn = state.payload.groups
      .filter((record) => record.on_day_runs.length === 0)
      .map((record) => record.station);
    if (neverOn.length) {
      throw new Error(
        `한 번도 ON이 없는 station: ${neverOn.join(", ")}`,
      );
    }

    state.timelineStartDay = dayNumber(TIMELINE_START);
    state.sourceOffset = (
      dayNumber(state.payload.time.date_start)
      - state.timelineStartDay
    );
    state.frameCount = (
      state.sourceOffset
      + state.payload.counts.calendar_days
    );

    elements.slider.min = "0";
    elements.slider.max = String(state.frameCount - 1);

    createMap();
    buildChangeIndices();
    bindControls();
    updateFrame(0);

    elements.dataRange.textContent = (
      `표시: ${TIMELINE_START}`
      + ` ~ ${state.payload.time.date_end}`
      + ` · 원본 시작 ${state.payload.time.date_start}`
    );
    elements.coverageAudit.textContent = (
      `전체 ON 이력: ${state.payload.counts.station_ids}/`
      + `${state.payload.counts.station_ids}`
      + " · 한 번도 ON 없음: 0"
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
