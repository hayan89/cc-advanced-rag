---
description: cc-advanced-rag의 환경·DB·인덱스·훅 상태를 진단하고 필요 시 복구합니다.
---

`bun ${CLAUDE_PLUGIN_ROOT}/scripts/doctor.ts` 실행. 결과는 ✅/⚠️/❌ 체크리스트:

- 환경: Bun/Node/SQLite 버전
- 네이티브 확장: `vec_version()` 로드 여부
- Config: 존재·zod 검증
- Secrets: provider 키 또는 Ollama 도달성
- DB: 파일 존재, `PRAGMA integrity_check`, `schema_version`, `stored_dimension` 일치
- 인덱스: 마지막 인덱싱 시각, HEAD diff, chunks 수, L1 히트율
- git hook: 설치 여부·변조 감지
- worktree: primary vs 보조 worktree 판정
- 로그: 최근 에러 요약

`--fix` 인자로 복구 시도:
- git hook 재설치 / `.gitignore` 재정비
- setup 재실행 (sqlite-vec 재로드)
- dimension mismatch → `rebuild_index --full` 안내
- DB `integrity_check` 실패 → WAL checkpoint 시도 → 실패 시 DB를 `.corrupted-{ts}`로 백업하고 전체 재인덱싱 안내
