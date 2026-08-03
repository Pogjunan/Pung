# 40 m Wind Station Maps

대한민국 40 m 풍속 관측 자료를 두 가지 관점으로 표시하는 GitHub Pages 대시보드입니다.

1. **명목 관측소 위치**
2. **시간에 따른 실제 풍속 관측여부**

GitHub Pages 주소:

```text
https://pogjunan.github.io/Pung/
```

## 1. 명목 관측소 위치

`40m_WRF_WS_공간목록.csv`의 관측소 명목 좌표를 표시합니다.

| 구분 | 표현 |
|---|---|
| `tr` | 빨간 원 |
| `ve` / `vr` | 파란 삼각형 |
| `FLS_HEADER` | 채워진 마커 |
| `LEGACY_CODE` | 속이 빈 마커 |
| `NWP_ONLY_NO_GT` | 회색 마름모 |
| 좌표 결측 / `UNKNOWN` | 지도 제외 후 경고 |

이 좌표는 station nominal coordinate입니다. 실제 `wrf_std_40m` 추출 WRF grid 좌표나 검증된 개별 터빈 좌표가 아닙니다.

## 2. 시간에 따른 실제 풍속 관측여부

물리 지점별로 일 단위 ON/OFF를 재생합니다.

| 구분 | 표현 |
|---|---|
| TRAIN | 빨간 원 |
| VERIFY | 파란 삼각형 |
| ON | 채워진 마커 |
| OFF | 속이 빈 반투명 마커 |

ON 판정:

```text
해당 저장 날짜에 member station 중 하나라도
non-null ws_40m_mps가 1시간 이상 존재
```

- `0 m/s`는 유효 관측으로 ON
- 행원·이어도 중복 station의 WS 값은 평균하지 않음
- ON/OFF만 `physical_site_group` 단위로 OR 결합
- 기본 표시 구간은 2015-01-01부터 실제 최종 관측일까지
- UI에서 전체 기간 선택 가능
- 재생 속도: 0.5×, 1×, 2×, 3×, 4×, 5×
- 좌우 화살표와 Space 키로 날짜 이동·재생 가능

현재 업로드 자료의 실제 범위는:

```text
1996-05-31 15:00:00 ~ 2024-01-01 08:00:00
```

따라서 현재 데이터에는 2024-12-31까지의 관측이 포함되어 있지 않습니다.

## 자료 규모

```text
실제 non-null WS rows: 653,116
TRAIN rows: 438,663
VERIFY rows: 214,453
station IDs: 43
physical_site_groups: 39
좌표 표시 가능 물리 지점: 38
전체 일수: 10,077
ON group-day records: 23,908
```

브라우저 배포용 `data/ws_availability_daily.json.gz.b64`은 dense 행렬이 아니라 각 물리 지점의 연속 ON 날짜를 `[start_index, end_index]` run으로 저장합니다. 정확한 23,908개 ON group-day를 181개 run으로 표현한 뒤 gzip+base64로 압축합니다.

## 원본 보존

원본 `ws_std_40m_tr.csv`, `ws_std_40m_ve.csv` 및 통합 long CSV는 수정하지 않습니다. Pages에는 시각화에 필요한 파생 availability 데이터만 배포합니다.

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

실행 순서:

```text
Python 검증
→ 명목 위치 지도 생성
→ 시간 availability 페이지 조립
→ Pages artifact 생성
→ GitHub Pages 배포
```

## 로컬 통합 빌드

```bash
python -m pip install -r requirements.txt

python scripts/build_site.py \
  --nominal-input 40m_WRF_WS_공간목록.csv \
  --availability-data data/ws_availability_daily.json.gz.b64 \
  --web-root web \
  --output _site
```

생성 결과:

```text
_site/index.html
_site/nominal.html
_site/availability.html
_site/data/ws_availability_daily.json.gz.b64
_site/site_build_summary.json
```

## availability 데이터 재생성

compact long CSV와 station metadata가 있을 때:

```bash
python scripts/build_daily_availability.py \
  --observations WS_STD_40M_COMBINED_OBSERVATIONS_GPT_COMPACT.csv \
  --metadata WS_STD_40M_STATION_METADATA.csv \
  --output data/ws_availability_daily.json.gz.b64 \
  --default-start 2015-01-01
```

시간은 `timestamp_LST_as_stored`를 이동하지 않고 사용합니다. canonical timezone은 별도로 확정해야 합니다.
