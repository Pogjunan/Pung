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

REQUIRED = {
    "split", "station", "latitude_deg", "longitude_deg",
    "coordinate_source", "status",
}
TRAIN = "#d73027"
TEST = "#4575b4"
GRAY = "#666666"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--input", type=Path, default=Path("40m_WRF_WS_공간목록.csv"))
    p.add_argument("--output", type=Path, default=Path("_site"))
    return p.parse_args()


def split_norm(value: Any) -> str:
    text = str(value).strip().lower()
    if text in {"tr", "train", "training"}:
        return "tr"
    if text in {"ve", "vr", "test", "verification", "validation", "val"}:
        return "ve"
    return "unknown"


def source_norm(value: Any) -> str:
    if pd.isna(value):
        return "UNKNOWN"
    text = str(value).strip().upper()
    return {
        "FLS": "FLS_HEADER", "HEADER": "FLS_HEADER",
        "LEGACY": "LEGACY_CODE", "CODE": "LEGACY_CODE",
        "": "UNKNOWN", "NAN": "UNKNOWN", "NONE": "UNKNOWN",
    }.get(text, text)


def valid_coordinate(lat: Any, lon: Any) -> bool:
    try:
        lat = float(lat)
        lon = float(lon)
    except (TypeError, ValueError):
        return False
    return math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180


