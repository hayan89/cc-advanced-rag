/**
 * SQL statement classifier.
 *
 * 각 statement 텍스트의 첫 토큰들을 대소문자 무시로 매칭해
 * `{ chunkType, symbolName, packageName, receiverType, signature, imports }`를 추출한다.
 *
 * 모든 regex는 anchored (`^`) 선형 패턴. 본문 스캔은 단일 패스.
 */

import type { ChunkType } from "../types.ts";

export interface ClassifiedStatement {
  chunkType: ChunkType;
  symbolName: string | null;
  /** schema-qualified name의 schema 부분 (예: `public.users` → `public`) */
  packageName: string | null;
  /** 부모 객체. ALTER/INDEX/TRIGGER가 참조하는 테이블 이름 */
  receiverType: string | null;
  signature: string;
  imports: string[];
}

/** 한 줄 요약 signature: 공백 1개 정규화 + 개행 제거. */
function normalizeSignature(text: string): string {
  const firstLine = text.split("\n")[0] ?? text;
  return firstLine.replace(/\s+/g, " ").trim();
}

/** `"schema"."table"` / `` `s`.`t` `` / `[s].[t]` / `s.t` → { schema, name } */
function parseQualifiedName(raw: string): { schema: string | null; name: string } {
  // backtick/bracket/double-quote 제거 (최대한 선형)
  const stripped = raw.replace(/[`"[\]]/g, "");
  const parts = stripped.split(".");
  if (parts.length === 1) return { schema: null, name: parts[0]!.trim() };
  return {
    schema: parts[0]!.trim() || null,
    name: parts.slice(1).join(".").trim(),
  };
}

/**
 * REFERENCES / ON <table> 등에서 언급되는 테이블 이름들을 imports로 수집.
 * 단순 regex 스캔 (모두 anchored 단어 경계).
 */
function collectImports(text: string, selfName: string | null): string[] {
  const out = new Set<string>();
  // FK: REFERENCES <qname>
  const fkRegex = /\bREFERENCES\s+([A-Za-z_`"[][\w`"[\]."]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = fkRegex.exec(text)) !== null) {
    const { name } = parseQualifiedName(m[1]!);
    if (name && name !== selfName) out.add(name);
  }
  // JOIN / FROM (뷰, MV 본문에서)
  const joinRegex = /\b(?:JOIN|FROM)\s+([A-Za-z_`"[][\w`"[\]."]*)/gi;
  while ((m = joinRegex.exec(text)) !== null) {
    const { name } = parseQualifiedName(m[1]!);
    if (name && name !== selfName && name.length > 0) out.add(name);
  }
  return Array.from(out);
}

/** qname 토큰 (식별자 혹은 schema.name). 공백/괄호 전까지. */
const QNAME = "([A-Za-z_`\"\\[][\\w`\"\\[\\].]*)";

const PATTERNS: Array<{
  rx: RegExp;
  handler: (m: RegExpExecArray, fullText: string) => ClassifiedStatement | null;
}> = [
  // CREATE TABLE
  {
    rx: new RegExp(
      `^\\s*CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:GLOBAL\\s+|LOCAL\\s+)?(?:TEMP(?:ORARY)?\\s+|UNLOGGED\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${QNAME}`,
      "i",
    ),
    handler: (m, text) => {
      const { schema, name } = parseQualifiedName(m[1]!);
      return {
        chunkType: "struct",
        symbolName: name,
        packageName: schema,
        receiverType: null,
        signature: normalizeSignature(text),
        imports: collectImports(text, name),
      };
    },
  },
  // CREATE MATERIALIZED VIEW (앞에 먼저 매칭돼야 함)
  {
    rx: new RegExp(
      `^\\s*CREATE\\s+(?:OR\\s+REPLACE\\s+)?MATERIALIZED\\s+VIEW\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${QNAME}`,
      "i",
    ),
    handler: (m, text) => {
      const { schema, name } = parseQualifiedName(m[1]!);
      return {
        chunkType: "type",
        symbolName: name,
        packageName: schema,
        receiverType: null,
        signature: normalizeSignature(text),
        imports: collectImports(text, name),
      };
    },
  },
  // CREATE VIEW
  {
    rx: new RegExp(
      `^\\s*CREATE\\s+(?:OR\\s+REPLACE\\s+)?VIEW\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${QNAME}`,
      "i",
    ),
    handler: (m, text) => {
      const { schema, name } = parseQualifiedName(m[1]!);
      return {
        chunkType: "type",
        symbolName: name,
        packageName: schema,
        receiverType: null,
        signature: normalizeSignature(text),
        imports: collectImports(text, name),
      };
    },
  },
  // CREATE FUNCTION
  {
    rx: new RegExp(`^\\s*CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${QNAME}`, "i"),
    handler: (m, text) => {
      const { schema, name } = parseQualifiedName(m[1]!);
      return {
        chunkType: "function",
        symbolName: name,
        packageName: schema,
        receiverType: null,
        signature: normalizeSignature(text),
        imports: collectImports(text, name),
      };
    },
  },
  // CREATE PROCEDURE
  {
    rx: new RegExp(`^\\s*CREATE\\s+(?:OR\\s+REPLACE\\s+)?PROCEDURE\\s+${QNAME}`, "i"),
    handler: (m, text) => {
      const { schema, name } = parseQualifiedName(m[1]!);
      return {
        chunkType: "function",
        symbolName: name,
        packageName: schema,
        receiverType: null,
        signature: normalizeSignature(text),
        imports: collectImports(text, name),
      };
    },
  },
  // CREATE [UNIQUE] INDEX name ON table
  {
    rx: new RegExp(
      `^\\s*CREATE\\s+(?:UNIQUE\\s+)?(?:CLUSTERED\\s+|NONCLUSTERED\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${QNAME}\\s+ON\\s+${QNAME}`,
      "i",
    ),
    handler: (m, text) => {
      const { schema, name } = parseQualifiedName(m[1]!);
      const target = parseQualifiedName(m[2]!).name;
      return {
        chunkType: "const",
        symbolName: name,
        packageName: schema,
        receiverType: target,
        signature: normalizeSignature(text),
        imports: [target].filter((x) => x.length > 0),
      };
    },
  },
  // CREATE TRIGGER name ... ON table
  {
    rx: new RegExp(
      `^\\s*CREATE\\s+(?:OR\\s+REPLACE\\s+)?TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${QNAME}[\\s\\S]*?\\bON\\s+${QNAME}`,
      "i",
    ),
    handler: (m, text) => {
      const { schema, name } = parseQualifiedName(m[1]!);
      const target = parseQualifiedName(m[2]!).name;
      return {
        chunkType: "method",
        symbolName: name,
        packageName: schema,
        receiverType: target,
        signature: normalizeSignature(text),
        imports: [target].filter((x) => x.length > 0),
      };
    },
  },
  // CREATE TYPE
  {
    rx: new RegExp(`^\\s*CREATE\\s+(?:OR\\s+REPLACE\\s+)?TYPE\\s+${QNAME}`, "i"),
    handler: (m, text) => {
      const { schema, name } = parseQualifiedName(m[1]!);
      return {
        chunkType: "type",
        symbolName: name,
        packageName: schema,
        receiverType: null,
        signature: normalizeSignature(text),
        imports: [],
      };
    },
  },
  // CREATE SCHEMA
  {
    rx: new RegExp(`^\\s*CREATE\\s+SCHEMA\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${QNAME}`, "i"),
    handler: (m, text) => {
      const { name } = parseQualifiedName(m[1]!);
      return {
        chunkType: "module",
        symbolName: name,
        packageName: null,
        receiverType: null,
        signature: normalizeSignature(text),
        imports: [],
      };
    },
  },
  // CREATE SEQUENCE
  {
    rx: new RegExp(
      `^\\s*CREATE\\s+SEQUENCE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${QNAME}`,
      "i",
    ),
    handler: (m, text) => {
      const { schema, name } = parseQualifiedName(m[1]!);
      return {
        chunkType: "const",
        symbolName: name,
        packageName: schema,
        receiverType: null,
        signature: normalizeSignature(text),
        imports: [],
      };
    },
  },
  // ALTER TABLE
  {
    rx: new RegExp(`^\\s*ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${QNAME}`, "i"),
    handler: (m, text) => {
      const { schema, name } = parseQualifiedName(m[1]!);
      return {
        chunkType: "method",
        symbolName: name,
        packageName: schema,
        receiverType: "alter",
        signature: normalizeSignature(text),
        imports: collectImports(text, name),
      };
    },
  },
  // DROP TABLE|VIEW|INDEX|FUNCTION|PROCEDURE|TYPE|SCHEMA|SEQUENCE|TRIGGER
  {
    rx: new RegExp(
      `^\\s*DROP\\s+(?:TABLE|VIEW|INDEX|FUNCTION|PROCEDURE|TYPE|SCHEMA|SEQUENCE|TRIGGER)\\s+(?:IF\\s+EXISTS\\s+)?${QNAME}`,
      "i",
    ),
    handler: (m, text) => {
      const { schema, name } = parseQualifiedName(m[1]!);
      return {
        chunkType: "const",
        symbolName: name,
        packageName: schema,
        receiverType: "drop",
        signature: normalizeSignature(text),
        imports: [],
      };
    },
  },
  // COMMENT ON X <name>
  {
    rx: new RegExp(
      `^\\s*COMMENT\\s+ON\\s+(?:TABLE|COLUMN|VIEW|INDEX|FUNCTION|TYPE|SCHEMA|SEQUENCE|TRIGGER)\\s+${QNAME}`,
      "i",
    ),
    handler: (m, text) => {
      const { schema, name } = parseQualifiedName(m[1]!);
      return {
        chunkType: "const",
        symbolName: name,
        packageName: schema,
        receiverType: "comment",
        signature: normalizeSignature(text),
        imports: [],
      };
    },
  },
  // GRANT / REVOKE ... ON <name>
  {
    rx: new RegExp(`^\\s*(?:GRANT|REVOKE)\\s+[\\s\\S]*?\\bON\\s+${QNAME}`, "i"),
    handler: (m, text) => {
      const { schema, name } = parseQualifiedName(m[1]!);
      return {
        chunkType: "const",
        symbolName: name,
        packageName: schema,
        receiverType: "grant",
        signature: normalizeSignature(text),
        imports: [],
      };
    },
  },
];

/**
 * statement 시작부의 주석·공백을 제거한 offset을 반환.
 * tokenizer가 statement 본문과 선행 주석을 함께 slice하므로,
 * classifier는 여기서부터 매칭한다.
 */
function skipLeadingCommentsAndWs(text: string): string {
  let i = 0;
  const len = text.length;
  while (i < len) {
    const c = text.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
      i++;
      continue;
    }
    // -- line comment
    if (c === 0x2d && i + 1 < len && text.charCodeAt(i + 1) === 0x2d) {
      const nl = text.indexOf("\n", i + 2);
      if (nl === -1) return "";
      i = nl + 1;
      continue;
    }
    // /* block comment */ (중첩 허용)
    if (c === 0x2f && i + 1 < len && text.charCodeAt(i + 1) === 0x2a) {
      let depth = 1;
      i += 2;
      while (i < len && depth > 0) {
        const cc = text.charCodeAt(i);
        if (cc === 0x2f && i + 1 < len && text.charCodeAt(i + 1) === 0x2a) {
          depth++;
          i += 2;
          continue;
        }
        if (cc === 0x2a && i + 1 < len && text.charCodeAt(i + 1) === 0x2f) {
          depth--;
          i += 2;
          continue;
        }
        i++;
      }
      continue;
    }
    break;
  }
  return text.slice(i);
}

/**
 * statement 텍스트를 classify. 어떤 패턴에도 매칭되지 않으면 null 반환
 * (indexer는 이를 무시).
 */
export function classifyStatement(text: string): ClassifiedStatement | null {
  const head = skipLeadingCommentsAndWs(text);
  if (head.length === 0) return null;
  for (const pat of PATTERNS) {
    const m = pat.rx.exec(head);
    if (m) return pat.handler(m, text);
  }
  return null;
}
