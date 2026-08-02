#!/usr/bin/env python3
from __future__ import annotations

import argparse
import html
import json
import math
from pathlib import Path
from typing import Any

import folium
import pandas as pd
from folium import plugins

REQUIRED_COLUMNS = {
    "split",
    "station",
    "latitude_deg",
    "longitude_deg",
    "coordinate_source",
    "status",
}

TRAIN_COLOR = "#d73027"
TEST_COLOR = "#4575b4"
NWP_ONLY_COLOR = "#666666"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build an interactive map of nominal wind-station coordinates."
    )
    parser.add_argument(
        "--input",
        type=Path,
        default=Path("40m_WRF_WS_공간목록.csv"),
    )
    parser.add_argument("--output", type=Path, default=Path("_site"))
    return parser.parse_args()


def normalize_split(value: Any) -> str:
    text = str(value).strip().lower()
    if text in {"tr", "train", "training"}:
        return "tr"
    if text in {"ve", "vr", "test", "verification", "validation", "val"}:
        return "ve"
    return "unknown"


def normalize_source(value: Any) -> str:
    if pd.isna(value):
        return "UNKNOWN"
    text = str(value).strip().upper()
    aliases = {
        "FLS": "FLS_HEADER",
        "HEADER": "FLS_HEADER",
        "RAW_HEADER": "FLS_HEADER",
        "LEGACY": "LEGACY_CODE",
        "CODE": "LEGACY_CODE",
        "": "UNKNOWN",
        "NAN": "UNKNOWN",
        "NONE": "UNKNOWN",
    }
    return aliases.get(text, text)


def is_valid_coordinate(lat: Any, lon: Any) -> bool:
    try:
        latitude = float(lat)
        longitude = float(lon)
    except (TypeError, ValueError):
        return False
    return (
        math.isfinite(latitude)
        and math.isfinite(longitude)
        and -90.0 <= latitude <= 90.0
        and -180.0 <= longitude <= 180.0
    )


def normalize_table(frame: pd.DataFrame) -> pd.DataFrame:
    frame = frame.copy()
    frame.columns = [str(column).strip() for column in frame.columns]

    missing = REQUIRED_COLUMNS.difference(frame.columns)
    if missing:
        raise ValueError(f"Missing required columns: {sorted(missing)}")

    frame["station"] = frame["station"].astype(str).str.strip()
    if frame["station"].eq("").any():
        raise ValueError("Blank station ID found")
    if frame["station"].duplicated().any():
        duplicated = frame.loc[
            frame["station"].duplicated(keep=False), "station"
        ].tolist()
        raise ValueError(f"Duplicate station IDs found: {duplicated}")

    frame["split"] = frame["split"].map(normalize_split)
    frame["coordinate_source"] = frame["coordinate_source"].map(
        normalize_source
    )
    frame["status"] = frame["status"].fillna("UNKNOWN").astype(str).str.strip()
    frame["latitude_deg"] = pd.to_numeric(
        frame["latitude_deg"], errors="coerce"
    )
    frame["longitude_deg"] = pd.to_numeric(
        frame["longitude_deg"], errors="coerce"
    )
    frame["coordinate_valid"] = [
        is_valid_coordinate(lat, lon)
        for lat, lon in zip(frame["latitude_deg"], frame["longitude_deg"])
    ]
    frame["is_nwp_only"] = frame["status"].str.upper().str.contains(
        "NWP_ONLY_NO_GT", regex=False
    )

    defaults: dict[str, Any] = {
        "candidate_pair_count_wrf_plus9h": pd.NA,
        "korean_name": pd.NA,
        "note": "",
        "physical_site_group": pd.NA,
    }
    for column, default in defaults.items():
        if column not in frame.columns:
            frame[column] = default

    frame["korean_name"] = frame["korean_name"].fillna(frame["station"])
    frame["physical_site_group"] = frame["physical_site_group"].fillna(
        frame["station"]
    )
    return frame


def value_counts_dict(series: pd.Series) -> dict[str, int]:
    """Convert pandas/NumPy counts to JSON-safe Python integers."""
    return {
        str(key): int(value)
        for key, value in series.value_counts(dropna=False).items()
    }


def marker_svg(shape: str, color: str, filled: bool) -> str:
    fill = color if filled else "white"
    opacity = "0.94" if filled else "0.05"
    common = (
        f'fill="{fill}" fill-opacity="{opacity}" '
        f'stroke="{color}" stroke-width="3"'
    )

    if shape == "circle":
        body = f'<circle cx="13" cy="13" r="8" {common}/>'
    elif shape == "triangle":
        body = f'<polygon points="13,3 23,22 3,22" {common}/>'
    else:
        body = f'<polygon points="13,2 24,13 13,24 2,13" {common}/>'

    return (
        '<svg xmlns="http://www.w3.org/2000/svg" '
        'width="26" height="26" viewBox="0 0 26 26" '
        'style="filter:drop-shadow(0 1px 1px rgba(0,0,0,.35))">'
        f"{body}</svg>"
    )


