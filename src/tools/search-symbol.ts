import { textResult, type ToolContext, type ToolResult } from "./context.ts";

export const searchSymbolToolDef = {
  name: "search_symbol",
  description:
    "심볼 이름(함수·클래스·타입 등) 기반 정확/부분 매칭 검색. " +
    "리팩토링 대상 식별, 같은 이름의 구현체 모두 찾기 등에 사용.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "심볼 이름 (또는 부분)" },
      exact: { type: "boolean", description: "정확 매칭 여부 (기본 false = LIKE)" },
      language: { type: "string", description: "언어 필터 (선택)" },
      limit: { type: "number", description: "최대 결과 수 (기본 20, 최대 100)" },
    },
    required: ["name"],
  },
} as const;

interface Row {
  id: number;
  file_path: string;
  language: string;
  chunk_type: string;
  symbol_name: string | null;
  signature: string | null;
  start_line: number;
  end_line: number;
}

export async function searchSymbolHandler(
  args: { name: string; exact?: boolean; language?: string; limit?: number },
  ctx: ToolContext,
): Promise<ToolResult> {
  const limit = Math.min(args.limit ?? 20, 100);
  const params: Array<string | number> = [];
  const where: string[] = [];

  if (args.exact) {
    where.push("symbol_name = ?");
    params.push(args.name);
  } else {
    where.push("symbol_name LIKE ?");
    params.push(`%${args.name}%`);
  }
  if (args.language) {
    where.push("language = ?");
    params.push(args.language);
  }

  const sql = `
    SELECT id, file_path, language, chunk_type, symbol_name, signature, start_line, end_line
      FROM chunks
     WHERE ${where.join(" AND ")}
     ORDER BY file_path, start_line
     LIMIT ?
  `;
  params.push(limit);

  const rows = ctx.db.query<Row, typeof params>(sql).all(...params);

  if (rows.length === 0) {
    return textResult(`[no symbols matching '${args.name}']`);
  }

  const lines = [`[${rows.length} symbols matching '${args.name}']`];
  for (const r of rows) {
    lines.push(
      `${r.file_path}:${r.start_line}-${r.end_line} [${r.chunk_type}:${r.symbol_name ?? "anon"}] (${r.language})` +
        (r.signature ? `\n  ${r.signature}` : ""),
    );
  }
  return textResult(lines.join("\n"));
}
