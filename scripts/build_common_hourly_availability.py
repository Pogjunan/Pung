#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd


TIMESTAMP_COLUMN = "timestamp_LST_as_stored"
ENCODING = (
    "filtered_common_hour_sequence_with_per_station_inclusive_frame_runs"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build the exact hourly WS availability payload from the wide "
            "TRAIN__/VERIFY__ ON/OFF table."
        )
    )
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--start", default="2015-01-01 00:00:00")
    return parser.parse_args()


def inclusive_runs(indices: np.ndarray) -> list[list[int]]:
    if len(indices) == 0:
        return []
    ordered = np.asarray(indices, dtype=int)
    result: list[list[int]] = []
    start = previous = int(ordered[0])
    for raw_value in ordered[1:]:
        value = int(raw_value)
        if value == previous + 1:
            previous = value
        else:
            result.append([start, previous])
            start = previous = value
    result.append([start, previous])
    return result


def timestamp_runs(timestamps: pd.Series) -> list[dict[str, object]]:
    values = timestamps.tolist()
    if not values:
        return []

    result: list[dict[str, object]] = []
    frame_start = 0
    run_start = values[0]
    previous = values[0]
    for frame_index, timestamp in enumerate(values[1:], start=1):
        if timestamp - previous != pd.Timedelta(hours=1):
            result.append(
                {
                    "start": run_start.strftime("%Y-%m-%d %H:%M:%S"),
                    "frame_start": frame_start,
                    "count": frame_index - frame_start,
                }
            )
            frame_start = frame_index
            run_start = timestamp
        previous = timestamp

    result.append(
        {
            "start": run_start.strftime("%Y-%m-%d %H:%M:%S"),
            "frame_start": frame_start,
            "count": len(values) - frame_start,
        }
    )
    return result


