# search_code 쿼리 패턴 모음

## 효과적인 패턴

- **"동작 + 도메인"**: `"JWT 발급 핸들러"`, `"receipt OCR 결과 파싱"`
- **"에러 시나리오"**: `"S3 업로드 실패 재시도"`, `"DB transaction 롤백"`
- **"프로토콜/계약"**: `"websocket handshake 인증"`, `"MCP tool 등록"`
- **"계층 + 관심사"**: `"middleware 요청 로깅"`, `"컨트롤러 입력 검증"`

## 피해야 할 패턴

- ❌ 파일명 직접 지정 → `search_symbol` 사용
- ❌ 1글자 키워드 → FTS가 2글자 이상만 토큰화
- ❌ 언어 이름 포함 → 인자 `language`로 전달
- ❌ 너무 일반적 용어만("function", "config") → 도메인 명사 추가

## 모드 선택

- `mode=hybrid` (기본): 의미 + 키워드 혼합. 대부분의 경우.
- `mode=semantic`: 순수 벡터. 키워드가 프로젝트 용어와 달라도 매칭 원할 때.

## 결과 해석

- `(score=0.9)+`: 매우 관련 — 먼저 읽기
- `(score=0.5~0.8)`: 관련 — 후속 확인
- `(score<0.5)`: 약한 관련 — 쿼리 재작성 검토
- `[L1 hit, hits=N]`: 캐시 히트, 50ms 이하
- `highlight:` 라인: FTS5 매치 위치 발췌 (BM25 채널)
