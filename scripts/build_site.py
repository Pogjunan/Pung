#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import gzip
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import pandas as pd


COMMON_OUTPUT_NAME = "ws_availability_common_hourly.json.gz.b64"
FULL_HISTORY_INPUT_NAME = "ws_availability_daily.json.gz.b64"
PAIRED_INPUT_NAME = "ws_paired_selected_hourly.json.gz.b64"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build the combined GitHub Pages map site."
    )
    parser.add_argument(
        "--nominal-input",
        type=Path,
        default=Path("40m_WRF_WS_공간목록.csv"),
    )
    parser.add_argument(
        "--availability-data",
        type=Path,
        default=Path(f"data/{COMMON_OUTPUT_NAME}"),
    )
    parser.add_argument(
        "--full-history-data",
        type=Path,
        default=Path(f"data/{FULL_HISTORY_INPUT_NAME}"),
    )
    parser.add_argument(
        "--paired-data",
        type=Path,
        default=Path(f"data/{PAIRED_INPUT_NAME}"),
    )
    parser.add_argument("--web-root", type=Path, default=Path("web"))
    parser.add_argument("--output", type=Path, default=Path("_site"))
    return parser.parse_args()


def require_file(path: Path) -> None:
    if not path.is_file():
        raise FileNotFoundError(f"Required file not found: {path}")


def decode_payload(path: Path) -> dict[str, Any]:
    encoded = path.read_text(encoding="ascii").strip()
    return json.loads(
        gzip.decompress(base64.b64decode(encoded)).decode("utf-8")
    )


def encode_payload(payload: dict[str, Any]) -> str:
    serialized = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return base64.b64encode(
        gzip.compress(serialized, compresslevel=9)
    ).decode("ascii")


def write_js_payload(
    path: Path,
    variable_name: str,
    payload: dict[str, Any],
) -> None:
    serialized = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    path.write_text(
        f"window.{variable_name}={serialized};\n",
        encoding="utf-8",
    )


def normalize_split(value: object) -> str:
    text = str(value).strip().lower()
    if text in {"tr", "train", "training"}:
        return "TRAIN"
    if text in {
        "ve",
        "vr",
        "verify",
        "verification",
        "validation",
        "test",
    }:
        return "VERIFY"
    return text.upper()


def load_nominal(path: Path) -> pd.DataFrame:
    nominal = pd.read_csv(path, encoding="utf-8-sig")
    required = {
        "split",
        "station",
        "latitude_deg",
        "longitude_deg",
        "coordinate_source",
        "status",
        "physical_site_group",
    }
    missing = required.difference(nominal.columns)
    if missing:
        raise ValueError(
            f"Nominal metadata columns missing: {sorted(missing)}"
        )

    nominal = nominal.copy()
    nominal["split_normalized"] = nominal["split"].map(normalize_split)
    nominal["station"] = nominal["station"].astype(str).str.strip()
    if nominal.duplicated(
        ["split_normalized", "station"]
    ).any():
        duplicated = nominal.loc[
            nominal.duplicated(
                ["split_normalized", "station"],
                keep=False,
            ),
            ["split_normalized", "station"],
        ].to_dict("records")
        raise ValueError(
            f"Duplicate nominal station metadata: {duplicated}"
        )
    return nominal


def enrich_station_records(
    payload: dict[str, Any],
    nominal: pd.DataFrame,
) -> dict[str, Any]:
    metadata = {
        (row.split_normalized, row.station): row
        for row in nominal.itertuples(index=False)
    }

    physical_groups: set[str] = set()
    mapped = 0
    missing_records: list[str] = []

    for record in payload["groups"]:
        key = (record["split"], record["station"])
        row = metadata.get(key)
        if row is None:
            missing_records.append(f"{key[0]}__{key[1]}")
            continue

        latitude = pd.to_numeric(row.latitude_deg, errors="coerce")
        longitude = pd.to_numeric(row.longitude_deg, errors="coerce")
        latitude_value = (
            None if pd.isna(latitude) else float(latitude)
        )
        longitude_value = (
            None if pd.isna(longitude) else float(longitude)
        )
        if (
            latitude_value is not None
            and longitude_value is not None
        ):
            mapped += 1

        physical_site_group = str(row.physical_site_group)
        physical_groups.add(physical_site_group)
        record.update(
            {
                "physical_site_group": physical_site_group,
                "latitude_deg": latitude_value,
                "longitude_deg": longitude_value,
                "coordinate_source": str(row.coordinate_source),
                "nominal_status": str(row.status),
                "label_ko": record.get(
                    "label_ko",
                    record["station"],
                ),
            }
        )

    if missing_records:
        raise ValueError(
            "Availability stations missing from nominal metadata: "
            + ", ".join(missing_records)
        )

    payload["counts"]["mapped_station_ids"] = int(mapped)
    payload["counts"]["physical_site_groups"] = int(
        len(physical_groups)
    )
    return payload


