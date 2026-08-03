#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import gzip
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


STATION_KOREAN_LABELS = {
    "chungcheong_boryeong": "충남 보령",
    "chungcheong_dangjin": "충남 당진",
    "chungcheong_seocheon": "충남 서천",
    "chungcheong_seosan": "충남 서산",
    "chungcheong_taean": "충남 태안",
    "eastsea_ulsan": "동해 울산 문무바람",
    "gyeongsang_gori": "부산 기장 고리",
    "gyeongsang_uljin": "경북 울진",
    "gyeongsang_yeongdeok": "경북 영덕",
    "gyeongsang_yeongdeok2": "경북 영덕 2",
    "jeju_daejungfarm": "제주 대정",
    "jeju_dongbok": "제주 동복",
    "jeju_gimnyeong": "제주 김녕",
    "jeju_haengwon": "제주 행원",
    "jeju_haengwon2": "제주 행원 2",
    "jeju_haengwon3": "제주 행원 3",
    "jeju_haengwon4": "제주 행원 4",
    "jeju_hansu": "제주 한수",
    "jeju_ilgwa": "제주 일과",
    "jeju_panpo": "제주 판포",
    "jeju_seopji": "제주 섭지",
    "jeju_yongdang": "제주 용당",
    "jeolla_aphae": "전남 신안 압해",
    "jeolla_boseong": "전남 보성",
    "jeolla_naju": "전남 나주",
    "jeolla_yeonggwang": "전남 영광",
    "kangwon_hoenggye": "강원 횡계",
    "kangwon_hoengseong": "강원 횡성",
    "kangwon_jeongseon": "강원 정선",
    "kangwon_maebong": "강원 매봉",
    "kangwon_pyeongchang": "강원 평창",
    "kangwon_yanggu": "강원 양구",
    "kangwon_yeongwol": "강원 영월",
    "southsea_ieodo": "남해 이어도",
    "southsea_ieodo2": "남해 이어도 2",
    "southsea_jindo": "남해 진도 보배",
    "southsea_tongyeong": "남해 통영",
    "southsea_yeosu1": "남해 여수 1",
    "southsea_yeosu2": "남해 여수 2",
    "westsea_hemosu1": "서해 해모수 1호",
    "westsea_hemosu2": "서해 해모수 2호",
    "westsea_jugdo": "서해 죽도",
    "westsea_wangdeungnyeo": "서해 왕등여",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Aggregate non-null hourly WS observations into compact, "
            "station-level daily availability runs."
        )
    )
    parser.add_argument("--observations", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def inclusive_runs(day_indices: list[int]) -> list[list[int]]:
    if not day_indices:
        return []
    ordered = sorted(set(day_indices))
    runs: list[list[int]] = []
    start = ordered[0]
    end = ordered[0]
    for day_index in ordered[1:]:
        if day_index == end + 1:
            end = day_index
        else:
            runs.append([start, end])
            start = day_index
            end = day_index
    runs.append([start, end])
    return runs


def optional_string(row: pd.Series, column: str, default: str) -> str:
    if column not in row.index or pd.isna(row[column]):
        return default
    value = str(row[column]).strip()
    return value or default


def main() -> None:
    args = parse_args()
    observations = pd.read_csv(
        args.observations,
        parse_dates=["timestamp_LST_as_stored"],
    )
    metadata = pd.read_csv(args.metadata)

    required_observation_columns = {
        "timestamp_LST_as_stored", "split", "station", "ws_40m_mps"
    }
    required_metadata_columns = {
        "split", "station", "physical_site_group", "latitude_deg",
        "longitude_deg", "coordinate_source"
    }
    missing_observation_columns = required_observation_columns.difference(
        observations.columns
    )
    missing_metadata_columns = required_metadata_columns.difference(
        metadata.columns
    )
    if missing_observation_columns:
        raise ValueError(
            f"Missing observation columns: {sorted(missing_observation_columns)}"
        )
    if missing_metadata_columns:
        raise ValueError(
            f"Missing metadata columns: {sorted(missing_metadata_columns)}"
        )

    observations = observations.dropna(
        subset=["timestamp_LST_as_stored", "ws_40m_mps"]
    ).copy()
    observations["split"] = observations["split"].astype(str).str.upper()
    observations["station"] = observations["station"].astype(str).str.strip()
    metadata["split"] = metadata["split"].astype(str).str.upper()
    metadata["station"] = metadata["station"].astype(str).str.strip()

    if metadata.duplicated(["split", "station"]).any():
        duplicates = metadata.loc[
            metadata.duplicated(["split", "station"], keep=False),
            ["split", "station"],
        ].to_dict("records")
        raise ValueError(f"Duplicate station metadata: {duplicates}")

    observation_keys = observations[["split", "station"]].drop_duplicates()
    metadata_keys = metadata[["split", "station"]].drop_duplicates()
    key_check = observation_keys.merge(
        metadata_keys,
        on=["split", "station"],
        how="left",
        indicator=True,
    )
    missing_metadata = key_check.loc[
        key_check["_merge"] != "both", ["split", "station"]
    ]
    if not missing_metadata.empty:
        raise ValueError(
            "Observation stations missing from metadata: "
            f"{missing_metadata.to_dict('records')}"
        )

    hourly_station = observations[
        ["timestamp_LST_as_stored", "split", "station"]
    ].drop_duplicates()
    hourly_station["date"] = (
        hourly_station["timestamp_LST_as_stored"].dt.normalize()
    )
    daily_counts = (
        hourly_station.groupby(["date", "split", "station"], as_index=False)
        .agg(observed_hours=("timestamp_LST_as_stored", "nunique"))
    )

    start_timestamp = observations["timestamp_LST_as_stored"].min()
    end_timestamp = observations["timestamp_LST_as_stored"].max()
    all_dates = pd.date_range(
        start_timestamp.normalize(), end_timestamp.normalize(), freq="D"
    )
    first_day = all_dates[0]

    station_order = (
        metadata[["split", "station"]]
        .drop_duplicates()
        .sort_values(["split", "station"])
        .reset_index(drop=True)
    )
    station_order["id"] = np.arange(len(station_order), dtype=int)
    station_ids = {
        (row.split, row.station): int(row.id)
        for row in station_order.itertuples(index=False)
    }
    active_days_by_station: dict[int, list[int]] = {
        int(station_id): [] for station_id in station_order["id"]
    }
    for row in daily_counts.itertuples(index=False):
        station_id = station_ids[(row.split, row.station)]
        active_days_by_station[station_id].append(
            int((row.date - first_day).days)
        )

    records: list[dict[str, Any]] = []
    empty_stations: list[str] = []
    for station_row in station_order.itertuples(index=False):
        station_metadata = metadata.loc[
            (metadata["split"] == station_row.split)
            & (metadata["station"] == station_row.station)
        ].iloc[0]
        station_availability = hourly_station.loc[
            (hourly_station["split"] == station_row.split)
            & (hourly_station["station"] == station_row.station)
        ]
        runs = inclusive_runs(
            active_days_by_station[int(station_row.id)]
        )
        if not runs:
            empty_stations.append(station_row.station)
            continue
        latitude = station_metadata["latitude_deg"]
        longitude = station_metadata["longitude_deg"]
        records.append(
            {
                "id": int(station_row.id),
                "station": station_row.station,
                "physical_site_group": station_metadata["physical_site_group"],
                "label_ko": STATION_KOREAN_LABELS.get(
                    station_row.station, station_row.station
                ),
                "split": station_row.split,
                "latitude_deg": (
                    None if pd.isna(latitude) else round(float(latitude), 6)
                ),
                "longitude_deg": (
                    None if pd.isna(longitude) else round(float(longitude), 6)
                ),
                "coordinate_source": optional_string(
                    station_metadata, "coordinate_source", "UNKNOWN"
                ),
                "gt_class": optional_string(
                    station_metadata, "gt_class", "UNKNOWN"
                ),
                "source_file": optional_string(
                    station_metadata, "source_file", "UNKNOWN"
                ),
                "observed_unique_hours": int(
                    station_availability["timestamp_LST_as_stored"].nunique()
                ),
                "observed_days": int(station_availability["date"].nunique()),
                "first_observation": station_availability[
                    "timestamp_LST_as_stored"
                ].min().strftime("%Y-%m-%d %H:%M:%S"),
                "last_observation": station_availability[
                    "timestamp_LST_as_stored"
                ].max().strftime("%Y-%m-%d %H:%M:%S"),
                "on_day_runs": runs,
            }
        )

    if empty_stations:
        raise ValueError(
            "Metadata stations with no non-null WS observations: "
            f"{sorted(empty_stations)}"
        )

    payload = {
        "schema_version": 3,
        "encoding": "per_station_inclusive_day_index_runs",
        "record_grain": "station_column",
        "title_ko": "시간에 따른 실제 풍속 관측여부",
        "title_en": "Temporal availability of observed wind speed",
        "time": {
            "timestamp_field": "timestamp_LST_as_stored",
            "timestamp_semantics": (
                "datetime_LST preserved exactly as stored; "
                "canonical timezone not asserted"
            ),
            "granularity": "calendar_day",
            "source_start": start_timestamp.strftime("%Y-%m-%d %H:%M:%S"),
            "source_end": end_timestamp.strftime("%Y-%m-%d %H:%M:%S"),
            "date_start": all_dates[0].strftime("%Y-%m-%d"),
            "date_end": all_dates[-1].strftime("%Y-%m-%d"),
            "default_start": all_dates[0].strftime("%Y-%m-%d"),
            "default_end": all_dates[-1].strftime("%Y-%m-%d"),
            "playback_mode": "state_change_days",
            "on_rule": (
                "ON when at least one non-null ws_40m_mps observation "
                "exists for that station column on the stored calendar date"
            ),
            "zero_mps_is_observed": True,
        },
        "counts": {
            "raw_non_null_observation_rows": int(len(observations)),
            "train_rows": int((observations["split"] == "TRAIN").sum()),
            "verify_rows": int((observations["split"] == "VERIFY").sum()),
            "station_ids": int(metadata["station"].nunique()),
            "train_station_ids": int(
                metadata.loc[metadata["split"] == "TRAIN", "station"].nunique()
            ),
            "verify_station_ids": int(
                metadata.loc[metadata["split"] == "VERIFY", "station"].nunique()
            ),
            "mapped_station_ids": int(
                metadata[["latitude_deg", "longitude_deg"]]
                .notna().all(axis=1).sum()
            ),
            "physical_site_groups": int(
                metadata["physical_site_group"].nunique()
            ),
            "calendar_days": int(len(all_dates)),
            "station_day_on_records": int(len(daily_counts)),
            "on_day_runs": int(
                sum(len(record["on_day_runs"]) for record in records)
            ),
        },
        "groups": records,
    }

    serialized = json.dumps(
        payload, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    compressed_base64 = base64.b64encode(
        gzip.compress(serialized, compresslevel=9)
    ).decode("ascii")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(compressed_base64, encoding="ascii")

    print(f"[OK] {args.output}")
    print(
        f"[INFO] JSON bytes={len(serialized):,}; "
        f"gzip+base64 bytes={len(compressed_base64):,}"
    )
    print(json.dumps(payload["counts"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
