import { hybridSearch } from "../search/hybrid.ts";
import { semanticSearch } from "../search/semantic.ts";
import { getCached, setCached } from "../cache/l1-exact.ts";
import { getCachedSemantic, setCachedSemantic } from "../cache/l2-semantic.ts";
import { getGitHeadSha } from "../indexer/ledger.ts";
import type { SearchResult } from "../search/types.ts";
import { textResult, type ToolContext, type ToolResult } from "./context.ts";

export const searchCodeToolDef = {
  name: "search_code",
  description:
    "코드베이스에서 의미 기반으로 코드를 검색합니다. " +
    "기본은 하이브리드(벡터 cosine + FTS5 BM25 + RRF 융합). " +
    "반환 결과는 파일/라인/심볼/시그니처/스니펫/하이라이트. Read/Grep보다 먼저 사용.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "자연어 또는 키워드 검색 쿼리" },
      limit: { type: "number", description: "반환 결과 수 (기본 10, 최대 50)" },
      scope: { type: "string", description: "chunks.scope 필터 (선택)" },
      mode: {
        type: "string",
        enum: ["hybrid", "semantic"],
        description: "검색 모드 (기본 hybrid)",
      },
    },
    required: ["query"],
  },
} as const;

export async function searchCodeHandler(
  args: { query: string; limit?: number; scope?: string; mode?: "hybrid" | "semantic" },
  ctx: ToolContext,
): Promise<ToolResult> {
  const limit = Math.min(args.limit ?? 10, 50);
  const mode = args.mode ?? "hybrid";
  let gitHeadSha: string;
  try {
    gitHeadSha = getGitHeadSha(ctx.projectRoot);
  } catch {
    gitHeadSha = "no-git";
  }

  const scope = args.scope ?? undefined;
  const cacheKey = {
    query: `${mode}::${args.query}`,
    scope,
    limit,
    gitHeadSha,
  };
  const cached = getCached<SearchResult[]>(ctx.db, cacheKey);
  if (cached) {
    return textResult(formatResults(cached.result, `[L1 hit, hits=${cached.hitCount}, mode=${mode}]`));
  }

  const { vectors } = await ctx.embedder.embed([args.query], { inputType: "query" });
  const vec = vectors[0];
  if (!vec) return textResult("[no embedding produced]");

  const l2Enabled = ctx.config.cache.l2Enabled;
  if (l2Enabled) {
    const l2Hit = getCachedSemantic<SearchResult[]>(
      ctx.db,
      { queryVector: vec, queryText: args.query, scope, mode, limit, gitHeadSha },
      ctx.config.cache.l2SimilarityThreshold,
    );
    if (l2Hit) {
      // Populate L1 so the exact query hits faster next time.
      setCached(ctx.db, cacheKey, l2Hit.result, ctx.config.cache.l1TtlHours);
      return textResult(
        formatResults(
          l2Hit.result,
          `[L2 hit, sim=${l2Hit.similarity.toFixed(3)}, hits=${l2Hit.hitCount}, mode=${mode}]`,
        ),
      );
    }
  }

  const results =
    mode === "semantic"
      ? semanticSearch({ db: ctx.db, queryVector: vec, scope, limit })
      : hybridSearch({ db: ctx.db, query: args.query, queryVector: vec, scope, limit });

  if (l2Enabled) {
    setCachedSemantic(
      ctx.db,
      { queryVector: vec, queryText: args.query, scope, mode, limit, gitHeadSha },
      results,
      ctx.config.cache.l2TtlHours,
      ctx.config.cache.l2MaxEntries,
    );
  }
  setCached(ctx.db, cacheKey, results, ctx.config.cache.l1TtlHours);
  return textResult(formatResults(results, `[${results.length} results, mode=${mode}]`));
}

function formatResults(results: SearchResult[], header: string): string {
  if (results.length === 0) return `${header}\n(관련 결과 없음)`;

  const sorted = [...results].sort((a, b) => {
    if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
    return (a.startLine ?? 0) - (b.startLine ?? 0);
  });

  const byFile = new Map<string, SearchResult[]>();
  for (const r of sorted) {
    const arr = byFile.get(r.filePath) ?? [];
    arr.push(r);
    byFile.set(r.filePath, arr);
  }

  const lines: string[] = [
    header,
    `## Summary`,
    `- total: ${sorted.length} results across ${byFile.size} files`,
    ``,
    `## Results (grouped by file)`,
  ];

  for (const [filePath, chunks] of byFile) {
    lines.push(``, `### ${filePath}`);
    for (const r of chunks) {
      const score = typeof r.score === "number" ? r.score.toFixed(3) : "?";
      lines.push(
        `\n${r.filePath}:${r.startLine}-${r.endLine} [${r.chunkType}:${r.symbolName ?? "anon"}] (score=${score})`,
      );
      if (r.signature) lines.push(r.signature);
      if (r.highlight) lines.push(`highlight: ${r.highlight}`);
      lines.push(r.snippet);
    }
  }
  return lines.join("\n");
}
