import { getCacheStats } from "../cache/l1-exact.ts";
import { textResult, type ToolContext, type ToolResult } from "./context.ts";

export const indexStatusToolDef = {
  name: "index_status",
  description:
    "인덱스 상태 요약: 청크·파일·언어 분포, embedding dimension, 마지막 인덱싱 시각, L1 캐시 히트율, DB 크기.",
  inputSchema: { type: "object", properties: {} },
} as const;

interface Counts {
  total: number;
}
interface LangRow {
  language: string;
  n: number;
}
interface LastRow {
  last: number | null;
}

export async function indexStatusHandler(
  _args: Record<string, never>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const chunksCount = ctx.db.query<Counts, []>(`SELECT COUNT(*) AS total FROM chunks`).get();
  const filesCount = ctx.db.query<Counts, []>(`SELECT COUNT(*) AS total FROM files`).get();
  const langs = ctx.db
    .query<LangRow, []>(
      `SELECT language, COUNT(*) AS n FROM files GROUP BY language ORDER BY n DESC`,
    )
    .all();
  const lastIndexed = ctx.db
    .query<LastRow, []>(`SELECT MAX(last_indexed_at) AS last FROM files`)
    .get();
  const dimensionRow = ctx.db
    .query<{ value: string }, [string]>(`SELECT value FROM meta WHERE key = ?`)
    .get("stored_dimension");
  const schemaRow = ctx.db
    .query<{ v: number }, []>(`SELECT MAX(version) AS v FROM schema_version`)
    .get();

  const cache = getCacheStats(ctx.db);

  const lines = [
    `# Index status`,
    `- schema_version: ${schemaRow?.v ?? "?"}`,
    `- stored_dimension: ${dimensionRow?.value ?? "?"}`,
    `- chunks: ${chunksCount?.total ?? 0}`,
    `- files: ${filesCount?.total ?? 0}`,
    `- last_indexed_at: ${
      lastIndexed?.last ? new Date(lastIndexed.last * 1000).toISOString() : "never"
    }`,
    `- provider: ${ctx.config.embedding.provider} (model=${ctx.config.embedding.model})`,
    `- privacy_mode: ${ctx.config.embedding.privacyMode}`,
    ``,
    `## Languages`,
    ...(langs.length === 0
      ? [`(none — index is empty)`]
      : langs.map((l) => `- ${l.language}: ${l.n} files`)),
    ``,
    `## L1 Cache`,
    `- entries: ${cache.entries} (expired=${cache.expiredEntries})`,
    `- total hits: ${cache.hitCountTotal}`,
  ];
  return textResult(lines.join("\n"));
}