def marker_style(row: pd.Series) -> tuple[str, str, bool]:
    if bool(row["is_nwp_only"]):
        return "diamond", NWP_ONLY_COLOR, True
    if row["split"] == "tr":
        return (
            "circle",
            TRAIN_COLOR,
            row["coordinate_source"] == "FLS_HEADER",
        )
    if row["split"] == "ve":
        return (
            "triangle",
            TEST_COLOR,
            row["coordinate_source"] == "FLS_HEADER",
        )
    return "diamond", "#111111", False


def popup_html(row: pd.Series) -> str:
    pair_count = row["candidate_pair_count_wrf_plus9h"]
    pair_text = "NA" if pd.isna(pair_count) else html.escape(str(pair_count))

    raw_note = row.get("note", "")
    note = "" if pd.isna(raw_note) else str(raw_note).strip()
    note_text = html.escape(note) if note else "—"

    return f"""
    <div style="width:350px;font-family:Arial,'Noto Sans KR',sans-serif">
      <h3 style="margin:0 0 8px">{html.escape(str(row['korean_name']))}</h3>
      <b>station:</b> <code>{html.escape(str(row['station']))}</code><br>
      <b>physical_site_group:</b>
      {html.escape(str(row['physical_site_group']))}<br>
      <b>split:</b> {html.escape(str(row['split']))}<br>
      <b>nominal coordinate:</b>
      {float(row['latitude_deg']):.6f}, {float(row['longitude_deg']):.6f}<br>
      <b>coordinate_source:</b>
      {html.escape(str(row['coordinate_source']))}<br>
      <b>status:</b> {html.escape(str(row['status']))}<br>
      <b>candidate_pair_count_wrf_plus9h:</b> {pair_text}<br>
      <b>note:</b> {note_text}
      <hr>
      <b style="color:#a40000">Actual WRF grid coordinate: UNKNOWN</b><br>
      <small>
        This marker is a nominal station coordinate, not the exact WRF
        extraction grid or a verified individual turbine coordinate.
      </small>
    </div>
    """


def add_information_panels(
    map_object: folium.Map,
    omitted: list[str],
    frame: pd.DataFrame,
) -> None:
    omitted_text = ", ".join(omitted) if omitted else "none"
    split_counts = value_counts_dict(frame["split"])
    source_counts = value_counts_dict(frame["coordinate_source"])

    panel = f"""
    <div style="position:fixed;top:12px;left:50%;transform:translateX(-50%);
                z-index:9999;background:rgba(255,255,255,.96);
                border:1px solid #777;border-radius:8px;padding:9px 14px;
                box-shadow:0 1px 5px rgba(0,0,0,.25);
                font-family:Arial,'Noto Sans KR',sans-serif;text-align:center">
      <b>40 m station nominal locations</b><br>
      <small>
        Train=red circle · Verification=blue triangle ·
        FLS_HEADER=filled · LEGACY_CODE=hollow
      </small>
    </div>

    <div style="position:fixed;bottom:28px;left:12px;z-index:9999;
                background:rgba(255,255,255,.96);border:1px solid #777;
                border-radius:7px;padding:10px;
                font:12px Arial,'Noto Sans KR',sans-serif">
      <b>Interpretation</b><br>
      Plotted: nominal station coordinates<br>
      WRF grid: UNKNOWN / not plotted<br>
      Omitted: {html.escape(omitted_text)}<br>
      Split counts: {html.escape(str(split_counts))}<br>
      Source counts: {html.escape(str(source_counts))}
    </div>
    """
    map_object.get_root().html.add_child(folium.Element(panel))


