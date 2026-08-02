# 40 m Wind Station Map

`40m_WRF_WS_공간목록.csv`에서 관측소 명목 좌표를 읽어 대화형 Folium 지도를 생성하고 GitHub Pages에 자동 배포하는 저장소입니다.

## 공간적 의미

지도에 표시하는 좌표는 **station nominal coordinate**입니다.

- `FLS_HEADER`: 원시 FLS 헤더에서 직접 확인한 좌표
- `LEGACY_CODE`: legacy station metadata에서 복원한 후보 좌표
- `UNKNOWN`: 지도에서 제외
- 실제 `wrf_std_40m` 추출 WRF grid 좌표: 현재 `UNKNOWN`, 지도에 표시하지 않음

따라서 이 지도를 개별 풍력터빈의 정확한 배치도 또는 실제 WRF grid 지도라고 해석하면 안 됩니다.

## 표시 규칙

| 구분 | 표현 |
|---|---|
| `tr` | 빨간 원 |
| `ve` / `vr` | 파란 삼각형 |
| `FLS_HEADER` | 채워진 마커 |
| `LEGACY_CODE` | 속이 빈 마커 |
| `NWP_ONLY_NO_GT` | 회색 마름모 |
| 좌표 결측 / `UNKNOWN` | 지도 제외 후 경고 |

## 실제 좌표 CSV 올리기

서버의 프로젝트 저장소에서 실행합니다.

```bash
cd /root/idea_wind

git remote add pung https://github.com/Pogjunan/Pung.git  # 최초 한 번만
git fetch pung

git worktree add /tmp/pung-map pung/main
cp /root/idea_wind/40m_WRF_WS_공간목록.csv /tmp/pung-map/
cd /tmp/pung-map

git add 40m_WRF_WS_공간목록.csv
git commit -m "Add station coordinate registry"
git push pung HEAD:main
```

이미 저장소를 별도로 clone했다면 CSV만 저장소 루트에 복사해 push하면 됩니다.

## GitHub Pages 설정

저장소에서 다음을 한 번 설정합니다.

```text
Settings → Pages → Build and deployment → Source → GitHub Actions
```

그 후 CSV 또는 지도 코드가 push될 때마다 `.github/workflows/deploy-map.yml`이 실행됩니다.

CSV가 아직 없을 때는 설치 안내 페이지가 배포되고, CSV를 올린 뒤에는 대화형 지도로 자동 교체됩니다.

## 로컬 빌드

```bash
python -m pip install -r requirements.txt
python scripts/build_map.py \
  --input 40m_WRF_WS_공간목록.csv \
  --output _site
```

생성 결과:

```text
_site/index.html
_site/station_coordinate_audit.csv
_site/build_summary.json
```

## 필수 CSV 열

```text
split
station
latitude_deg
longitude_deg
coordinate_source
status
```

선택 열:

```text
candidate_pair_count_wrf_plus9h
korean_name
note
```
