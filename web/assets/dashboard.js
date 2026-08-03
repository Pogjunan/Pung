"use strict";

const BUILD_VERSION = "20260803-common-hourly-1";

const views = {
  nominal: {
    page: "nominal.html",
    label: "명목 관측소 위치",
  },
  availability: {
    page: `availability.html?v=${BUILD_VERSION}`,
    label: "시간에 따른 실제 풍속 관측여부",
  },
};

const frame = document.getElementById("map-frame");
const openCurrent = document.getElementById("open-current");
const buttons = [...document.querySelectorAll("[data-view]")];

function selectView(name, updateHash = true) {
  const selectedName = views[name] ? name : "nominal";
  const selected = views[selectedName];
  frame.src = selected.page;
  openCurrent.href = selected.page;
  openCurrent.setAttribute(
    "aria-label",
    `${selected.label} 새 탭에서 열기`,
  );
  for (const button of buttons) {
    button.classList.toggle(
      "active",
      button.dataset.view === selectedName,
    );
  }
  if (updateHash) {
    history.replaceState(null, "", `#${selectedName}`);
  }
}

for (const button of buttons) {
  button.addEventListener("click", () => {
    selectView(button.dataset.view);
  });
}

window.addEventListener("hashchange", () => {
  selectView(location.hash.slice(1), false);
});

selectView(location.hash.slice(1) || "nominal", false);
