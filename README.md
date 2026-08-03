# 40 m Wind Station Maps

대한민국 40 m 풍속 관측 자료를 두 가지 관점으로 표시하는 GitHub Pages 대시보드입니다.

1. **명목 관측소 위치**
2. **시간에 따른 실제 풍속 관측여부**

GitHub Pages:

```text
https://pogjunan.github.io/Pung/
```

## 1. 명목 관측소 위치

`40m_WRF_WS_공간목록.csv`의 관측소 명목 좌표를 표시합니다.

| 구분 | 표현 |
|---|---|
| `tr` | 빨간 원 |
| `ve` / `vr` | 파란 삼각형 |
| `FLS_HEADER` | 좌표 출처가 원시 FLS header |
| `LEGACY_CODE` | legacy station metadata 좌표 |
| `NWP_ONLY_NO_GT` | 회색 마름모 |
| 좌표 결측 / `UNKNOWN` | 지도 제외 후 경고 |

이 좌표는 station nominal coordinate입니다. 실제 `wrf_std_40m` 추출 WRF grid 좌표나 검증된 개별 터빈 좌표가 아닙니다.

## 2. 시간에 따른 실제 풍속 관측여부

`ws_std_40m_tr.csv`와 `ws_std_40m_ve.csv`의 **개별 WS station 열**을 일 단위로 추적합니다.

| 구분 | 표현 |
|---|---|
| TRAIN | 빨간 원 |
| VERIFY | 파란 삼각형 |
| ON | 채워진 마커 |
| OFF | 속이 빈 반투명 마커 |

ON 판정:

```text
해당 station 열에서 저장 날짜에 non-null ws_40m_mps가
1시간 이상 존재하면 ON
```

- `0 m/s`는 유효 관측으로 ON입니다.
- OFF는 **현재 날짜에 값이 없음**을 뜻하며 station 열 전체가 빈 것을 뜻하지 않습니다.
- TRAIN 22개와 VERIFY 21개, 총 43개 station 모두 실제 ON 구간이 존재합니다.
- 좌표가 없는 `jeolla_boseong`까지 상태 집계에는 포함하지만 지도 핀은 표시할 수 없습니다.
- `jeolla_gunjang`은 WS가 없는 `NWP_ONLY_NO_GT`이므로 시간 availability 대상에서 제외합니다.
- 행원 4개와 이어도 2개는 station별 WS 값을 따로 유지합니다.
- 동일 물리 위치의 마커가 겹치면 아이콘만 화면상 소폭 분리하고 팝업에는 원 명목 좌표를 표시합니다.

## 기본 시간 범위와 재생 방식

기본 범위는 다음 전체 관측기간입니다.

```text
1996-05-31 15:00:00 ~ 2024-01-01 08:00:00
```

기존 2015년 시작 화면에서는 2015년 이전에 운영을 종료한 24개 station이 한 번도 ON으로 보이지 않았습니다. 현재 기본 범위를 전체 기간으로 바꿔 모든 station이 실제 운영기간에 채워지도록 수정했습니다.

- 슬라이더: 일 단위
- 재생 버튼: ON/OFF 상태가 바뀌는 날짜로 자동 이동
- 속도: `0.5×`, `1×`, `2×`, `3×`, `4×`, `5×`
- 표시 구간 선택: 전체 관측기간 또는 2015년 이후
- Space: 재생/정지
- 좌우 화살표: 하루 이동

## 자료 규모

```text
실제 non-null WS rows: 653,116
TRAIN rows: 438,663
VERIFY rows: 214,453
TRAIN station IDs: 22
VERIFY station IDs: 21
전체 station IDs: 43
좌표 표시 가능 station IDs: 42
physical_site_groups: 39
전체 일수: 10,077
station-day ON records: 28,050
연속 ON run 수: 291
```

브라우저 배포용 `data/ws_availability_daily.json.gz.b64`은 station별 연속 ON 날짜를 `[start_index, end_index]` run으로 저장한 뒤 gzip+base64로 압축합니다. 원본 long CSV는 Pages에 배포하지 않습니다.

## 원본 보존

원본 `ws_std_40m_tr.csv`, `ws_std_40m_ve.csv`와 통합 long CSV는 수정하지 않습니다. Pages에는 시각화에 필요한 파생 availability 데이터만 배포합니다.

시간은 `timestamp_LST_as_stored`를 이동하지 않고 사용하며 canonical timezone은 별도로 확정해야 합니다. `ws_std_40m`의 값은 현재 감사상 `CONDITIONAL_GT`입니다.

## GitHub Pages 자동 배포

다음 파일이 변경되면 workflow가 자동 실행됩니다.

```text
40m_WRF_WS_공간목록.csv
data/**
web/**
scripts/**
requirements.txt
```

workflow:

```text
.github/workflows/deploy-map.yml
```

빌드 시 Python 문법, 브라우저 JavaScript 문법, schema version, station 수와 좌표 수를 검사한 뒤 Pages에 배포합니다.

## 로컬 통합 빌드

```bash
python -m pip install -r requirements.txt

python scripts/build_site.py \
  --nominal-input 40m_WRF_WS_공간목록.csv \
  --availability-data data/ws_availability_daily.json.gz.b64 \
  --web-root web \
  --output _site
```

## availability 데이터 재생성

```bash
python scripts/build_daily_availability.py \
  --observations WS_STD_40M_COMBINED_OBSERVATIONS_GPT_COMPACT.csv \
  --metadata WS_STD_40M_STATION_METADATA.csv \
  --output data/ws_availability_daily.json.gz.b64
```

생성 schema:

```text
schema_version = 3
record_grain = station_column
encoding = per_station_inclusive_day_index_runs
```