def main() -> None:
    args = parse_args()
    frame = pd.read_csv(args.input)
    if TIMESTAMP_COLUMN not in frame.columns:
        raise ValueError(f"Missing timestamp column: {TIMESTAMP_COLUMN}")

    train_columns = sorted(
        column for column in frame.columns if column.startswith("TRAIN__")
    )
    verify_columns = sorted(
        column for column in frame.columns if column.startswith("VERIFY__")
    )
    if len(train_columns) != 22 or len(verify_columns) != 21:
        raise ValueError(
            "Expected 22 TRAIN and 21 VERIFY station columns; "
            f"found {len(train_columns)} and {len(verify_columns)}"
        )
    station_columns = train_columns + verify_columns

    values = frame[station_columns]
    if values.isna().any().any():
        raise ValueError("The supplied ON/OFF table contains NaN values")
    unique_values = set(pd.unique(values.to_numpy().ravel()).tolist())
    if not unique_values.issubset({0, 1}):
        raise ValueError(f"Expected binary 0/1 values; found {unique_values}")

    frame[TIMESTAMP_COLUMN] = pd.to_datetime(
        frame[TIMESTAMP_COLUMN], errors="raise"
    )
    if not frame[TIMESTAMP_COLUMN].is_monotonic_increasing:
        raise ValueError("Timestamps are not monotonically increasing")
    if frame[TIMESTAMP_COLUMN].duplicated().any():
        raise ValueError("Duplicate timestamps found")

    train_any = frame[train_columns].any(axis=1)
    verify_any = frame[verify_columns].any(axis=1)
    requested_start = pd.Timestamp(args.start)
    retained_mask = (
        frame[TIMESTAMP_COLUMN].ge(requested_start)
        & train_any
        & verify_any
    )
    retained = frame.loc[
        retained_mask,
        [TIMESTAMP_COLUMN] + station_columns,
    ].reset_index(drop=True)
    if retained.empty:
        raise ValueError("No TRAIN/VERIFY common hours remain after filtering")

    retained_matrix = retained[station_columns].to_numpy(dtype=np.uint8)
    change_indices = [0]
    for frame_index in range(1, len(retained)):
        if np.any(retained_matrix[frame_index] != retained_matrix[frame_index - 1]):
            change_indices.append(frame_index)

    groups: list[dict[str, object]] = []
    for record_id, column in enumerate(station_columns):
        split, station = column.split("__", 1)
        full_indices = np.flatnonzero(
            frame[column].to_numpy(dtype=np.uint8) == 1
        )
        selected_indices = np.flatnonzero(
            retained[column].to_numpy(dtype=np.uint8) == 1
        )
        if len(full_indices) == 0:
            raise ValueError(f"Completely empty WS station column: {column}")

        groups.append(
            {
                "id": record_id,
                "split": split,
                "station": station,
                "selected_on_hours": int(len(selected_indices)),
                "selected_on_runs": inclusive_runs(selected_indices),
                "full_on_hours": int(len(full_indices)),
                "full_first_on": frame.loc[
                    int(full_indices[0]), TIMESTAMP_COLUMN
                ].strftime("%Y-%m-%d %H:%M:%S"),
                "full_last_on": frame.loc[
                    int(full_indices[-1]), TIMESTAMP_COLUMN
                ].strftime("%Y-%m-%d %H:%M:%S"),
                "selected_first_on": (
                    None
                    if len(selected_indices) == 0
                    else retained.loc[
                        int(selected_indices[0]), TIMESTAMP_COLUMN
                    ].strftime("%Y-%m-%d %H:%M:%S")
                ),
                "selected_last_on": (
                    None
                    if len(selected_indices) == 0
                    else retained.loc[
                        int(selected_indices[-1]), TIMESTAMP_COLUMN
                    ].strftime("%Y-%m-%d %H:%M:%S")
                ),
            }
        )

    ever_on = sum(record["selected_on_hours"] > 0 for record in groups)
    payload = {
        "schema_version": 4,
        "record_grain": "station_column",
        "encoding": ENCODING,
        "title_ko": "시간에 따른 실제 풍속 관측여부",
        "title_en": "Temporal availability of observed wind speed",
        "source": {
            "file_name": args.input.name,
            "sha256": hashlib.sha256(args.input.read_bytes()).hexdigest(),
            "source_rows": int(len(frame)),
            "source_start": frame[TIMESTAMP_COLUMN].min().strftime(
                "%Y-%m-%d %H:%M:%S"
            ),
            "source_end": frame[TIMESTAMP_COLUMN].max().strftime(
                "%Y-%m-%d %H:%M:%S"
            ),
            "train_station_columns": len(train_columns),
            "verify_station_columns": len(verify_columns),
            "binary_values": [0, 1],
        },
        "selection": {
            "requested_start": requested_start.strftime(
                "%Y-%m-%d %H:%M:%S"
            ),
            "rule": (
                "timestamp >= requested_start AND any TRAIN station ON "
                "AND any VERIFY station ON"
            ),
            "retained_frames": int(len(retained)),
            "retained_start": retained[TIMESTAMP_COLUMN].min().strftime(
                "%Y-%m-%d %H:%M:%S"
            ),
            "retained_end": retained[TIMESTAMP_COLUMN].max().strftime(
                "%Y-%m-%d %H:%M:%S"
            ),
            "state_change_frames": int(len(change_indices)),
            "stations_ever_on_in_selected_window": int(ever_on),
        },
        "time": {
            "timestamp_semantics": (
                "timestamp_LST_as_stored preserved without timezone conversion"
            ),
            "granularity": "hour",
            "runs": timestamp_runs(retained[TIMESTAMP_COLUMN]),
            "change_indices": change_indices,
        },
        "counts": {
            "station_ids": len(groups),
            "train_station_ids": len(train_columns),
            "verify_station_ids": len(verify_columns),
            "selected_frames": int(len(retained)),
            "stations_ever_on_selected": int(ever_on),
            "stations_always_off_selected": int(len(groups) - ever_on),
        },
        "groups": groups,
    }

    serialized = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    encoded = base64.b64encode(
        gzip.compress(serialized, compresslevel=9)
    ).decode("ascii")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(encoded, encoding="ascii")

    print(f"[OK] {args.output}")
    print(
        json.dumps(
            {
                "source_sha256": payload["source"]["sha256"],
                "source_rows": payload["source"]["source_rows"],
                "retained_frames": payload["selection"]["retained_frames"],
                "retained_start": payload["selection"]["retained_start"],
                "retained_end": payload["selection"]["retained_end"],
                "state_change_frames": payload["selection"][
                    "state_change_frames"
                ],
                "stations_ever_on_selected": ever_on,
                "encoded_bytes": len(encoded),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
