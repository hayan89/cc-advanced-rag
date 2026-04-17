---
description: 인덱스 현재 상태(청크/파일/언어/차원/L1 히트율)를 요약합니다.
---

`index_status` MCP 툴을 호출해 다음을 출력합니다:

- 스키마 버전 / `stored_dimension`
- chunks · files 수
- 언어별 파일 분포
- 마지막 인덱싱 시각
- provider · model · privacyMode
- L1 정확 매치 캐시 엔트리 · 히트 누계

이상 징후가 있으면 `/rag-doctor` 실행을 권장합니다.
