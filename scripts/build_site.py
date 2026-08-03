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
        default=Path("data/ws_availability_daily.json.gz.b64"),
    )
    parser.add_argument(
        "--web-root",
        type=Path,
        default=Path("web"),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("_site"),
    )
    return parser.parse_args()


def require_file(path: Path) -> None:
    if not path.is_file():
        raise FileNotFoundError(f"Required file not found: {path}")


def main() -> None:
    args = parse_args()
    require_file(args.nominal_input)
    require_file(args.availability_data)
    require_file(args.web_root / "index.html")
    require_file(args.web_root / "availability.html")

    encoded_payload = args.availability_data.read_text(
        encoding="ascii"
    ).strip()
    payload = json.loads(
        gzip.decompress(base64.b64decode(encoded_payload)).decode("utf-8")
    )
    if payload.get("schema_version") != 3:
        raise ValueError("Unsupported availability schema version")
    if payload.get("encoding") != "per_station_inclusive_day_index_runs":
        raise ValueError("Unsupported availability encoding")
    if payload.get("record_grain") != "station_column":
        raise ValueError("Availability data is not station-column level")
    if not payload.get("groups"):
        raise ValueError("Availability data contains no station records")
    if not all(
        record.get("station") and record.get("on_day_runs")
        for record in payload["groups"]
    ):
        raise ValueError(
            "Availability contains a station with no ON-day runs"
        )

    counts = payload.get("counts", {})
    expected_counts = {
        "station_ids": 43,
        "train_station_ids": 22,
        "verify_station_ids": 21,
        "mapped_station_ids": 42,
        "physical_site_groups": 39,
    }
    for key, expected in expected_counts.items():
        actual = counts.get(key)
        if actual != expected:
            raise ValueError(
                f"Unexpected {key}: expected={expected}, actual={actual}"
            )

    output = args.output
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)

    repository_root = Path(__file__).resolve().parents[1]
    build_map_script = repository_root / "scripts" / "build_map.py"
    require_file(build_map_script)

    nominal_temp = output / "_nominal_build"
    subprocess.run(
        [
            sys.executable,
            str(build_map_script),
            "--input",
            str(args.nominal_input),
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

    optional_nominal_outputs = {
        "station_coordinate_audit.csv": (
            "nominal_station_coordinate_audit.csv"
        ),
        "build_summary.json": "nominal_build_summary.json",
    }
    for source_name, target_name in optional_nominal_outputs.items():
        source = nominal_temp / source_name
        if source.is_file():
            shutil.move(str(source), str(output / target_name))
    shutil.rmtree(nominal_temp)

    shutil.copytree(args.web_root, output, dirs_exist_ok=True)
    data_output = output / "data"
    data_output.mkdir(exist_ok=True)
    shutil.copy2(
        args.availability_data,
        data_output / "ws_availability_daily.json.gz.b64",
    )
    (output / ".nojekyll").write_text("", encoding="utf-8")

    summary = {
        "status": "ok",
        "pages": {
            "dashboard": "index.html",
            "nominal": "nominal.html",
            "availability": "availability.html",
        },
        "availability": counts,
        "availability_grain": payload["record_grain"],
        "source_range": {
            "start": payload["time"]["source_start"],
            "end": payload["time"]["source_end"],
        },
        "default_range": {
            "start": payload["time"]["default_start"],
            "end": payload["time"]["default_end"],
        },
        "playback_mode": payload["time"]["playback_mode"],
    }
    (output / "site_build_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(f"[OK] combined site generated: {output}")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
