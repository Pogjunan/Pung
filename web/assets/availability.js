"use strict";

const DATA_URL = "data/ws_availability_daily.json.gz.b64";
const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_FRAME_MS = 450;

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
  speedButtons: [
    ...document.querySelectorAll("[data-speed]"),
  ],
};

const state = {
  payload: null,
  map: null,
  markers: new Map(),
  groupById: new Map(),
  currentIndex: 0,
  rangeStart: 0,
  rangeEnd: 0,
  timer: null,
  playing: false,
  speed: 1,
  activeByDay: [],
};

function isoDayNumber(dateString) {
  return Math.round(
    Date.parse(`${dateString}T00:00:00Z`) / DAY_MS,
  );
}

function dateAtIndex(index) {
  const start = isoDayNumber(state.payload.time.date_start);
  return new Date((start + index) * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function indexForDate(dateString) {
  return (
    isoDayNumber(dateString)
    - isoDayNumber(state.payload.time.date_start)
  );
}

function markerShape(group) {
  if (group.split === "TRAIN") {
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

function markerIcon(group, observed) {
  const splitClass = (
    group.split === "TRAIN" ? "train" : "verify"
  );
  const stateClass = observed ? "is-on" : "is-off";
  const html = (
    `<div class="availability-marker ${splitClass} ${stateClass}">`
    + '<svg width="30" height="30" viewBox="0 0 30 30">'
    + markerShape(group)
    + "</svg></div>"
  );
  return L.divIcon({
    html,
    className: "availability-leaflet-icon",
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function popupContent(group, date, observed) {
  const stateLabel = observed ? "ON" : "OFF";
  const stationList = group.stations
    .map((station) => `<code>${station}</code>`)
    .join(", ");
  const spread = (
    group.member_coordinate_max_spread_km == null
      ? "NA"
      : `${group.member_coordinate_max_spread_km} km`
  );
  return `
    <div class="availability-popup">
      <h3>${group.label_ko}</h3>
      <b>physical_site_group:</b>
      <code>${group.physical_site_group}</code><br>
      <b>split:</b> ${group.split}<br>
      <b>날짜:</b> ${date}<br>
      <b>관측 상태:</b>
      <strong class="${observed ? "popup-on" : "popup-off"}">
        ${stateLabel}
      </strong><br>
      <b>일별 판정:</b> member station 중 non-null WS가 1시간 이상 존재<br>
      <b>member stations:</b> ${stationList}<br>
      <b>coordinate_source:</b>
      ${group.coordinate_source}<br>
      <b>대표 좌표 규칙:</b> ${group.coordinate_rule}<br>
      <b>member 좌표 최대 간격:</b> ${spread}<br>
      <b>전체 관측일:</b> ${group.observed_days.toLocaleString()}일<br>
      <b>최초 관측:</b> ${group.first_observation}<br>
      <b>최종 관측:</b> ${group.last_observation}<br>
      <hr>
      <small>
        이 지도는 물리 지점 단위의 일별 ON/OFF입니다.
        개별 터빈 좌표나 실제 WRF grid 좌표가 아닙니다.
      </small>
    </div>
  `;
}

function createMap() {
  state.map = L.map("availability-map", {
    zoomControl: true,
    preferCanvas: false,
  }).setView([36.1, 127.6], 7);

  L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    {
      maxZoom: 19,
      attribution:
        '&copy; OpenStreetMap contributors &copy; CARTO',
    },
  ).addTo(state.map);

  const trainLayer = L.layerGroup().addTo(state.map);
  const verifyLayer = L.layerGroup().addTo(state.map);
  const bounds = [];
  const unmapped = [];

  for (const group of state.payload.groups) {
    state.groupById.set(group.id, group);
    if (
      group.latitude_deg == null
      || group.longitude_deg == null
    ) {
      unmapped.push(group.label_ko);
      continue;
    }

    const marker = L.marker(
      [group.latitude_deg, group.longitude_deg],
      {
        icon: markerIcon(group, false),
        title: group.label_ko,
        riseOnHover: true,
      },
    );
    marker.bindTooltip(
      `${group.label_ko} · ${group.split}`,
      {direction: "top", offset: [0, -10]},
    );
    marker.bindPopup(
      popupContent(
        group,
        state.payload.time.date_start,
        false,
      ),
      {maxWidth: 420},
    );
    marker.addTo(
      group.split === "TRAIN" ? trainLayer : verifyLayer,
    );
    state.markers.set(group.id, marker);
    bounds.push([group.latitude_deg, group.longitude_deg]);
  }

  L.control.layers(
    null,
    {
      "TRAIN · 빨간 원": trainLayer,
      "VERIFY · 파란 삼각형": verifyLayer,
    },
    {collapsed: false},
  ).addTo(state.map);

  if (bounds.length > 0) {
    state.map.fitBounds(bounds, {padding: [28, 28]});
  }

  elements.unmappedGroups.textContent = (
    unmapped.length
      ? `좌표 미확인: ${unmapped.join(", ")}`
      : "좌표 미확인 지점 없음"
  );
}

function buildDailyIndex() {
  const dayCount = state.payload.counts.calendar_days;
  state.activeByDay = Array.from(
    {length: dayCount},
    () => [],
  );
  for (const group of state.payload.groups) {
    for (const [startIndex, endIndex] of group.on_day_runs) {
      for (
        let index = startIndex;
        index <= endIndex;
        index += 1
      ) {
        state.activeByDay[index].push(group.id);
      }
    }
  }
}

function observedForDay(index) {
  return new Set(state.activeByDay[index] || []);
}

function updateDay(index) {
  state.currentIndex = Math.max(
    state.rangeStart,
    Math.min(index, state.rangeEnd),
  );
  elements.slider.value = String(state.currentIndex);

  const date = dateAtIndex(state.currentIndex);
  const observedGroups = observedForDay(state.currentIndex);
  let trainActive = 0;
  let verifyActive = 0;
  let mappedActive = 0;

  for (const group of state.payload.groups) {
    const observed = observedGroups.has(group.id);
    if (observed) {
      if (group.split === "TRAIN") {
        trainActive += 1;
      } else if (group.split === "VERIFY") {
        verifyActive += 1;
      }
    }

    const marker = state.markers.get(group.id);
    if (!marker) {
      continue;
    }
    if (observed) {
      mappedActive += 1;
    }
    marker.setIcon(markerIcon(group, observed));
    marker.setPopupContent(
      popupContent(group, date, observed),
    );
  }

  const totalActive = trainActive + verifyActive;
  const totalGroups = state.payload.counts.physical_site_groups;
  const mappedGroups = (
    state.payload.counts.mapped_physical_site_groups
  );
  elements.currentDate.textContent = date;
  elements.sliderDate.textContent = date;
  elements.activeTotal.textContent = (
    `ON ${totalActive}/${totalGroups}`
    + ` · 지도 ${mappedActive}/${mappedGroups}`
  );
  elements.activeTrain.textContent = (
    `TRAIN ${trainActive}`
  );
  elements.activeVerify.textContent = (
    `VERIFY ${verifyActive}`
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
    50,
    Math.round(BASE_FRAME_MS / state.speed),
  );
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
    if (state.currentIndex >= state.rangeEnd) {
      stopPlayback();
      return;
    }
    updateDay(state.currentIndex + 1);
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
  const lastIndex = (
    state.payload.counts.calendar_days - 1
  );
  if (preset === "full") {
    state.rangeStart = 0;
  } else {
    state.rangeStart = Math.max(
      0,
      indexForDate(state.payload.time.default_start),
    );
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
}

async function initialize() {
  try {
    const response = await fetch(DATA_URL, {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(
        `availability data request failed: ${response.status}`,
      );
    }
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
    const decompressedStream = new Blob([compressed])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    state.payload = await new Response(decompressedStream).json();

    if (
      state.payload.schema_version !== 2
      || !Array.isArray(state.payload.groups)
      || state.payload.encoding
        !== "per_group_inclusive_day_index_runs"
      || !state.payload.groups.every(
        (group) => Array.isArray(group.on_day_runs),
      )
    ) {
      throw new Error("unsupported availability data schema");
    }

    buildDailyIndex();

    elements.dataRange.textContent = (
      `자료 범위: ${state.payload.time.source_start}`
      + ` ~ ${state.payload.time.source_end}`
    );

    createMap();
    bindControls();
    setRange("default");
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
