# cc-advanced-rag config 스키마 요약

정본 Zod 스키마는 `src/config/schema.ts`. 이 문서는 필드별 의미·기본값·흔한 변경 사유를 요약한다.

## 최상위

| 필드 | 타입 | 기본 | 설명 |
|---|---|---|---|
| `dbPath` | string | `.claude/code-rag.db` | SQLite 파일. `.gitignore` 자동 추가 |
| `logPath` | string | `.claude/code-rag.log` | JSON-line 구조화 로그 |
| `lockPath` | string | `.claude/code-rag.lock` | 인덱서/rebuild_index 직렬화 락 |
| `languages` | string[] | `["typescript","tsx","javascript","jsx"]` | 인덱싱할 언어. 확장자에 따라 매칭 |
| `scope` | string[] \| null | `null` | 인덱싱 대상 glob (선택). null=프로젝트 전체 |
| `gitignoreRespect` | boolean | `true` | `.gitignore` 자동 적용 |
| `exclude` | string[] | `["node_modules/**", ...]` | 추가 exclude glob |
| `embedding` | object | 아래 참조 | 임베딩 제공자 설정 |
| `indexing` | object | 아래 참조 | 파일 필터 |
| `tagging.customTags` | `{name,regex}[]` | `[]` | 사용자 정의 태그 |
| `cache.l1TtlHours` | number | `24` | L1 정확 매치 캐시 TTL |

## embedding

| 필드 | 기본 | 비고 |
|---|---|---|
| `provider` | `voyage` | `voyage` \| `ollama` \| `openai` |
| `model` | `voyage-code-3` | provider 전환 시 조정 |
| `dimension` | `1024` | **변경 시 `rebuild_index --full` 필수** |
| `batchSize` | `128` | API batch 요청 크기 |
| `rateLimitPerMinute` | `1000` | provider RPM 상한 |
| `privacyMode` | `false` | `true` 시 외부 provider 차단, Ollama 강제 |

## indexing

| 필드 | 기본 | 비고 |
|---|---|---|
| `maxFileSizeBytes` | `1048576` (1MB) | 이보다 큰 파일은 스킵 |
| `followSymlinks` | `false` | 루프 방지 |
| `binaryDetect` | `true` | null-byte 감지로 바이너리 스킵 |

## 흔한 변경 패턴

**사외 반출 금지 코드**:
```json
{ "embedding": { "provider": "ollama", "privacyMode": true, "model": "nomic-embed-text", "dimension": 768 } }
```
+ `OLLAMA_BASE_URL` 환경 변수 설정.

**프런트엔드만 인덱싱**:
```json
{ "languages": ["typescript","tsx","svelte"], "scope": ["web/**"] }
```

**커스텀 태그 예시**:
```json
{ "tagging": { "customTags": [
  { "name": "receipt", "regex": "[Rr]eceipt|ocr_job" },
  { "name": "billing", "regex": "\\bbilling\\b" }
] } }
```

## API 키 (config에 저장 금지)

- `VOYAGE_API_KEY`
- `OPENAI_API_KEY`
- `OLLAMA_BASE_URL` (기본 `http://localhost:11434`)

모두 `.env` 또는 시스템 환경 변수로만.