def enrich_paired_records(
    payload: dict[str, Any],
    nominal: pd.DataFrame,
) -> dict[str, Any]:
    mapped = 0
    for record in payload["groups"]:
        split = "TRAIN" if record["role"] == "TRAIN" else "VERIFY"
        members = set(record["member_stations"])
        rows = nominal.loc[
            nominal["split_normalized"].eq(split)
            & nominal["station"].isin(members)
        ].copy()
        if len(rows) != len(members):
            found = set(rows["station"])
            missing = sorted(members.difference(found))
            raise ValueError(
                f"Paired site {record['physical_site_group']} "
                f"missing nominal members: {missing}"
            )

        coordinates = rows[
            ["latitude_deg", "longitude_deg"]
        ].apply(pd.to_numeric, errors="coerce").dropna()
        if coordinates.empty:
            latitude = None
            longitude = None
        else:
            latitude = float(coordinates["latitude_deg"].mean())
            longitude = float(coordinates["longitude_deg"].mean())
            mapped += 1

        sources = sorted(
            rows["coordinate_source"]
            .dropna()
            .astype(str)
            .unique()
            .tolist()
        )
        record.update(
            {
                "latitude_deg": latitude,
                "longitude_deg": longitude,
                "coordinate_source": (
                    "+".join(sources) if sources else "UNKNOWN"
                ),
                "nominal_statuses": sorted(
                    rows["status"].astype(str).unique().tolist()
                ),
            }
        )

    payload["counts"]["mapped_sites"] = int(mapped)
    return payload


def validate_common(payload: dict[str, Any]) -> None:
    if payload.get("schema_version") != 4:
        raise ValueError("Unsupported common-hour schema version")
    if payload.get("record_grain") != "station_column":
        raise ValueError("Common data is not station-column level")
    if payload.get("encoding") != (
        "filtered_common_hour_sequence_with_per_station_inclusive_frame_runs"
    ):
        raise ValueError("Unsupported common-hour encoding")

    expected = {
        "station_ids": 43,
        "train_station_ids": 22,
        "verify_station_ids": 21,
        "selected_frames": 54000,
        "stations_ever_on_selected": 18,
        "stations_always_off_selected": 25,
    }
    counts = payload.get("counts", {})
    for key, value in expected.items():
        if counts.get(key) != value:
            raise ValueError(
                f"Unexpected common {key}: "
                f"{counts.get(key)} != {value}"
            )

    selection = payload.get("selection", {})
    if selection.get("retained_start") != (
        "2016-03-01 00:00:00"
    ):
        raise ValueError("Unexpected common-hour start")
    if selection.get("retained_end") != (
        "2023-10-31 14:00:00"
    ):
        raise ValueError("Unexpected common-hour end")


def validate_full_history(payload: dict[str, Any]) -> None:
    if payload.get("schema_version") != 3:
        raise ValueError("Unsupported full-history schema version")
    if payload.get("record_grain") != "station_column":
        raise ValueError("Full history is not station-column level")
    if payload.get("encoding") != (
        "per_station_inclusive_day_index_runs"
    ):
        raise ValueError("Unsupported full-history encoding")

    counts = payload.get("counts", {})
    expected = {
        "station_ids": 43,
        "train_station_ids": 22,
        "verify_station_ids": 21,
        "calendar_days": 10077,
    }
    for key, value in expected.items():
        if counts.get(key) != value:
            raise ValueError(
                f"Unexpected full-history {key}: "
                f"{counts.get(key)} != {value}"
            )

    never_on = [
        record["station"]
        for record in payload["groups"]
        if not record.get("on_day_runs")
    ]
    if never_on:
        raise ValueError(
            f"Stations never ON in full history: {never_on}"
        )


