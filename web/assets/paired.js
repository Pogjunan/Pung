"use strict";

const BASE_EVENT_MS = 360;
const HOUR_MS = 60 * 60 * 1000;
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
  activeTest: document.getElementById("active-test"),
  dataRange: document.getElementById("data-range"),
  selectionSummary: document.getElementById("selection-summary"),
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
  startEpochMs: 0,
};

function displayTimestamp(index) {
  return new Date(
    state.startEpochMs + index * HOUR_MS,
  ).toISOString().slice(0, 16).replace("T", " ");
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

function markerShape(record) {
  if (record.role === "TRAIN") {
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

function markerIcon(record, observed) {
  const splitClass = (
    record.role === "TRAIN" ? "train" : "verify"
  );
  const stateClass = observed ? "is-on" : "is-off";
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
    iconAnchor: [15, 15],
  });
}

function popupContent(record, observed) {
  const stationList = record.member_stations
    .map((station) => `<code>${station}</code>`)
    .join(", ");
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
      <b>model role:</b> ${record.role}<br>
      <b>physical_site_group:</b>
      <code>${record.physical_site_group}</code><br>
      <b>현재 시간:</b> ${displayTimestamp(state.currentIndex)}<br>
      <b>paired state:</b>
      <strong class="${observed ? "popup-on" : "popup-off"}">
        ${observed ? "ON" : "OFF"}
      </strong><br>
      <b>member stations:</b> ${stationList}<br>
      <b>명목 좌표:</b> ${coordinate}<br>
      <b>coordinate_source:</b> ${record.coordinate_source}<br>
      <b>전체 paired ON:</b>
      ${Number(record.on_hours).toLocaleString()}시간<br>
      <b>최초 paired ON:</b> ${record.first_on}<br>
      <b>최종 paired ON:</b> ${record.last_on}<br>
      <hr>
      <small>
        동일 물리 지점의 복수 station은 OR로 결합했습니다.
        WS 시간은 WRF 시간 +9h 정렬 기준입니다.
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
  const testLayer = L.layerGroup().addTo(state.map);
  const bounds = [];
  const unmapped = [];

  for (const record of state.payload.groups) {
    if (
      record.latitude_deg == null
      || record.longitude_deg == null
    ) {
      unmapped.push(`${record.label_ko} (${record.physical_site_group})`);
      continue;
    }

    const observed = containsFrame(
      record.on_frame_runs,
      state.currentIndex,
    );
    const marker = L.marker(
      [record.latitude_deg, record.longitude_deg],
      {
        icon: markerIcon(record, observed),
        title: record.label_ko,
        riseOnHover: true,
      },
    );
    marker.bindTooltip(
      `${record.label_ko} · ${record.role}`,
      {direction: "top", offset: [0, -10]},
    );
    marker.bindPopup(
      popupContent(record, observed),
      {maxWidth: 430},
    );
    marker.addTo(
      record.role === "TRAIN" ? trainLayer : testLayer,
    );
    state.markers.set(record.id, marker);
    bounds.push([record.latitude_deg, record.longitude_deg]);
  }

  L.control.layers(
    null,
    {
      [`TRAIN · 빨간 원 (${state.payload.counts.train_sites})`]:
        trainLayer,
      [`TEST · 파란 삼각형 (${state.payload.counts.test_sites})`]:
        testLayer,
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
      : "좌표 미확인 paired site 없음"
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
    state.payload.time.frame_count - 1,
  ]);
  for (const record of state.payload.groups) {
    for (const [start, end] of record.on_frame_runs) {
      changes.add(start);
      if (end + 1 < state.payload.time.frame_count) {
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
    Math.min(index, state.payload.time.frame_count - 1),
  );
  elements.slider.value = String(state.currentIndex);

  let trainActive = 0;
  let testActive = 0;
  let mappedActive = 0;

  for (const record of state.payload.groups) {
    const observed = containsFrame(
      record.on_frame_runs,
      state.currentIndex,
    );
    if (observed) {
      if (record.role === "TRAIN") {
        trainActive += 1;
      } else {
        testActive += 1;
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
    marker.setPopupContent(popupContent(record, observed));
  }

  const totalActive = trainActive + testActive;
  const timestamp = displayTimestamp(state.currentIndex);
  elements.currentDate.textContent = timestamp;
  elements.sliderDate.textContent = timestamp;
  elements.activeTotal.textContent = (
    `ON ${totalActive}/${state.payload.counts.total_sites}`
    + ` · 지도 ${mappedActive}/${state.payload.counts.mapped_sites}`
  );
  elements.everOn.textContent = (
    `EVER ON ${state.payload.counts.sites_ever_on}/`
    + `${state.payload.counts.total_sites}`
  );
  elements.activeTrain.textContent = (
    `TRAIN ${trainActive}/${state.payload.counts.train_sites}`
  );
  elements.activeTest.textContent = (
    `TEST ${testActive}/${state.payload.counts.test_sites}`
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
  if (
    state.currentIndex
    >= state.payload.time.frame_count - 1
  ) {
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
    state.payload = window.PAIRED_DATA;
    if (!state.payload) {
      throw new Error("paired-data.js가 로드되지 않았습니다");
    }
    if (
      state.payload.schema_version !== 1
      || state.payload.record_grain !== "paired_physical_site"
      || state.payload.encoding
        !== "contiguous_hour_sequence_with_per_site_inclusive_frame_runs"
    ) {
      throw new Error("unsupported paired availability schema");
    }

    if (
      state.payload.counts.train_sites !== 8
      || state.payload.counts.test_sites !== 7
      || state.payload.counts.sites_ever_on !== 15
      || state.payload.counts.sites_never_on !== 0
    ) {
      throw new Error("paired 8/7 selection validation failed");
    }

    state.startEpochMs = Date.parse(
      `${state.payload.time.start.replace(" ", "T")}Z`,
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
      `pair 범위: ${state.payload.time.start}`
      + ` ~ ${state.payload.time.end}`
    );
    elements.selectionSummary.textContent = (
      `선정: Train ${state.payload.counts.train_sites}개`
      + ` · Test ${state.payload.counts.test_sites}개`
      + ` · 전체 이력 ${state.payload.counts.sites_ever_on}/`
      + `${state.payload.counts.total_sites}`
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
