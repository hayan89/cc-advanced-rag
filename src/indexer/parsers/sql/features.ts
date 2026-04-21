/**
 * SQL feature 태그 추출.
 *
 * dialect별 고정 readonly 카탈로그에서 statement body에 매치되는 마커를
 * `sql-feature:<slug>` 태그로 방출한다. chunk 당 최대 MAX_TAGS_PER_CHUNK개.
 *
 * 모든 regex는 anchored 혹은 경계 단어 매칭으로 선형 시간.
 */

import type { SqlDialect } from "./dialect.ts";

const MAX_TAGS_PER_CHUNK = 8;

type FeatureCatalog = ReadonlyArray<readonly [RegExp, string]>;

const POSTGRES_FEATURES: FeatureCatalog = [
  [/\$[A-Za-z_]*\$/, "sql-feature:dollar-quoted"],
  [/\bLANGUAGE\s+plpgsql\b/i, "sql-feature:plpgsql"],
  [/\bJSONB\b/i, "sql-feature:jsonb"],
  [/\bUUID\b/i, "sql-feature:uuid"],
  [/\b(BIG)?SERIAL\b/i, "sql-feature:serial"],
  [/\bPARTITION\s+BY\b/i, "sql-feature:partition"],
  [/\bCREATE\s+EXTENSION\b/i, "sql-feature:extension"],
  [/\bUSING\s+gin\b/i, "sql-feature:gin-index"],
  [/\bGENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\b/i, "sql-feature:generated-column"],
  [/\bRETURNING\b/i, "sql-feature:returning"],
] as const;

const MYSQL_FEATURES: FeatureCatalog = [
  [/\bENGINE\s*=\s*InnoDB\b/i, "sql-feature:engine-innodb"],
  [/\bENGINE\s*=\s*MyISAM\b/i, "sql-feature:engine-myisam"],
  [/\bAUTO_INCREMENT\b/i, "sql-feature:auto-increment"],
  [/\bUNSIGNED\b/i, "sql-feature:unsigned"],
  [/\bCHARACTER\s+SET\s+utf8mb4\b/i, "sql-feature:charset-utf8mb4"],
  [/\bCOLLATE\s*=?\s*[A-Za-z0-9_]+/i, "sql-feature:collation"],
  [/\bON\s+UPDATE\s+CURRENT_TIMESTAMP\b/i, "sql-feature:on-update-timestamp"],
  [/\bFULLTEXT\s+(INDEX|KEY)\b/i, "sql-feature:fulltext-index"],
] as const;

const SQLITE_FEATURES: FeatureCatalog = [
  [/\bAUTOINCREMENT\b/i, "sql-feature:autoincrement"],
  [/\bWITHOUT\s+ROWID\b/i, "sql-feature:without-rowid"],
  [/\)\s*STRICT\b/i, "sql-feature:strict"],
  [/^\s*PRAGMA\s+/im, "sql-feature:pragma"],
] as const;

const MSSQL_FEATURES: FeatureCatalog = [
  [/\bIDENTITY\s*\(/i, "sql-feature:identity"],
  [/\[[A-Za-z_][^\]\n]*\]/, "sql-feature:bracket-ident"],
  [/\bNVARCHAR\b/i, "sql-feature:nvarchar"],
  [/^\s*GO\s*$/m, "sql-feature:go-batch"],
  [/\bCREATE\s+TABLE\s+#[A-Za-z_]/i, "sql-feature:temp-hash"],
  [/\bCLUSTERED\s+INDEX\b/i, "sql-feature:cluster-index"],
] as const;

/** dialect-agnostic: 모든 dialect에 공통 의미를 가지는 구조 마커. */
const COMMON_FEATURES: FeatureCatalog = [
  [/\bCHECK\s*\(/i, "sql-feature:check"],
  [/\bFOREIGN\s+KEY\b|\bREFERENCES\b/i, "sql-feature:foreign-key"],
  [/\bUNIQUE\b/i, "sql-feature:unique"],
  [/\bCREATE\s+TRIGGER\b/i, "sql-feature:trigger"],
  [/\bCREATE\s+(OR\s+REPLACE\s+)?VIEW\b/i, "sql-feature:view"],
  [/\bCREATE\s+MATERIALIZED\s+VIEW\b/i, "sql-feature:materialized-view"],
] as const;

function catalogsFor(dialect: SqlDialect): FeatureCatalog[] {
  const cats: FeatureCatalog[] = [COMMON_FEATURES];
  switch (dialect) {
    case "postgres":
      cats.push(POSTGRES_FEATURES);
      break;
    case "mysql":
      cats.push(MYSQL_FEATURES);
      break;
    case "sqlite":
      cats.push(SQLITE_FEATURES);
      break;
    case "mssql":
      cats.push(MSSQL_FEATURES);
      break;
    case "ansi":
      // 공통 마커만. vendor-specific 마커가 우연히 매치되는 사례는 제외.
      break;
  }
  return cats;
}

/**
 * statement 본문에서 dialect별 feature 태그를 추출한다. 중복 제거, 최대 8개.
 */
export function extractFeatureTags(dialect: SqlDialect, statementText: string): string[] {
  if (statementText.length === 0) return [];
  const found = new Set<string>();
  for (const catalog of catalogsFor(dialect)) {
    for (const [rx, tag] of catalog) {
      if (found.size >= MAX_TAGS_PER_CHUNK) return Array.from(found);
      if (rx.test(statementText)) found.add(tag);
    }
  }
  return Array.from(found);
}
