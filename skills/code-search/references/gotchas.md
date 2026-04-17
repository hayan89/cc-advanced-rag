# code-search 함정 모음

실제 실행 중 경험한 패턴들. 새 케이스 발생 시 이곳에 축적.

## 인덱스 상태 관련

- **`DimensionMismatchError`** → provider/model/dimension을 바꾸면 기존 벡터 모두 무효. `rebuild_index --full` 필수. 자동 복구 없음(부분 re-embed가 잘못된 기준을 생성할 위험).
- **`no tags found`** → `chunk_tags` 정규화 테이블이 비어 있음. Step 7 구현 전 인덱스이거나 해당 파일이 아직 인덱싱 안 됨.
- **`chunks=0`** → 초기 인덱싱 미수행. `/rag-init` 또는 `bun scripts/index.ts --full` 실행.
- **`last_indexed_at=never`** → 인덱싱 중 실패. `.claude/code-rag.log` 확인 후 `/rag-doctor --fix`.

## 쿼리 관련

- **FTS 예약어 `AND/OR/NOT/NEAR`** → 자동 quote되지만 여전히 매칭 결과가 예상과 다를 수 있음. 영어 일반 단어로 바꾸거나 `search_symbol` 병행.
- **한글 전용 쿼리** → FTS 토크나이저(porter unicode61)는 한글 잘 다루지만 짧은 단어는 스킵. 2글자 이상 보장.
- **1글자 심볼(`q`, `i/o`, `e`)** → FTS에서 제외됨. `search_symbol({name: "q", exact: true})` 사용.
- **쿼리에 경로 넣기** → 부정확. `scope` 인자나 `lookup_file`로 분리.

## 성능 관련

- **`search_code` p95 ≥ 1s** → 10k chunks에서는 SLO 초과 가능. 벤치마크 필요, HNSW 대체 검토(DuckDB+VSS).
- **첫 쿼리 cold-start** → tree-sitter WASM + sqlite-vec 초기 로드. session-start 훅에서 pre-warm.
- **`rebuild_index` 응답이 "bun ..."** → 서버는 장시간 인덱싱 미구동. 별도 터미널로 실행 후 `index_status`로 폴링.

## 개발·유지보수

- **WASM 로드 실패 언어** → graceful degradation. 해당 언어만 비활성, 다른 언어 계속 동작. `/rag-doctor`에 실패 리스트 노출.
- **다중 git worktree** → 기본은 primary worktree만 완전 지원. 보조 worktree는 `dbPath` 분리 권고. `/rag-doctor`가 감지.
- **DB 손상** → `integrity_check` 실패 시 `/rag-doctor --fix`: WAL checkpoint → `.corrupted-{ts}` 백업 → `rebuild_index --full`.
