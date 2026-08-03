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

import pandas as pd


AVAILABILITY_OUTPUT_NAME = "ws_availability_common_hourly.json.gz.b64"


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
        default=Path(f"data/{AVAILABILITY_OUTPUT_NAME}"),
    )
    parser.add_argument("--web-root", type=Path, default=Path("web"))
    parser.add_argument("--output", type=Path, default=Path("_site"))
    return parser.parse_args()


def require_file(path: Path) -> None:
    if not path.is_file():
        raise FileNotFoundError(f"Required file not found: {path}")


def decode_payload(path: Path) -> dict:
    encoded = path.read_text(encoding="ascii").strip()
    return json.loads(
        gzip.decompress(base64.b64decode(encoded)).decode("utf-8")
    )


def encode_payload(payload: dict) -> str:
    serialized = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return base64.b64encode(
        gzip.compress(serialized, compresslevel=9)
    ).decode("ascii")


def normalize_split(value: object) -> str:
    text = str(value).strip().lower()
    if text in {"tr", "train", "training"}:
        return "TRAIN"
    if text in {"ve", "vr", "verify", "verification", "validation"}:
        return "VERIFY"
    return text.upper()


def enrich_with_nominal_metadata(
    payload: dict,
    nominal_path: Path,
) -> dict:
    nominal = pd.read_csv(nominal_path, encoding="utf-8-sig")
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
        raise ValueError(f"Nominal metadata columns missing: {sorted(missing)}")

    nominal = nominal.copy()
    nominal["split_normalized"] = nominal["split"].map(normalize_split)
    nominal["station"] = nominal["station"].astype(str).str.strip()
    if nominal.duplicated(["split_normalized", "station"]).any():
        duplicated = nominal.loc[
            nominal.duplicated(["split_normalized", "station"], keep=False),
            ["split_normalized", "station"],
        ].to_dict("records")
        raise ValueError(f"Duplicate nominal station metadata: {duplicated}")

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
        latitude_value = None if pd.isna(latitude) else float(latitude)
        longitude_value = None if pd.isna(longitude) else float(longitude)
        if latitude_value is not None and longitude_value is not None:
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
                "label_ko": record.get("label_ko", record["station"]),
            }
        )

    if missing_records:
        raise ValueError(
            "Availability stations missing from nominal metadata: "
            + ", ".join(missing_records)
        )

    payload["counts"]["mapped_station_ids"] = int(mapped)
    payload["counts"]["physical_site_groups"] = int(len(physical_groups))
    return payload


def validate_payload(payload: dict) -> None:
    if payload.get("schema_version") != 4:
        raise ValueError("Unsupported availability schema version")
    if payload.get("record_grain") != "station_column":
        raise ValueError("Availability data is not station-column level")
    if payload.get("encoding") != (
        "filtered_common_hour_sequence_with_per_station_inclusive_frame_runs"
    ):
        raise ValueError("Unsupported availability encoding")

    groups = payload.get("groups")
    if not isinstance(groups, list) or not groups:
        raise ValueError("Availability data contains no station records")
    if not all(
        record.get("station")
        and record.get("split") in {"TRAIN", "VERIFY"}
        and isinstance(record.get("selected_on_runs"), list)
        for record in groups
    ):
        raise ValueError("Malformed availability station record")

    counts = payload.get("counts", {})
    expected = {
        "station_ids": 43,
        "train_station_ids": 22,
        "verify_station_ids": 21,
        "selected_frames": 54000,
        "stations_ever_on_selected": 18,
        "stations_always_off_selected": 25,
    }
    for key, value in expected.items():
        if counts.get(key) != value:
            raise ValueError(
                f"Unexpected {key}: {counts.get(key)} != {value}"
            )

    selection = payload.get("selection", {})
    if selection.get("retained_start") != "2016-03-01 00:00:00":
        raise ValueError("Unexpected common-hour start")
    if selection.get("retained_end") != "2023-10-31 14:00:00":
        raise ValueError("Unexpected common-hour end")

    time_runs = payload.get("time", {}).get("runs", [])
    if sum(int(run["count"]) for run in time_runs) != 54000:
        raise ValueError("Timestamp runs do not reconstruct 54,000 frames")


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
        "station_coordinate_audit.csv": "nominal_station_coordinate_audit.csv",
        "build_summary.json": "nominal_build_summary.json",
    }
    for source_name, target_name in optional_outputs.items():
        source = nominal_temp / source_name
        if source.is_file():
            shutil.move(str(source), str(output / target_name))
    shutil.rmtree(nominal_temp)


def main() -> None:
    args = parse_args()
    require_file(args.nominal_input)
    require_file(args.availability_data)
    require_file(args.web_root / "index.html")
    require_file(args.web_root / "availability.html")

    payload = decode_payload(args.availability_data)
    validate_payload(payload)
    payload = enrich_with_nominal_metadata(payload, args.nominal_input)

    if payload["counts"]["mapped_station_ids"] != 42:
        raise ValueError("Expected 42 coordinate-mapped WS stations")
    if payload["counts"]["physical_site_groups"] != 39:
        raise ValueError("Expected 39 physical site groups")

    output = args.output
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)

    build_nominal_page(args.nominal_input, output)
    shutil.copytree(args.web_root, output, dirs_exist_ok=True)

    data_output = output / "data"
    data_output.mkdir(exist_ok=True)
    (data_output / AVAILABILITY_OUTPUT_NAME).write_text(
        encode_payload(payload),
        encoding="ascii",
    )
    (output / ".nojekyll").write_text("", encoding="utf-8")

    summary = {
        "status": "ok",
        "pages": {
            "dashboard": "index.html",
            "nominal": "nominal.html",
            "availability": "availability.html",
        },
        "availability": payload["counts"],
        "availability_grain": payload["record_grain"],
        "availability_encoding": payload["encoding"],
        "selection": payload["selection"],
        "source": payload["source"],
        "deployed_data": f"data/{AVAILABILITY_OUTPUT_NAME}",
    }
    (output / "site_build_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(f"[OK] combined site generated: {output}")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
