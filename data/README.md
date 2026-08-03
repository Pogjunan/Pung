# Daily WS availability data

`ws_availability_daily.json.gz.b64`은 원본 WS CSV를 수정하지 않고 다음 파일에서
파생한 GitHub Pages용 압축 표현입니다.

- `WS_STD_40M_COMBINED_OBSERVATIONS_GPT_COMPACT.csv`
- `WS_STD_40M_STATION_METADATA.csv`

## ON 규칙

물리 지점 `s`, 저장 날짜 `d`에 대해:

```text
ON = 해당 날짜에 member station 중 하나라도 non-null ws_40m_mps가 1시간 이상 존재
OFF = 그 외
```

`0 m/s`는 결측이 아니라 유효 관측이므로 ON입니다.

행원과 이어도처럼 여러 station ID가 같은 `physical_site_group`에 속하면
값을 평균하지 않고, 시간별 관측 여부만 OR로 결합합니다.

## 압축 형식

먼저 10,077일 × 39지점의 dense 행렬 대신 각 물리 지점의 연속 ON 날짜를
inclusive day-index run `[start_index, end_index]`로 저장합니다. 그 JSON을 gzip
압축한 뒤 base64 텍스트로 저장하므로 GitHub에서 binary 파일 없이 관리할 수 있습니다.

```text
schema_version = 2
encoding = per_group_inclusive_day_index_runs
```

정확한 일별 ON/OFF는 총 181개의 run으로 표현되며, 원본 일별 ON 레코드
23,908개와 동치입니다.

시간은 `timestamp_LST_as_stored`를 이동하지 않았습니다. canonical timezone은
이 산출물에서 단정하지 않습니다.

현재 자료 범위는 `1996-05-31 15:00:00`부터 `2024-01-01 08:00:00`입니다.
사용자가 요청한 2015년 이후를 기본 재생 구간으로 설정했으며, 전체 기간도
UI에서 선택할 수 있습니다.