def write_placeholder(output_directory: Path, reason: str) -> None:
    output_directory.mkdir(parents=True, exist_ok=True)
    page = f"""<!doctype html>
    <html lang="ko">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Wind station map setup</title>
      <style>
        body{{font-family:system-ui;max-width:850px;margin:60px auto;
             padding:0 20px;line-height:1.6}}
        code,pre{{background:#f5f5f5;padding:3px 6px;border-radius:5px}}
        pre{{padding:16px;overflow:auto}}
      </style>
    </head>
    <body>
      <h1>40 m Wind Station Map</h1>
      <p>저장소 루트에 <code>40m_WRF_WS_공간목록.csv</code>를 추가하세요.</p>
      <p><b>현재 상태:</b> {html.escape(reason)}</p>
      <pre>git add 40m_WRF_WS_공간목록.csv
git commit -m "Add station coordinate registry"
git push</pre>
      <p>push 후 GitHub Actions가 동적 지도를 다시 배포합니다.</p>
    </body>
    </html>"""
    (output_directory / "index.html").write_text(page, encoding="utf-8")
    (output_directory / ".nojekyll").write_text("", encoding="utf-8")
    summary = {"status": "placeholder", "reason": reason}
    (output_directory / "build_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def build_site(frame: pd.DataFrame, output_directory: Path) -> None:
    output_directory.mkdir(parents=True, exist_ok=True)

    plotted = frame.loc[frame["coordinate_valid"]].copy()
    omitted = frame.loc[
        ~frame["coordinate_valid"], "station"
    ].astype(str).tolist()

    map_object = folium.Map(
        location=[36.1, 127.6],
        zoom_start=7,
        tiles="CartoDB positron",
        control_scale=True,
    )

    layers = {
        "tr": folium.FeatureGroup(
            name=f"Train ({int((plotted['split'] == 'tr').sum())})",
            show=True,
        ),
        "ve": folium.FeatureGroup(
            name=f"Verification ({int((plotted['split'] == 've').sum())})",
            show=True,
        ),
        "nwp": folium.FeatureGroup(
            name=f"NWP only ({int(plotted['is_nwp_only'].sum())})",
            show=True,
        ),
        "unknown": folium.FeatureGroup(
            name=f"Unknown split ({int((plotted['split'] == 'unknown').sum())})",
            show=False,
        ),
    }

    for _, row in plotted.iterrows():
        shape, color, filled = marker_style(row)
        icon = folium.DivIcon(
            html=marker_svg(shape, color, filled),
            icon_size=(26, 26),
            icon_anchor=(13, 13),
            class_name="station-svg-marker",
        )

        if bool(row["is_nwp_only"]):
            target = layers["nwp"]
        elif row["split"] in {"tr", "ve"}:
            target = layers[str(row["split"])]
        else:
            target = layers["unknown"]

        folium.Marker(
            location=[
                float(row["latitude_deg"]),
                float(row["longitude_deg"]),
            ],
            tooltip=(
                f"{row['korean_name']} | {row['station']} | "
                f"{row['coordinate_source']}"
            ),
            popup=folium.Popup(popup_html(row), max_width=410),
            icon=icon,
        ).add_to(target)

    for layer in layers.values():
        layer.add_to(map_object)

    if not plotted.empty:
        bounds = plotted[["latitude_deg", "longitude_deg"]].astype(float)
        map_object.fit_bounds(bounds.values.tolist(), padding=(25, 25))

    plugins.Fullscreen(position="topright").add_to(map_object)
    plugins.MeasureControl(
        position="topright",
        primary_length_unit="kilometers",
    ).add_to(map_object)
    plugins.MousePosition(
        position="bottomright",
        prefix="lat/lon:",
        num_digits=6,
    ).add_to(map_object)
    folium.LayerControl(collapsed=False).add_to(map_object)
    add_information_panels(map_object, omitted, frame)

    map_object.save(str(output_directory / "index.html"))
    (output_directory / ".nojekyll").write_text("", encoding="utf-8")
    frame.to_csv(
        output_directory / "station_coordinate_audit.csv",
        index=False,
        encoding="utf-8-sig",
    )

    summary = {
        "status": "ok",
        "rows": int(len(frame)),
        "split_counts": value_counts_dict(frame["split"]),
        "coordinate_source_counts": value_counts_dict(
            frame["coordinate_source"]
        ),
        "status_counts": value_counts_dict(frame["status"]),
        "coordinate_valid": int(frame["coordinate_valid"].sum()),
        "coordinate_invalid": int((~frame["coordinate_valid"]).sum()),
        "nwp_only": int(frame["is_nwp_only"].sum()),
        "omitted": omitted,
        "plotted_semantics": "station nominal coordinate",
        "wrf_grid_semantics": "UNKNOWN_NOT_PLOTTED",
    }
    (output_directory / "build_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def main() -> None:
    args = parse_args()

    if not args.input.is_file():
        write_placeholder(
            args.output,
            f"input file not found: {args.input}",
        )
        print(f"[WARN] {args.input} not found; placeholder site generated")
        return

    frame = normalize_table(pd.read_csv(args.input, encoding="utf-8-sig"))
    build_site(frame, args.output)

    print("[OK] site generated:", args.output)
    print("[INFO] split counts:", value_counts_dict(frame["split"]))
    print(
        "[INFO] source counts:",
        value_counts_dict(frame["coordinate_source"]),
    )
    print(
        "[INFO] omitted:",
        frame.loc[~frame["coordinate_valid"], "station"].tolist(),
    )


if __name__ == "__main__":
    main()