def normalize(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df.columns = [str(c).strip() for c in df.columns]
    missing = REQUIRED - set(df.columns)
    if missing:
        raise ValueError(f"Missing required columns: {sorted(missing)}")
    df["station"] = df["station"].astype(str).str.strip()
    if df["station"].duplicated().any():
        raise ValueError("Duplicate station IDs found")
    df["split"] = df["split"].map(split_norm)
    df["coordinate_source"] = df["coordinate_source"].map(source_norm)
    df["status"] = df["status"].fillna("UNKNOWN").astype(str)
    df["latitude_deg"] = pd.to_numeric(df["latitude_deg"], errors="coerce")
    df["longitude_deg"] = pd.to_numeric(df["longitude_deg"], errors="coerce")
    df["coordinate_valid"] = [
        valid_coordinate(lat, lon)
        for lat, lon in zip(df["latitude_deg"], df["longitude_deg"])
    ]
    df["is_nwp_only"] = df["status"].str.upper().str.contains("NWP_ONLY_NO_GT", regex=False)
    for col, default in [
        ("candidate_pair_count_wrf_plus9h", pd.NA),
        ("korean_name", pd.NA),
        ("note", ""),
    ]:
        if col not in df.columns:
            df[col] = default
    df["korean_name"] = df["korean_name"].fillna(df["station"])
    return df


def svg(shape: str, color: str, filled: bool) -> str:
    fill = color if filled else "white"
    opacity = "0.94" if filled else "0.05"
    if shape == "circle":
        body = f'<circle cx="13" cy="13" r="8" fill="{fill}" fill-opacity="{opacity}" stroke="{color}" stroke-width="3"/>'
    elif shape == "triangle":
        body = f'<polygon points="13,3 23,22 3,22" fill="{fill}" fill-opacity="{opacity}" stroke="{color}" stroke-width="3"/>'
    else:
        body = f'<polygon points="13,2 24,13 13,24 2,13" fill="{fill}" fill-opacity="{opacity}" stroke="{color}" stroke-width="3"/>'
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">{body}</svg>'


def style(row: pd.Series) -> tuple[str, str, bool]:
    if bool(row["is_nwp_only"]):
        return "diamond", GRAY, True
    shape = "circle" if row["split"] == "tr" else "triangle"
    color = TRAIN if row["split"] == "tr" else TEST
    filled = row["coordinate_source"] == "FLS_HEADER"
    return shape, color, filled


def popup(row: pd.Series) -> str:
    pair = row["candidate_pair_count_wrf_plus9h"]
    pair_text = "NA" if pd.isna(pair) else html.escape(str(pair))
    note = html.escape(str(row.get("note", "") or ""))
    return f"""
    <div style='width:340px;font-family:Arial,sans-serif'>
      <h3 style='margin:0 0 8px'>{html.escape(str(row['korean_name']))}</h3>
      <b>station:</b> <code>{html.escape(str(row['station']))}</code><br>
      <b>split:</b> {html.escape(str(row['split']))}<br>
      <b>nominal coordinate:</b> {row['latitude_deg']:.6f}, {row['longitude_deg']:.6f}<br>
      <b>coordinate_source:</b> {html.escape(str(row['coordinate_source']))}<br>
      <b>status:</b> {html.escape(str(row['status']))}<br>
      <b>candidate_pair_count_wrf_plus9h:</b> {pair_text}<br>
      <b>note:</b> {note or '—'}
      <hr>
      <b style='color:#a40000'>Actual WRF grid coordinate: UNKNOWN</b><br>
      <small>This marker is a nominal station coordinate, not the exact WRF extraction grid.</small>
    </div>
    """


def add_panel(m: folium.Map, omitted: list[str]) -> None:
    omitted_text = ", ".join(omitted) if omitted else "none"
    panel = f"""
    <div style='position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999;
                background:white;border:1px solid #777;border-radius:8px;padding:9px 14px;
                box-shadow:0 1px 5px rgba(0,0,0,.25);font-family:Arial,sans-serif;text-align:center'>
      <b>40m station nominal locations</b><br>
      <small>Train=red circle · Verification=blue triangle · FLS_HEADER=filled · LEGACY_CODE=hollow</small>
    </div>
    <div style='position:fixed;bottom:28px;left:12px;z-index:9999;background:white;border:1px solid #777;
                border-radius:7px;padding:10px;font:12px Arial,sans-serif'>
      <b>Interpretation</b><br>
      Plotted: nominal station coordinates<br>
      WRF grid: UNKNOWN / not plotted<br>
      Omitted: {html.escape(omitted_text)}
    </div>
    """
    m.get_root().html.add_child(folium.Element(panel))


def placeholder(output: Path, reason: str) -> None:
    output.mkdir(parents=True, exist_ok=True)
    page = f"""<!doctype html><html lang='ko'><meta charset='utf-8'>
    <title>Wind station map setup</title>
    <style>body{{font-family:system-ui;max-width:850px;margin:60px auto;padding:0 20px;line-height:1.6}}
    code,pre{{background:#f5f5f5;padding:3px 6px;border-radius:5px}}pre{{padding:16px;overflow:auto}}</style>
    <h1>40 m Wind Station Map</h1>
    <p>지도를 생성하려면 저장소 루트에 <code>40m_WRF_WS_공간목록.csv</code>를 추가하세요.</p>
    <p><b>현재 상태:</b> {html.escape(reason)}</p>
    <pre>git add 40m_WRF_WS_공간목록.csv
git commit -m "Add station coordinate registry"
git push</pre>
    <p>push 후 GitHub Actions가 자동으로 동적 지도를 다시 배포합니다.</p>
    </html>"""
    (output / "index.html").write_text(page, encoding="utf-8")
    (output / "build_summary.json").write_text(json.dumps({"status": "placeholder", "reason": reason}, ensure_ascii=False, indent=2), encoding="utf-8")


def build(df: pd.DataFrame, output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    plotted = df[df["coordinate_valid"]].copy()
    omitted = df.loc[~df["coordinate_valid"], "station"].astype(str).tolist()
    m = folium.Map(location=[36.1, 127.6], zoom_start=7, tiles="CartoDB positron", control_scale=True)
    layers = {
        "tr": folium.FeatureGroup(name=f"Train ({(plotted['split']=='tr').sum()})", show=True),
        "ve": folium.FeatureGroup(name=f"Verification ({(plotted['split']=='ve').sum()})", show=True),
        "nwp": folium.FeatureGroup(name=f"NWP only ({plotted['is_nwp_only'].sum()})", show=True),
    }
    for _, row in plotted.iterrows():
        shape, color, filled = style(row)
        icon = folium.DivIcon(html=svg(shape, color, filled), icon_size=(26, 26), icon_anchor=(13, 13))
        target = layers["nwp"] if row["is_nwp_only"] else layers.get(row["split"], m)
        folium.Marker(
            [float(row["latitude_deg"]), float(row["longitude_deg"])],
            tooltip=f"{row['korean_name']} | {row['station']} | {row['coordinate_source']}",
            popup=folium.Popup(popup(row), max_width=390),
            icon=icon,
        ).add_to(target)
    for layer in layers.values():
        layer.add_to(m)
    if not plotted.empty:
        m.fit_bounds(plotted[["latitude_deg", "longitude_deg"]].astype(float).values.tolist(), padding=(25, 25))
    plugins.Fullscreen(position="topright").add_to(m)
    plugins.MeasureControl(position="topright", primary_length_unit="kilometers").add_to(m)
    plugins.MousePosition(position="bottomright", prefix="lat/lon:", num_digits=6).add_to(m)
    folium.LayerControl(collapsed=False).add_to(m)
    add_panel(m, omitted)
    m.save(str(output / "index.html"))
    df.to_csv(output / "station_coordinate_audit.csv", index=False, encoding="utf-8-sig")
    summary = {
        "status": "ok",
        "rows": int(len(df)),
        "split_counts": df["split"].value_counts(dropna=False).to_dict(),
        "coordinate_source_counts": df["coordinate_source"].value_counts(dropna=False).to_dict(),
        "coordinate_valid": int(df["coordinate_valid"].sum()),
        "omitted": omitted,
        "plotted_semantics": "station nominal coordinate",
        "wrf_grid_semantics": "UNKNOWN_NOT_PLOTTED",
    }
    (output / "build_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    args = parse_args()
    if not args.input.is_file():
        placeholder(args.output, f"input file not found: {args.input}")
        print(f"[WARN] {args.input} not found; placeholder site generated")
        return
    df = normalize(pd.read_csv(args.input, encoding="utf-8-sig"))
    build(df, args.output)
    print("[OK] site generated:", args.output)
    print("[INFO] split counts:", df["split"].value_counts().to_dict())
    print("[INFO] source counts:", df["coordinate_source"].value_counts().to_dict())


if __name__ == "__main__":
    main()
