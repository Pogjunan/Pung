#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import gzip
import itertools
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


KOREAN_LABELS = {
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
    "haengwon": "제주 행원",
    "ieodo": "남해 이어도",
    "jeju_daejungfarm": "제주 대정",
    "jeju_dongbok": "제주 동복",
    "jeju_gimnyeong": "제주 김녕",
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
            "Aggregate non-null hourly WS observations into a compact "
            "physical-site daily availability JSON."
        )
    )
    parser.add_argument("--observations", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--default-start", default="2015-01-01")
    return parser.parse_args()


def haversine_km(
    latitude_1: float,
    longitude_1: float,
    latitude_2: float,
    longitude_2: float,
) -> float:
    radius_km = 6371.0088
    phi_1 = math.radians(latitude_1)
    phi_2 = math.radians(latitude_2)
    delta_phi = math.radians(latitude_2 - latitude_1)
    delta_lambda = math.radians(longitude_2 - longitude_1)
    value = (
        math.sin(delta_phi / 2.0) ** 2
        + math.cos(phi_1)
        * math.cos(phi_2)
        * math.sin(delta_lambda / 2.0) ** 2
    )
    return 2.0 * radius_km * math.asin(math.sqrt(value))


def coordinate_summary(
    group_metadata: pd.DataFrame,
) -> tuple[float | None, float | None, str, float | None]:
    coordinates = group_metadata[
        ["latitude_deg", "longitude_deg"]
    ].dropna()

    if coordinates.empty:
        return None, None, "unknown", None

    latitude = float(coordinates["latitude_deg"].mean())
    longitude = float(coordinates["longitude_deg"].mean())
    unique_coordinates = coordinates.drop_duplicates()

    max_spread_km = 0.0
    coordinate_pairs = list(
        unique_coordinates.itertuples(index=False, name=None)
    )
    for (lat_1, lon_1), (lat_2, lon_2) in itertools.combinations(
        coordinate_pairs, 2
    ):
        max_spread_km = max(
            max_spread_km,
            haversine_km(lat_1, lon_1, lat_2, lon_2),
        )

    rule = (
        "mean_of_member_station_coordinates"
        if len(unique_coordinates) > 1
        else "member_station_coordinate"
    )
    return latitude, longitude, rule, max_spread_km


def coordinate_source(group_metadata: pd.DataFrame) -> str:
    sources = sorted(
        group_metadata["coordinate_source"]
        .dropna()
        .astype(str)
        .unique()
        .tolist()
    )
    if sources == ["FLS_HEADER"]:
        return "FLS_HEADER"
    if "FLS_HEADER" in sources:
        return "MIXED_WITH_FLS_HEADER"
    if sources:
        return "+".join(sources)
    return "UNKNOWN"


def main() -> None:
    args = parse_args()

    observations = pd.read_csv(
        args.observations,
        parse_dates=["timestamp_LST_as_stored"],
    )
    metadata = pd.read_csv(args.metadata)

    required_observation_columns = {
        "timestamp_LST_as_stored",
        "split",
        "station",
        "ws_40m_mps",
    }
    required_metadata_columns = {
        "split",
        "station",
        "physical_site_group",
        "latitude_deg",
        "longitude_deg",
        "coordinate_source",
    }
    missing_observation_columns = (
        required_observation_columns.difference(observations.columns)
    )
    missing_metadata_columns = (
        required_metadata_columns.difference(metadata.columns)
    )
    if missing_observation_columns:
        raise ValueError(
            "Missing observation columns: "
            f"{sorted(missing_observation_columns)}"
        )
    if missing_metadata_columns:
        raise ValueError(
            "Missing metadata columns: "
            f"{sorted(missing_metadata_columns)}"
        )

    observations = observations.dropna(
        subset=["timestamp_LST_as_stored", "ws_40m_mps"]
    ).copy()
    observations["split"] = observations["split"].astype(str).str.upper()
    metadata["split"] = metadata["split"].astype(str).str.upper()

    observation_groups = observations.merge(
        metadata[
            ["split", "station", "physical_site_group"]
        ],
        on=["split", "station"],
        how="left",
        validate="many_to_one",
    )
    if observation_groups["physical_site_group"].isna().any():
        missing_stations = sorted(
            observation_groups.loc[
                observation_groups["physical_site_group"].isna(),
                "station",
            ]
            .astype(str)
            .unique()
            .tolist()
        )
        raise ValueError(
            "Observation stations missing from metadata: "
            f"{missing_stations}"
        )

    hourly_group = observation_groups[
        ["timestamp_LST_as_stored", "split", "physical_site_group"]
    ].drop_duplicates()
    hourly_group["date"] = (
        hourly_group["timestamp_LST_as_stored"].dt.normalize()
    )
    daily_counts = (
        hourly_group.groupby(
            ["date", "split", "physical_site_group"],
            as_index=False,
        )
        .agg(
            observed_hours=(
                "timestamp_LST_as_stored",
                "nunique",
            )
        )
    )

    start_timestamp = observations["timestamp_LST_as_stored"].min()
    end_timestamp = observations["timestamp_LST_as_stored"].max()
    all_dates = pd.date_range(
        start_timestamp.normalize(),
        end_timestamp.normalize(),
        freq="D",
    )

    group_order = (
        metadata[["split", "physical_site_group"]]
        .drop_duplicates()
        .sort_values(["split", "physical_site_group"])
        .reset_index(drop=True)
    )
    group_order["id"] = np.arange(len(group_order), dtype=int)
    group_ids = {
        (row.split, row.physical_site_group): int(row.id)
        for row in group_order.itertuples(index=False)
    }

    active_days_by_group: dict[int, list[int]] = {
        int(group_id): [] for group_id in group_order["id"]
    }
    first_day = all_dates[0]
    for row in daily_counts.itertuples(index=False):
        group_id = group_ids[(row.split, row.physical_site_group)]
        day_index = int((row.date - first_day).days)
        active_days_by_group[group_id].append(day_index)

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

    groups: list[dict[str, Any]] = []
    for group_row in group_order.itertuples(index=False):
        group_metadata = metadata.loc[
            (metadata["split"] == group_row.split)
            & (
                metadata["physical_site_group"]
                == group_row.physical_site_group
            )
        ].copy()
        group_availability = hourly_group.loc[
            (hourly_group["split"] == group_row.split)
            & (
                hourly_group["physical_site_group"]
                == group_row.physical_site_group
            )
        ]

        latitude, longitude, rule, spread_km = coordinate_summary(
            group_metadata
        )
        groups.append(
            {
                "id": int(group_row.id),
                "physical_site_group": (
                    group_row.physical_site_group
                ),
                "label_ko": KOREAN_LABELS.get(
                    group_row.physical_site_group,
                    group_row.physical_site_group,
                ),
                "split": group_row.split,
                "stations": sorted(
                    group_metadata["station"].astype(str).tolist()
                ),
                "latitude_deg": (
                    None
                    if latitude is None
                    else round(latitude, 6)
                ),
                "longitude_deg": (
                    None
                    if longitude is None
                    else round(longitude, 6)
                ),
                "coordinate_source": coordinate_source(
                    group_metadata
                ),
                "coordinate_rule": rule,
                "member_coordinate_max_spread_km": (
                    None
                    if spread_km is None
                    else round(spread_km, 4)
                ),
                "observed_unique_hours": int(
                    group_availability[
                        "timestamp_LST_as_stored"
                    ].nunique()
                ),
                "observed_days": int(
                    group_availability["date"].nunique()
                ),
                "first_observation": (
                    group_availability[
                        "timestamp_LST_as_stored"
                    ]
                    .min()
                    .strftime("%Y-%m-%d %H:%M:%S")
                ),
                "last_observation": (
                    group_availability[
                        "timestamp_LST_as_stored"
                    ]
                    .max()
                    .strftime("%Y-%m-%d %H:%M:%S")
                ),
                "on_day_runs": inclusive_runs(
                    active_days_by_group[int(group_row.id)]
                ),
            }
        )

    payload = {
        "schema_version": 2,
        "encoding": "per_group_inclusive_day_index_runs",
        "title_ko": "시간에 따른 실제 풍속 관측여부",
        "title_en": (
            "Temporal availability of observed wind speed"
        ),
        "time": {
            "timestamp_field": "timestamp_LST_as_stored",
            "timestamp_semantics": (
                "datetime_LST preserved exactly as stored; "
                "canonical timezone not asserted"
            ),
            "granularity": "calendar_day",
            "source_start": start_timestamp.strftime(
                "%Y-%m-%d %H:%M:%S"
            ),
            "source_end": end_timestamp.strftime(
                "%Y-%m-%d %H:%M:%S"
            ),
            "date_start": all_dates[0].strftime("%Y-%m-%d"),
            "date_end": all_dates[-1].strftime("%Y-%m-%d"),
            "default_start": max(
                args.default_start,
                all_dates[0].strftime("%Y-%m-%d"),
            ),
            "default_end": all_dates[-1].strftime("%Y-%m-%d"),
            "on_rule": (
                "ON when at least one non-null ws_40m_mps "
                "observation exists for any member station of "
                "the physical site group on that stored calendar date"
            ),
            "zero_mps_is_observed": True,
        },
        "counts": {
            "raw_non_null_observation_rows": int(
                len(observations)
            ),
            "train_rows": int(
                (observations["split"] == "TRAIN").sum()
            ),
            "verify_rows": int(
                (observations["split"] == "VERIFY").sum()
            ),
            "station_ids": int(metadata["station"].nunique()),
            "physical_site_groups": int(
                metadata["physical_site_group"].nunique()
            ),
            "mapped_physical_site_groups": int(
                sum(
                    group["latitude_deg"] is not None
                    for group in groups
                )
            ),
            "calendar_days": int(len(all_dates)),
            "group_day_on_records": int(len(daily_counts)),
            "on_day_runs": int(
                sum(len(group["on_day_runs"]) for group in groups)
            ),
        },
        "groups": groups,
    }

    serialized = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    compressed_base64 = base64.b64encode(
        gzip.compress(serialized, compresslevel=9)
    ).decode("ascii")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        compressed_base64,
        encoding="ascii",
    )

    print(f"[OK] {args.output}")
    print(
        f"[INFO] JSON bytes={len(serialized):,}; "
        f"gzip+base64 bytes={len(compressed_base64):,}"
    )
    print(
        json.dumps(
            payload["counts"],
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
