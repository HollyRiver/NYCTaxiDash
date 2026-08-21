# NYCTaxiDash

NYC 택시 트래픽 인터랙티브 대시보드. 정적 사이트(GitHub Pages, `docs/` 루트), 서버 없음.

## 구조
- `scripts/build_data.py` — data/NYCTaxi.csv → docs/data/trips.json·meta.json (정제 기준 포함)
- `scripts/build_flows.py` — osmnx 최단경로 → docs/data/flow_*.geojson 15슬라이스 (요일 범위 wd/we/all × 시간대 0..3/all) + 트립별 경로 길이 cache/route_km.json (build_data가 속력 계산에 사용)
- `docs/` — index.html + css/style.css + js/main.js. 데이터 수정 후 스크립트 재실행 필요.

## 명령
- 데이터 빌드: `python scripts/build_data.py` / `python scripts/build_flows.py` (후자는 osmnx 필요, 수 분 소요)
- 테스트: `python -m pytest tests/ -v`
- 로컬 확인: `python -m http.server 8000 --directory docs` → http://localhost:8000

## 원칙
- 화면·README 서술은 명사형/이다체 종결, ~입니다체 금지
- 디자인 토큰: 잉크 #1c1c1e, 액센트 #345995 (포트폴리오 hollyriver.github.io와 톤 통일)
- 도로 플로우는 사전 집계 슬라이스(요일 범위 3 × 시간대 5) 전환 전용, 요일×시간 자유 필터는 헥스빈·차트 담당 (구조적 분업 — 변경 금지)
- 속력·거리는 OSM 도로망 최단경로 길이 기준 (미라우팅 107건만 직선거리) — 관련 수치 수정 시 인사이트·푸터·README 일관성 유지
- 통계적 정직: 표본 미달 셀 반투명, 이상치 제거 기준은 build_data.py 상수로 문서화
- 설계 배경: docs_dev/superpowers/specs/2026-08-21-nyctaxidash-design.md
