import { textResult, type ToolContext, type ToolResult } from "./context.ts";

export const lookupFileToolDef = {
  name: "lookup_file",
  description:
    "특정 파일의 인덱싱된 모든 청크를 반환합니다. " +
    "파일 수정 전 구조 파악, 변경 영향 범위 확인에 사용.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "조회할 파일 경로 (레포 루트 기준 상대 경로)" },
      limit: { type: "number", description: "최대 청크 수 (기본 100)" },
    },
    required: ["filePath"],
  },
} as const;

interface Row {
  id: number;
  chunk_type: string;
  symbol_name: string | null;
  signature: string | null;
  language: string;
  start_line: number;
  end_line: number;
  content: string;
  tags_json: string | null;
}

export async function lookupFileHandler(
  args: { filePath: string; limit?: number },
  ctx: ToolContext,
): Promise<ToolResult> {
  const limit = Math.min(args.limit ?? 100, 500);

  const chunks = ctx.db
    .query<Row, [string, number]>(
      `SELECT id, chunk_type, symbol_name, signature, language, start_line, end_line, content, tags_json
         FROM chunks
        WHERE file_path = ?
        ORDER BY start_line
        LIMIT ?`,
    )
    .all(args.filePath, limit);

  if (chunks.length === 0) {
    return textResult(`[not indexed] ${args.filePath}\n이 파일은 아직 인덱싱되지 않았습니다.`);
  }

  const fileRow = ctx.db
    .query<
      { language: string; line_count: number; chunk_count: number; symbols_json: string | null },
      [string]
    >(`SELECT language, line_count, chunk_count, symbols_json FROM files WHERE file_path = ?`)
    .get(args.filePath);

  const lines: string[] = [
    `# ${args.filePath}`,
    fileRow
      ? `language=${fileRow.language}, lines=${fileRow.line_count}, chunks=${fileRow.chunk_count}`
      : `chunks=${chunks.length}`,
    ``,
  ];

  for (const c of chunks) {
    lines.push(
      `## ${c.chunk_type}:${c.symbol_name ?? "anon"} (L${c.start_line}-${c.end_line})`,
    );
    if (c.signature) lines.push(c.signature);
    lines.push(c.content);
    lines.push("");
  }

  return textResult(lines.join("\n"));
}
