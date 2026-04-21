/**
 * SQL dialect 감지.
 *
 * 1. 확장자/경로 힌트(강)
 * 2. 내용 sniffing(중) — postgres/mysql/sqlite/mssql 마커 빈도 점수화
 * 3. fallback → "ansi"
 * 4. statement 단위 재판정: 파일 전체가 ansi여도 개별 statement에 강한 마커가 있으면
 *    그 statement만 해당 dialect로 승격
 */

export type SqlDialect = "postgres" | "mysql" | "sqlite" | "mssql" | "ansi";

/** 파일 전체와 statement 개별 dialect 판정 결과. */
export interface DialectResolution {
  file: SqlDialect;
  /** 각 statement 텍스트 길이에 1:1 대응. statement index 기반. */
  perStatement: SqlDialect[];
}

/** 경로/확장자 힌트. 미감지 시 null. */
export function dialectFromPath(filePath: string): SqlDialect | null {
  const lower = filePath.toLowerCase();

  // 확장자 힌트
  if (lower.endsWith(".pgsql") || lower.endsWith(".plpgsql")) return "postgres";
  if (lower.endsWith(".mysql")) return "mysql";

  // 경로 세그먼트 힌트
  const segments = lower.split("/");
  if (segments.includes("postgres") || segments.includes("pg") || segments.includes("postgresql")) {
    return "postgres";
  }
  if (segments.includes("mysql") || segments.includes("mariadb")) return "mysql";
  if (segments.includes("sqlite")) return "sqlite";
  if (segments.includes("mssql") || segments.includes("tsql") || segments.includes("sqlserver")) {
    return "mssql";
  }
  return null;
}

/**
 * 각 dialect의 마커 카탈로그. `as const readonly`로 고정되어 mutable state 없음.
 *
 * 스코어: 더 강한 식별 마커는 가중치 2, 약한 마커는 1.
 */
const POSTGRES_MARKERS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\$[A-Za-z_]*\$/g, 2], // dollar-quote 태그
  [/\bLANGUAGE\s+plpgsql\b/gi, 3],
  [/\bCREATE\s+EXTENSION\b/gi, 2],
  [/\bJSONB\b/gi, 2],
  [/\bRETURNING\b/gi, 1],
  [/\bSERIAL\b|\bBIGSERIAL\b/gi, 1],
  [/\bUSING\s+(gin|gist|brin)\b/gi, 2],
  [/\bILIKE\b/gi, 1],
] as const;

const MYSQL_MARKERS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\bENGINE\s*=\s*[A-Za-z]+/gi, 3],
  [/\bAUTO_INCREMENT\b/gi, 3],
  [/\bUNSIGNED\b/gi, 1],
  [/\bCHARACTER\s+SET\b/gi, 1],
  [/\bCOLLATE\s*=/gi, 2],
  [/\bON\s+UPDATE\s+CURRENT_TIMESTAMP\b/gi, 3],
  [/\bDELIMITER\s+\S+/gi, 3],
  // NOTE: backtick 식별자는 코멘트 내부에도 자주 등장해 오탐 유발. 제외.
] as const;

const SQLITE_MARKERS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\bAUTOINCREMENT\b/gi, 3], // MySQL의 AUTO_INCREMENT와 구분
  [/\bWITHOUT\s+ROWID\b/gi, 3],
  [/\)\s*STRICT\b/gi, 3],
  [/^\s*PRAGMA\s+/gim, 2],
] as const;

const MSSQL_MARKERS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\bIDENTITY\s*\(\s*\d+\s*,\s*\d+\s*\)/gi, 3],
  [/\bNVARCHAR\b/gi, 2],
  [/^\s*GO\s*$/gm, 3], // GO batch separator
  [/@@[A-Za-z_]+/g, 2],
  [/\bUSE\s+\[/gi, 2],
  // NOTE: [bracket] 식별자는 Markdown/코멘트와 충돌. identifier-as-feature용은 features.ts에서만 사용.
] as const;

function scoreByCatalog(
  text: string,
  catalog: ReadonlyArray<readonly [RegExp, number]>,
): number {
  let score = 0;
  for (const [rx, weight] of catalog) {
    const matches = text.match(rx);
    if (matches) score += matches.length * weight;
  }
  return score;
}

/** 내용 sniffing만 수행. 점수 동률이면 null (→ ansi로 폴백됨). */
export function dialectFromContent(text: string): SqlDialect | null {
  if (text.length === 0) return null;
  const scores: Array<readonly [SqlDialect, number]> = [
    ["postgres", scoreByCatalog(text, POSTGRES_MARKERS)],
    ["mysql", scoreByCatalog(text, MYSQL_MARKERS)],
    ["sqlite", scoreByCatalog(text, SQLITE_MARKERS)],
    ["mssql", scoreByCatalog(text, MSSQL_MARKERS)],
  ];
  let best: SqlDialect | null = null;
  let bestScore = 0;
  for (const [d, s] of scores) {
    if (s > bestScore) {
      best = d;
      bestScore = s;
    } else if (s === bestScore && best !== null) {
      // 동점 → 단일 승자 없음. best null로 초기화해 ansi로 폴백.
      best = null;
    }
  }
  // 최소 스코어 임계치: 1 이상이어야 확정
  return bestScore >= 1 ? best : null;
}

/**
 * 파일 단위 + statement 단위 dialect 판정.
 * - 파일 전체 dialect가 확정되면 각 statement는 기본적으로 그 dialect.
 * - 개별 statement에 더 강한 타 dialect 마커가 있으면 해당 statement만 승격.
 */
export function resolveDialect(
  filePath: string,
  fullText: string,
  statements: ReadonlyArray<{ text: string }>,
): DialectResolution {
  const pathHint = dialectFromPath(filePath);
  const contentHint = dialectFromContent(fullText);
  const file: SqlDialect = pathHint ?? contentHint ?? "ansi";

  const perStatement: SqlDialect[] = statements.map((s) => {
    const stmtDialect = dialectFromContent(s.text);
    // 파일 dialect와 다르고, statement 단위에서 확정됐다면 승격
    if (stmtDialect !== null && stmtDialect !== file) return stmtDialect;
    return file;
  });

  return { file, perStatement };
}
