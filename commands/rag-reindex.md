---
description: 코드베이스를 재인덱싱합니다. 증분 또는 --full.
---

플러그인 인덱서를 실행해 현재 프로젝트를 재인덱싱합니다.

- 증분 (기본): `bun ${CLAUDE_PLUGIN_ROOT}/scripts/index.ts --since=<commit>` — 지정 커밋 이후 변경만.
- 전체: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/index.ts --full` — provider/dimension이 바뀐 뒤 필수.

진행 중에도 `/rag-status`로 진척도 확인 가능.
