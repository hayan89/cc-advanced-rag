---
name: code-search
description: 코드베이스 탐색이 필요할 때 Read/Grep보다 먼저 호출. cc-advanced-rag MCP의 6개 툴(search_code, lookup_file, search_symbol, get_related, index_status, rebuild_index)을 사용법·쿼리 요령과 함께 제공. 자연어 쿼리·심볼 조회·관련 파일 탐색·증분 인덱싱 요청 전부 커버.
category: Library & API Reference
tags: [rag, mcp, search, code-navigation]
---

## Role

`cc-advanced-rag` MCP가 제공하는 의미 기반 코드 검색을 **Read/Grep보다 우선** 사용하도록 안내한다. 6개 툴의 선택 기준, 쿼리 작성 요령, 자주 걸리는 함정을 한 곳에 정리.

## Tool map

| 상황 | 우선 툴 | 이유 |
|---|---|---|
| 기능/동작 찾기 ("JWT 발급하는 곳") | `search_code` | RRF 하이브리드 (의미+키워드) |
| 특정 심볼 구현 ("UserService 클래스 전체") | `search_symbol` → `lookup_file` | 정확 매칭 후 파일 맥락 확인 |
| 파일 전체 구조 파악 | `lookup_file` | 인덱싱된 모든 청크 1회 조회 |
| 연관 파일 찾기 ("이 핸들러의 프런트엔드 호출") | `get_related` | 태그 overlap 기반 크로스-스택 |
| 현재 상태 확인 | `index_status` | chunks/files/dim/캐시 집계 |
| 재인덱싱 필요 | `rebuild_index` | 서버는 가이드만 반환, 실제 실행은 `scripts/index.ts` |

## Query 작성 요령

- **자연어 + 도메인 용어 섞기**: "receipt upload validation", "OCR 에러 재시도 백오프"
- **언어 이름 포함하지 말 것**: 언어 필터는 툴 인자(`language`)로 전달
- **너무 구체적인 파일명 피하기**: semantic search에서 불이익. 대신 `search_symbol`에 정확 이름 전달
- **`exact=true` 사용 시기**: 리팩토링 대상 찾을 때, 대소문자·부분 매칭 모두 필요없을 때

## Gotchas

- **dimension mismatch**: `DimensionMismatchError`가 발생하면 config의 provider/model이 바뀐 것. `rebuild_index --full` 필수. 자동 복구 안 됨.
- **1글자 또는 한글-only 쿼리**: `buildFtsQuery`가 2글자 이상 토큰만 추출. 짧은 심볼은 `search_symbol`로.
- **FTS5 예약어(AND/OR/NOT/NEAR)**: 자동 quote되지만 쿼리 결과가 기대와 다를 수 있음.
- **`highlight` 필드**: FTS5 snippet. BM25 채널이 매칭한 경우에만 존재. 순수 벡터 매칭이면 null.
- **L1 캐시 hit**: 동일 쿼리 재조회 시 50ms 미만. git HEAD가 바뀌면 자동 무효화. "[L1 hit, hits=N]" 접두 확인.
- **`get_related`가 "no tags found"**: 인덱싱이 `chunk_tags` 정규화 테이블을 채우기 전이거나 해당 파일이 인덱싱 안 됨. `index_status`로 확인.
- **`rebuild_index` 응답이 "bun scripts/index.ts ..."**: 서버 프로세스는 장시간 인덱싱을 안 돌림. 별도 터미널에서 실행.
- **privacyMode**: `true`면 외부 provider(Voyage/OpenAI) 호출 차단. Ollama 미기동 시 embed 실패.

## File references

- MCP 서버 엔트리: `server.ts`
- 툴 정의: `src/tools/*.ts`
- 검색 엔진: `src/search/hybrid.ts`, `src/search/semantic.ts`, `src/search/fts-query.ts`
- 쿼리 요령: `references/query-patterns.md`
- 상세 함정 모음: `references/gotchas.md`

## Usage examples

```
search_code({query: "receipt upload 파일 검증", limit: 10})
→ [N results, mode=hybrid] ...

search_symbol({name: "UserService", exact: true})
→ [1 symbols matching 'UserService'] src/services/user.ts:L12-80 ...

lookup_file({filePath: "src/services/user.ts"})
→ 파일 내 모든 청크 (class, methods) ...

get_related({filePath: "backend/handlers/receipt.go", limit: 5})
→ 태그 overlap 기반 프런트엔드 호출부 등

index_status({})
→ chunks=12345 files=890 dim=1024 last=2026-04-15T... L1 cache=...

rebuild_index({since: "HEAD~5"})
→ 가이드: `bun <plugin>/scripts/index.ts --since=HEAD~5`
```
