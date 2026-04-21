import type { CodeChunk, FileMetadata, LanguageParser, ParseResult } from "./types.ts";
import {
  computeSignatureHash,
  deriveBaseTags,
  extractSqlComment,
  hashSource,
  splitLongChunk,
} from "./common.ts";

/** statement 텍스트의 선행 `-- line` 블록을 docComment로 추출. */
function leadingStatementDoc(text: string): string | null {
  const lines = text.split("\n");
  const collected: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("--")) {
      collected.push(t.slice(2).replace(/^\s/, ""));
      continue;
    }
    if (t === "") {
      if (collected.length > 0) break;
      continue;
    }
    break;
  }
  return collected.length > 0 ? collected.join("\n") : null;
}
import { tokenizeSql } from "./sql/tokenizer.ts";
import { resolveDialect } from "./sql/dialect.ts";
import { classifyStatement } from "./sql/statements.ts";
import { extractFeatureTags } from "./sql/features.ts";

/**
 * SQL regex-based parser.
 *
 * 계약:
 * - 빈 입력(source="") → throw 금지, 빈 chunks + 유효 metadata 반환.
 * - 함수/카탈로그는 모두 module-level readonly, 인스턴스 상태 없음.
 */
async function parse(filePath: string, source: string): Promise<ParseResult> {
  const fileHash = hashSource(source);
  const lineCount = source.length === 0 ? 1 : source.split("\n").length;

  if (source.length === 0) {
    return {
      chunks: [],
      metadata: {
        filePath,
        fileHash,
        language: "sql",
        lineCount,
        chunkCount: 0,
        imports: [],
        symbols: [],
      },
      signatureHash: computeSignatureHash([]),
    };
  }

  // 1차 토큰화 (GO 분리 미확정 상태로). dialect 감지 후 필요 시 재토큰화.
  const firstPass = tokenizeSql(source, { enableGoSeparator: false });

  // 파일/문장 단위 dialect 판정
  const preliminary = resolveDialect(filePath, source, firstPass.statements);

  // MSSQL 감지되면 GO 경계 재해석으로 재토큰화
  const needMssqlReparse = preliminary.file === "mssql" && firstPass.sawGoBatch;
  const tokenized = needMssqlReparse
    ? tokenizeSql(source, { enableGoSeparator: true })
    : firstPass;

  const dialect = needMssqlReparse
    ? resolveDialect(filePath, source, tokenized.statements)
    : preliminary;

  const chunks: CodeChunk[] = [];
  const symbols: FileMetadata["symbols"] = [];
  const fileImports = new Set<string>();
  const signatureParts: string[] = [];

  for (let idx = 0; idx < tokenized.statements.length; idx++) {
    const stmt = tokenized.statements[idx]!;
    const classified = classifyStatement(stmt.text);
    if (!classified) continue;

    const stmtDialect = dialect.perStatement[idx] ?? dialect.file;
    const featureTags = extractFeatureTags(stmtDialect, stmt.text);

    for (const imp of classified.imports) fileImports.add(imp);
    if (classified.symbolName) {
      symbols.push({
        name: classified.symbolName,
        kind: classified.chunkType,
        line: stmt.startLine,
      });
      signatureParts.push(
        `${classified.chunkType}:${classified.symbolName}:${classified.signature}`,
      );
    }

    const docComment =
      extractSqlComment(source, stmt.startLine) ?? leadingStatementDoc(stmt.text);

    const tags = new Set<string>(deriveBaseTags(filePath, classified.chunkType));
    tags.add(`dialect:${stmtDialect}`);
    for (const t of featureTags) tags.add(t);

    const chunk: CodeChunk = {
      filePath,
      chunkType: classified.chunkType,
      symbolName: classified.symbolName,
      receiverType: classified.receiverType,
      signature: classified.signature,
      packageName: classified.packageName,
      language: "sql",
      startLine: stmt.startLine,
      endLine: stmt.endLine,
      content: stmt.text,
      docComment,
      imports: classified.imports,
      tags: Array.from(tags),
    };
    chunks.push(...splitLongChunk(chunk));
  }

  return {
    chunks,
    metadata: {
      filePath,
      fileHash,
      language: "sql",
      lineCount,
      chunkCount: chunks.length,
      imports: Array.from(fileImports),
      symbols,
    },
    signatureHash: computeSignatureHash(signatureParts),
  };
}

export const sqlParser: LanguageParser = { language: "sql", parse };
