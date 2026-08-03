# 40 m Wind Station Maps

대한민국 40 m 풍속 관측 자료를 두 가지 관점으로 표시하는 GitHub Pages 대시보드입니다.

1. **명목 관측소 위치**
2. **시간에 따른 실제 풍속 관측여부**

GitHub Pages:

```text
https://pogjunan.github.io/Pung/
```

## 1. 명목 관측소 위치

`40m_WRF_WS_공간목록.csv`의 station nominal coordinate를 표시합니다.

| 구분 | 표현 |
|---|---|
| `tr` | 빨간 원 |
| `ve` / `vr` | 파란 삼각형 |
| `FLS_HEADER` | 원시 FLS header 좌표 |
| `LEGACY_CODE` | legacy station metadata 좌표 |
| `NWP_ONLY_NO_GT` | 회색 마름모 |
| 좌표 결측 / `UNKNOWN` | 지도 제외 후 경고 |

이 좌표는 실제 WRF 추출 grid나 검증된 개별 풍력터빈 좌표가 아닙니다.

## 2. 시간에 따른 실제 풍속 관측여부

사용자가 제공한 다음 wide ON/OFF 파일을 직접 사용합니다.

```text
WS_STD_40M_STATION_HOURLY_ONOFF.csv
```

파일 구조:

```text
timestamp_LST_as_stored
TRAIN__<station>  22개
VERIFY__<station> 21개
```

값의 의미:

```text
1 = 해당 station에 실제 WS 관측값 존재
0 = 해당 station에 실제 WS 관측값 없음
```

지도 표현:

| 구분 | 표현 |
|---|---|
| TRAIN | 빨간 원 |
| VERIFY | 파란 삼각형 |
| ON | 채워진 마커 |
| OFF | 속이 빈 반투명 마커 |

## 표시 시간 선택 규칙

사용자 요청에 따라 다음 조건을 모두 만족하는 시간만 남깁니다.

```text
timestamp >= 2015-01-01 00:00:00
AND TRAIN station 중 하나 이상 ON
AND VERIFY station 중 하나 이상 ON
```

업로드 파일에서 실제로 남는 범위는 다음과 같습니다.

```text
2016-03-01 00:00:00 ~ 2023-10-31 14:00:00
```

따라서 2024년 10월까지가 아닙니다. 원본 파일 자체의 마지막 시간은 `2024-01-01 08:00:00`이고, TRAIN과 VERIFY가 동시에 존재하는 마지막 시간은 `2023-10-31 14:00:00`입니다.

## 검증 수치

```text
원본 행                         241,818
TRAIN station 열                     22
VERIFY station 열                    21
전체 station 열                      43
선택한 공통 시간 frame           54,000
ON/OFF 상태 변화 frame            1,368
공통 구간에서 한 번 이상 ON          18
공통 구간에서 항상 OFF                25
좌표 표시 가능 station                42
physical_site_group                   39
```

공통 구간에서 항상 OFF인 25개 station은 원본 전체 열이 빈 것이 아닙니다. 해당 station의 실제 관측기간이 선택한 2015년 이후 TRAIN·VERIFY 공통 시간대 밖에 있기 때문입니다. 핀 팝업에는 공통 구간 관측시간과 원본 전체 관측기간을 모두 표시합니다.

`jeolla_boseong`은 WS 상태 집계에는 포함되지만 좌표가 없어 핀을 표시하지 못합니다. `jeolla_gunjang`은 WS 열 자체가 없는 `NWP_ONLY_NO_GT`이므로 시간 availability의 43개 station에 포함되지 않습니다.

## 시간 조작

- 슬라이더 및 이전/다음 버튼: 선택된 공통 시간 frame 단위 이동
- 재생 버튼: ON/OFF 상태가 실제로 변하는 frame으로 이동
- 속도: `0.5×`, `1×`, `2×`, `3×`, `4×`, `5×`
- Space: 재생/정지
- 좌우 화살표: 이전/다음 공통 시간 frame

시간은 `timestamp_LST_as_stored`를 timezone 변환 없이 그대로 사용합니다.

## 데이터 계보와 원본 보존

원본 ON/OFF CSV를 저장소에 그대로 공개하지 않고, 시각화에 필요한 연속 ON frame 구간만 압축해 배포합니다.

```text
data/ws_availability_common_hourly.json.gz.b64
```

업로드 원본 SHA-256:

```text
1ce8382962c350ebe2d6edeacb3304acc637b8b7cbff1b0411d63751e3386bc1
```

원본 WS CSV와 ON/OFF CSV는 수정하지 않습니다.

## ON/OFF payload 재생성

```bash
python scripts/build_common_hourly_availability.py \
  --input WS_STD_40M_STATION_HOURLY_ONOFF.csv \
  --output data/ws_availability_common_hourly.json.gz.b64 \
  --start "2015-01-01 00:00:00"
```

생성 schema:

```text
schema_version = 4
record_grain = station_column
encoding = filtered_common_hour_sequence_with_per_station_inclusive_frame_runs
```

## 로컬 통합 빌드

```bash
python -m pip install -r requirements.txt

python scripts/build_site.py \
  --nominal-input 40m_WRF_WS_공간목록.csv \
  --availability-data data/ws_availability_common_hourly.json.gz.b64 \
  --web-root web \
  --output _site
```

## GitHub Actions 검증

`.github/workflows/deploy-map.yml`은 다음을 검사한 뒤 Pages에 배포합니다.

- Python 및 브라우저 JavaScript 문법
- schema version과 encoding
- station 수 `43 = 22 + 21`
- 공통 시간 frame `54,000`
- 표시 범위 시작·종료
- 상태 변화 frame `1,368`
- 업로드 원본 SHA-256
- 좌표 보유 station 42개와 물리 지점 39개
