---
name: rag-bootstrap
description: 프로젝트에 cc-advanced-rag 인덱스를 설정·활성화할 때 실행. "rag-bootstrap" 매직 키워드를 훅이 주입하거나 사용자가 /rag-init을 호출하면 이 스킬로 진입. privacyMode 결정·config 생성·DB 초기화·git hook 설치·.gitignore 갱신·파서 pre-warm·초기 인덱싱을 한 번에 수행.
category: Infrastructure Operations
tags: [rag, bootstrap, setup, mcp, indexing]
---

## Role

`cc-advanced-rag` 플러그인의 프로젝트 초기 설정을 **1회성**으로 수행한다. 훅이 감지한 매직 키워드 또는 `/rag-init` 커맨드로 진입. 반드시 **AskUserQuestion으로 사용자 확인 후** 실제 파일 작성을 시작한다.

## Procedure

1. **privacy 확인** — `AskUserQuestion`으로 아래 2개 질문을 **한 번에** 묻는다 (multiSelect=false):
   - Q1: "이 프로젝트에 cc-advanced-rag를 활성화할까요?" → `네, 활성화` | `아니오`
   - Q2: "이 코드는 **사외 반출 금지**(기밀) 코드인가요?" → `네 (Voyage/OpenAI 차단, Ollama 강제)` | `아니오 (Voyage 기본)` | `잘 모르겠음 (안전을 위해 Ollama 사용)`

   Q1이 "아니오"면 즉시 종료 ("플러그인은 비활성 상태로 유지됩니다").

2. **config 파일 생성** — `<project>/.claude/code-rag.config.json` 작성.
   - Q2가 "네" 또는 "모르겠음" → `embedding.provider = "ollama"`, `privacyMode = true`.
   - 그 외 → `embedding.provider = "voyage"`, `privacyMode = false`.
   - 템플릿은 `assets/code-rag.config.template.json` (또는 플러그인 루트의 `templates/code-rag.config.json`)을 기반으로 복사 후 provider/privacyMode만 치환.
   - 참고: `references/config-schema.md`에 필드별 의미·기본값 요약.

3. **DB 초기화** — `Bash`로 실행:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh
   ```
   (sqlite-vec 로드 스모크 + 테이블 생성 + meta.stored_dimension 기록)

4. **`.gitignore` 비파괴 append** — `/.claude/code-rag.db*`·로그·락 항목 자동 추가 (`src/bootstrap/gitignore-append.ts` 사용).

5. **git post-commit 훅 설치** — chain-call 블록으로 비파괴 설치 (`src/bootstrap/install-git-hook.ts`). 기존 훅 내용 보존.

6. **파서 pre-warm** — config `languages`에 포함된 파서만 순차 로드 (`src/indexer/parsers/registry.ts::preWarmParsers`). WASM 로드 실패 언어는 자동 비활성화 + 경고 출력.

7. **초기 인덱싱** — `bun scripts/index.ts --full`을 백그라운드로 실행하고 jobId·예상 시간 안내.

8. **완료 보고** — index_status 결과 요약, 다음 액션(`/rag-status`·`/rag-doctor`) 안내.

## Gotchas (highest-signal 축적 목록)

- **sqlite-vec 네이티브 로드 실패**: `setup.sh`가 `select vec_version()` 스모크에서 실패 → `SQLITE3_VEC_PREBUILT=0 SQLITE3_VEC_POSTINSTALL=1`로 로컬 빌드 폴백. C 컴파일러 필요. `/rag-doctor`로 진단.
- **privacyMode 오선택 복구**: 사용자가 실수로 외부 provider 허용 후 후회하면 `code-rag.config.json`의 `embedding.provider="ollama"` + `privacyMode=true`로 수정 → `rebuild_index --full` 실행. 기존 DB의 벡터는 dimension 변경 시 반드시 전량 재생성 필요.
- **dimension mismatch**: provider/model 바꿔서 `dimension`이 달라지면 `client.ts`가 `DimensionMismatchError` 발생. 자동 복구 금지(기존 인덱스를 잘못된 기준으로 덮어쓰기 방지). 명시적 `rebuild_index --full` 요구.
- **git hook 중복 설치 방지**: `install-git-hook.ts`는 `# BEGIN cc-advanced-rag post-commit` ~ `# END` 블록 내부만 교체. 사용자의 다른 훅 내용은 보존. 이미 블록이 동일하면 no-op.
- **bootstrap 중단 시 재개**: 2단계(DB init) 이후 중단되면 config 파일만 남음. 다음 세션의 SessionStart가 DB 부재를 감지 → `/rag-doctor` 권고. 사용자가 `/rag-init`으로 재진입하면 "이미 설정됨" 체크 후 부족한 단계만 수행(AskUserQuestion 생략 옵션).
- **WASM 언어별 로드 실패 graceful degradation**: 파서 pre-warm에서 특정 언어 실패 시 해당 언어만 비활성화. 전체 중단 금지. `/rag-doctor`에 실패 언어 리스트 노출.
- **Ollama 미기동 상태**: privacyMode=true인데 Ollama 서버가 안 떠 있으면 `healthCheck()` 실패. 바로 에러로 bootstrap 중단하지 말고 "Ollama 서버를 시작한 뒤 /rag-init을 다시 실행하세요" 안내 후 부분 완료 상태로 종료.
- **대용량 모노레포 초기 인덱싱 시간**: 10k 파일 기준 Voyage API로 ~10분. 사용자에게 "백그라운드 인덱싱 중 작업 계속 가능"임을 명시.

## File references

- Config 로더: `src/config/loader.ts`
- DB 클라이언트: `src/db/client.ts` (openClient, DimensionMismatchError, acquireLock)
- Bootstrap 헬퍼: `src/bootstrap/gitignore-append.ts`, `src/bootstrap/install-git-hook.ts`
- 파서 레지스트리: `src/indexer/parsers/registry.ts` (preWarmParsers)
- 템플릿: `templates/code-rag.config.json`
- 인덱서 엔트리: `scripts/index.ts` (Step 10에서 작성)
- 상세 config 스키마 설명: `references/config-schema.md`

## Usage examples

**자동 트리거** (hook 주입):
```
[MAGIC KEYWORD: rag-bootstrap] 이 레포에는 지원 언어 코드가 충분합니다. ...
```
→ Claude가 이 스킬을 호출 → AskUserQuestion → 단계별 설정.

**수동 호출**:
```
/rag-init
```
→ 같은 스킬로 진입 (이미 설정됐으면 부족한 단계만 수행).
