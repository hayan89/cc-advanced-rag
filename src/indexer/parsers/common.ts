import crypto from "node:crypto";
import type { CodeChunk } from "./types.ts";

export const MAX_CHUNK_LINES = 512;

export function hashSource(source: string): string {
  return crypto.createHash("sha256").update(source).digest("hex");
}

/**
 * signature_hash는 주석·공백·라인 위치를 제거한 심볼 시그니처만 해싱해
 * 의미 없는 diff(포맷팅·주석)로 재임베딩이 발생하지 않게 한다.
 */
export function computeSignatureHash(parts: string[]): string {
  const normalized = parts
    .map((p) =>
      p
        .replace(/\s+/g, " ")
        // 구문적 구분자 주변 공백 제거 → `( n: number )` ≡ `(n: number)`
        .replace(/\s*([(){}\[\],:;<>])\s*/g, "$1")
        .trim(),
    )
    .filter((p) => p.length > 0)
    .sort();
  return crypto.createHash("sha256").update(normalized.join("\n")).digest("hex");
}

/**
 * Per-chunk signature hash: derived from stable, whitespace-insensitive
 * identity fields. Used by the incremental indexer to detect whether a chunk
 * must be re-embedded.
 */
export function computeChunkSignatureHash(chunk: CodeChunk): string {
  return computeSignatureHash([
    chunk.chunkType,
    chunk.receiverType ?? "",
    chunk.symbolName ?? "",
    chunk.signature ?? "",
  ]);
}

/** SQL `--` 단일-라인 연속 주석을 역추적 수집. */
export function extractSqlComment(
  source: string,
  startLine1Based: number,
): string | null {
  if (startLine1Based <= 1) return null;
  const lines = source.split("\n");
  const collected: string[] = [];
  for (let i = startLine1Based - 2; i >= 0; i--) {
    const line = lines[i]?.trim() ?? "";
    if (line.startsWith("--")) {
      collected.unshift(line.slice(2).replace(/^\s/, ""));
    } else if (line === "") {
      break;
    } else {
      break;
    }
  }
  return collected.length > 0 ? collected.join("\n") : null;
}

/** C 계열(//, #) 단일-라인 연속 주석을 역추적 수집. */
export function extractLineComment(
  source: string,
  startLine1Based: number,
  prefix: "//" | "#",
): string | null {
  if (startLine1Based <= 1) return null;
  const lines = source.split("\n");
  const collected: string[] = [];
  for (let i = startLine1Based - 2; i >= 0; i--) {
    const line = lines[i]?.trim() ?? "";
    if (line.startsWith(prefix)) {
      collected.unshift(line.slice(prefix.length).replace(/^\s/, ""));
    } else if (line === "") {
      break;
    } else {
      break;
    }
  }
  return collected.length > 0 ? collected.join("\n") : null;
}

/** C/Java/JS 계열 블록 주석(JSDoc 포함)을 역추적 수집. 없으면 단일-라인으로 폴백. */
export function extractDocCommentCStyle(
  source: string,
  startLine1Based: number,
): string | null {
  if (startLine1Based <= 1) return null;
  const lines = source.split("\n");
  let i = startLine1Based - 2;
  if (i >= 0 && lines[i]?.trim().endsWith("*/")) {
    const collected: string[] = [];
    while (i >= 0) {
      const line = lines[i];
      if (line === undefined) break;
      collected.unshift(line);
      if (line.trim().startsWith("/**") || line.trim().startsWith("/*")) break;
      i--;
    }
    const joined = collected.join("\n").replace(/^\s*\*?\s?/gm, "").trim();
    return joined || null;
  }
  return extractLineComment(source, startLine1Based, "//");
}

/** Python-style docstring 또는 # 주석 역추적. */
export function extractDocCommentPython(
  source: string,
  startLine1Based: number,
  bodyNodeText: string | null,
): string | null {
  // 1) 함수/클래스 본문 첫 statement가 string literal이면 docstring으로 간주
  if (bodyNodeText) {
    const trimmed = bodyNodeText.trim();
    const m = trimmed.match(/^("""[\s\S]*?"""|'''[\s\S]*?'''|"[^"]*"|'[^']*')/);
    if (m?.[1]) {
      return m[1].replace(/^("""|''')|("""|''')$/g, "").trim() || null;
    }
  }
  return extractLineComment(source, startLine1Based, "#");
}

export function splitLongChunk(chunk: CodeChunk, maxLines = MAX_CHUNK_LINES): CodeChunk[] {
  const lines = chunk.content.split("\n");
  if (lines.length <= maxLines) return [chunk];

  const parts: CodeChunk[] = [];
  for (let i = 0; i < lines.length; i += maxLines) {
    const segment = lines.slice(i, i + maxLines);
    parts.push({
      ...chunk,
      content: segment.join("\n"),
      startLine: chunk.startLine + i,
      endLine: chunk.startLine + i + segment.length - 1,
      symbolName: chunk.symbolName
        ? `${chunk.symbolName}#part${Math.floor(i / maxLines) + 1}`
        : null,
    });
  }
  return parts;
}

/**
 * 파일 경로에서 가장 얕은 디렉터리 이름들을 태그로 추가한다.
 * 언어-중립 기본 태그 (handlers, services, routes, components 등)를 균일하게 뽑아
 * Step 7의 config 기반 `customTags`와 합성된다.
 */
export function deriveBaseTags(filePath: string, chunkType: string): string[] {
  const tags = new Set<string>([chunkType]);
  const parts = filePath.split("/");
  const buckets = [
    "handlers",
    "services",
    "models",
    "repository",
    "middleware",
    "worker",
    "routes",
    "components",
    "hooks",
    "lib",
    "api",
    "controllers",
    "utils",
    "helpers",
    "store",
    "stores",
  ];
  for (const part of parts) {
    if (buckets.includes(part)) tags.add(part);
  }
  return Array.from(tags);
}
