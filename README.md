# 40 m Wind Station Maps

대한민국 40 m 풍속 관측 자료를 네 가지 관점으로 표시하는 GitHub Pages 대시보드입니다.

```text
https://pogjunan.github.io/Pung/
```

## 페이지

1. `명목 관측소 위치`
2. `TRAIN·VERIFY 공통시간`
3. `전체 WS 기간 (1990~)`
4. `Paired Train 8 · Test 7`

모든 지도에서 표시 좌표는 station nominal coordinate이며, 실제 WRF 추출 grid 또는 검증된 개별 풍력터빈 좌표가 아닙니다.

## 전체 WS 기간

전체 43개 WS station 열을 일 단위로 표시합니다.

```text
TRAIN 22
VERIFY 21
EVER ON 43/43
NEVER ON 0
```

표시 시간은 `1990-01-01`부터 시작합니다. 실제 자료는 `1996-05-31`부터이므로 그 이전은 회색 `NO SOURCE`입니다.

- ON: 해당 날짜에 non-null WS가 1시간 이상 존재
- OFF: 원본 시간 범위 안이지만 해당 날짜에 관측 없음
- NO SOURCE: 원본 시작 전
- `jeolla_boseong`: ON 이력 집계에는 포함되지만 좌표가 없어 핀은 없음
- `jeolla_gunjang`: WS 열 자체가 없으므로 대상에서 제외

이 페이지는 브라우저에서 gzip을 해제하지 않습니다. GitHub Actions가 배포 시 일반 JavaScript 데이터인 `data/full-history-data.js`를 생성하므로, 브라우저의 `DecompressionStream` 지원 여부와 관계없이 바로 로드됩니다.

## TRAIN·VERIFY 공통시간

사용자가 제공한 `WS_STD_40M_STATION_HOURLY_ONOFF.csv`에서 다음 조건을 모두 만족하는 시간만 유지합니다.

```text
timestamp >= 2015-01-01 00:00:00
AND TRAIN station 중 하나 이상 ON
AND VERIFY station 중 하나 이상 ON
```

실제 선택 범위:

```text
2016-03-01 00:00:00 ~ 2023-10-31 14:00:00
54,000 frames
```

이 구간에서는 43개 중 18개 station만 한 번 이상 ON이며, 25개는 운영기간이 공통 구간 밖이라 계속 OFF입니다.

## Paired Train 8 · Test 7

`WRF +9h` 정렬이 가능한 기간에 대해 선택된 물리 지점을 시간 단위로 표시합니다.

```text
2015-01-01 09:00:00 ~ 2024-01-01 08:00:00
78,888 hourly frames
EVER ON 15/15
```

### Train 8 physical sites

| 물리 지점 | member station |
|---|---|
| `haengwon` | `jeju_haengwon2`, `jeju_haengwon3`, `jeju_haengwon4` |
| `jeolla_boseong` | `jeolla_boseong` |
| `westsea_hemosu1` | `westsea_hemosu1` |
| `westsea_jugdo` | `westsea_jugdo` |
| `southsea_yeosu1` | `southsea_yeosu1` |
| `southsea_yeosu2` | `southsea_yeosu2` |
| `southsea_jindo` | `southsea_jindo` |
| `ieodo` | `southsea_ieodo`, `southsea_ieodo2` |

### Test 7 physical sites

| 물리 지점 | member station |
|---|---|
| `jeju_dongbok` | `jeju_dongbok` |
| `kangwon_pyeongchang` | `kangwon_pyeongchang` |
| `jeolla_aphae` | `jeolla_aphae` |
| `jeolla_yeonggwang` | `jeolla_yeonggwang` |
| `southsea_tongyeong` | `southsea_tongyeong` |
| `gyeongsang_gori` | `gyeongsang_gori` |
| `eastsea_ulsan` | `eastsea_ulsan` |

현재 Test 7 목록은 40 m pairable 후보 중 `jeolla_naju`를 제외한 선택으로 명시적으로 고정했습니다. 선택 목록은 `data/ws_paired_selected_hourly.json.gz.b64`에 기록됩니다.

동일 물리 지점의 여러 station은 풍속값을 평균하지 않고 ON/OFF만 OR로 결합합니다.

## 표현 규칙

| 의미 | 표현 |
|---|---|
| TRAIN | 빨간 원 |
| VERIFY / TEST | 파란 삼각형 |
| ON | 채워진 마커 |
| OFF | 속이 빈 반투명 마커 |
| NO SOURCE | 회색 마커 |

## 시간 조작

- 슬라이더와 좌우 버튼: 1일 또는 1시간 단위 직접 이동
- 재생 버튼: ON/OFF 상태가 실제로 바뀌는 frame으로 이동
- 속도: `0.5×`, `1×`, `2×`, `3×`, `4×`, `5×`
- Space: 재생/정지
- 좌우 화살표: 이전/다음 frame

## 데이터 계보

원본 WS 및 ON/OFF CSV는 수정하거나 Pages에 공개하지 않습니다. 배포에는 다음 파생 자료만 포함합니다.

```text
data/ws_availability_common_hourly.json.gz.b64
data/full-history-data.js
data/paired-data.js
```

업로드한 ON/OFF CSV SHA-256:

```text
1ce8382962c350ebe2d6edeacb3304acc637b8b7cbff1b0411d63751e3386bc1
```

## GitHub Actions 검증

`.github/workflows/deploy-map.yml`은 배포 전에 다음을 강제 검사합니다.

- Python 및 브라우저 JavaScript 문법
- 공통시간: 43 station, 54,000 frames
- 전체기간: `EVER ON 43/43`, `NEVER ON 0`
- Paired: Train 8, Test 7, `EVER ON 15/15`
- 좌표 보유 WS station 42개
- 좌표 보유 paired site 14개 (`jeolla_boseong` 제외)
