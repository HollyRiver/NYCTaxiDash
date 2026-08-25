# NYCTaxiDash

NYC 택시 트래픽 인터랙티브 대시보드. 정적 사이트(GitHub Pages, `docs/` 루트), 서버 없음.

## 구조
- `scripts/build_data.py` — data/NYCTaxi.csv → docs/data/trips.json·meta.json (정제 기준 포함)
- `scripts/build_flows.py` — osmnx 최단경로 → docs/data/flow_*.geojson 15슬라이스 (요일 범위 wd/we/all × 시간대 0..3/all) + 트립별 경로 길이 cache/route_km.json (build_data가 속력 계산에 사용)
- `docs/` — index.html + css/style.css + js/main.js. 데이터 수정 후 스크립트 재실행 필요.
- `ref/measure8.mjs` — 뷰포트 contain-fit 실측(CDP). `python -m http.server 8031 --directory docs` 띄운 뒤 `node ref/measure8.mjs`

## 명령
- 데이터 빌드: `python scripts/build_data.py` / `python scripts/build_flows.py` (후자는 osmnx 필요, 수 분 소요)
- 테스트: `python -m pytest tests/ -v`
- 로컬 확인: `python -m http.server 8000 --directory docs` → http://localhost:8000

## 원칙
- 화면·README 서술은 명사형/이다체 종결, ~입니다체 금지
- 디자인 토큰: 잉크 #1c1c1e, 액센트 #345995 (포트폴리오 hollyriver.github.io와 톤 통일)
- 도로 플로우는 사전 집계 슬라이스(요일 범위 3 × 시간대 5) 전환 전용, 요일×시간 자유 필터는 헥스빈·차트 담당 (구조적 분업 — 변경 금지)
- 화면은 한 화면 고정(contain-fit) — `.dash`가 `--dash-ratio`/`--dash-maxh`/`--chrome`으로 뷰포트에 맞춰지고 남는 세로·가로는 여백. 높이는 `height`가 아니라 `min-height`로 줄 것(확정 높이는 짧은 뷰포트에서 콘텐츠가 푸터를 덮음). 푸터 등 대시보드 밖 세로 요소를 바꾸면 `--chrome`도 함께 조정. 뷰포트 세로 632px 미만에서만 스크롤 발생
- 해설 텍스트(관찰·데이터 정제 기준·한계)는 화면에 두지 않음 — README.md가 정본, 푸터 링크로만 연결
- 속력·거리는 OSM 도로망 최단경로 길이 기준 (미라우팅 107건만 직선거리) — 관련 수치 수정 시 README 일관성 유지
- 통계적 정직: 표본 미달 셀 반투명, 이상치 제거 기준은 build_data.py 상수로 문서화
- 설계 배경: docs_dev/superpowers/specs/2026-08-21-nyctaxidash-design.md, docs_dev/superpowers/specs/2026-08-25-one-screen-layout-design.md