def validate_paired(payload: dict[str, Any]) -> None:
    if payload.get("schema_version") != 1:
        raise ValueError("Unsupported paired schema version")
    if payload.get("record_grain") != "paired_physical_site":
        raise ValueError("Paired data is not physical-site level")
    if payload.get("encoding") != (
        "contiguous_hour_sequence_with_per_site_inclusive_frame_runs"
    ):
        raise ValueError("Unsupported paired encoding")

    counts = payload.get("counts", {})
    expected = {
        "train_sites": 8,
        "test_sites": 7,
        "total_sites": 15,
        "sites_ever_on": 15,
        "sites_never_on": 0,
        "frame_count": 78888,
    }
    for key, value in expected.items():
        if counts.get(key) != value:
            raise ValueError(
                f"Unexpected paired {key}: "
                f"{counts.get(key)} != {value}"
            )

    if payload["time"]["start"] != "2015-01-01 09:00:00":
        raise ValueError("Unexpected paired start")
    if payload["time"]["end"] != "2024-01-01 08:00:00":
        raise ValueError("Unexpected paired end")


def build_nominal_page(
    nominal_input: Path,
    output: Path,
) -> None:
    repository_root = Path(__file__).resolve().parents[1]
    build_map_script = repository_root / "scripts" / "build_map.py"
    require_file(build_map_script)

    nominal_temp = output / "_nominal_build"
    subprocess.run(
        [
            sys.executable,
            str(build_map_script),
            "--input",
            str(nominal_input),
            "--output",
            str(nominal_temp),
        ],
        check=True,
    )
    require_file(nominal_temp / "index.html")
    shutil.move(
        str(nominal_temp / "index.html"),
        str(output / "nominal.html"),
    )

    optional_outputs = {
        "station_coordinate_audit.csv": (
            "nominal_station_coordinate_audit.csv"
        ),
        "build_summary.json": "nominal_build_summary.json",
    }
    for source_name, target_name in optional_outputs.items():
        source = nominal_temp / source_name
        if source.is_file():
            shutil.move(str(source), str(output / target_name))
    shutil.rmtree(nominal_temp)


def main() -> None:
    args = parse_args()
    for path in (
        args.nominal_input,
        args.availability_data,
        args.full_history_data,
        args.paired_data,
        args.web_root / "index.html",
        args.web_root / "availability.html",
        args.web_root / "availability-all.html",
        args.web_root / "paired.html",
    ):
        require_file(path)

    nominal = load_nominal(args.nominal_input)

    common = decode_payload(args.availability_data)
    validate_common(common)
    common = enrich_station_records(common, nominal)

    full_history = decode_payload(args.full_history_data)
    validate_full_history(full_history)
    full_history = enrich_station_records(full_history, nominal)

    paired = decode_payload(args.paired_data)
    validate_paired(paired)
    paired = enrich_paired_records(paired, nominal)

    if common["counts"]["mapped_station_ids"] != 42:
        raise ValueError("Expected 42 mapped common-hour stations")
    if full_history["counts"]["mapped_station_ids"] != 42:
        raise ValueError("Expected 42 mapped full-history stations")
    if paired["counts"]["mapped_sites"] != 14:
        raise ValueError(
            "Expected 14 mapped paired sites; Boseong is unmapped"
        )

    output = args.output
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)

    build_nominal_page(args.nominal_input, output)
    shutil.copytree(args.web_root, output, dirs_exist_ok=True)

    data_output = output / "data"
    data_output.mkdir(exist_ok=True)

    (data_output / COMMON_OUTPUT_NAME).write_text(
        encode_payload(common),
        encoding="ascii",
    )

    write_js_payload(
        data_output / "full-history-data.js",
        "FULL_HISTORY_DATA",
        full_history,
    )
    write_js_payload(
        data_output / "paired-data.js",
        "PAIRED_DATA",
        paired,
    )

    shutil.copy2(
        args.full_history_data,
        data_output / FULL_HISTORY_INPUT_NAME,
    )
    shutil.copy2(
        args.paired_data,
        data_output / PAIRED_INPUT_NAME,
    )

    (output / ".nojekyll").write_text("", encoding="utf-8")

    summary = {
        "status": "ok",
        "pages": {
            "dashboard": "index.html",
            "nominal": "nominal.html",
            "common_hour": "availability.html",
            "full_history": "availability-all.html",
            "paired": "paired.html",
        },
        "common_hour": common["counts"],
        "common_selection": common["selection"],
        "full_history": full_history["counts"],
        "paired": paired["counts"],
        "paired_selection": paired["selection"],
        "deployed_data": {
            "common": f"data/{COMMON_OUTPUT_NAME}",
            "full_history_js": "data/full-history-data.js",
            "paired_js": "data/paired-data.js",
        },
    }
    (output / "site_build_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(f"[OK] combined site generated: {output}")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
