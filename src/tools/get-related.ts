import { textResult, type ToolContext, type ToolResult } from "./context.ts";

export const getRelatedToolDef = {
  name: "get_related",
  description:
    "주어진 파일 또는 청크와 태그가 겹치는 관련 청크들을 반환합니다. " +
    "크로스-스택 연관 탐색(예: 백엔드 핸들러 → 프런트엔드 API 호출)에 유용.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "기준 파일 경로 (선택)" },
      chunkId: { type: "number", description: "기준 청크 ID (선택, filePath보다 우선)" },
      limit: { type: "number", description: "최대 결과 수 (기본 20, 최대 100)" },
    },
  },
} as const;

interface RelatedRow {
  id: number;
  file_path: string;
  language: string;
  chunk_type: string;
  symbol_name: string | null;
  start_line: number;
  end_line: number;
  overlap: number;
}

export async function getRelatedHandler(
  args: { filePath?: string; chunkId?: number; limit?: number },
  ctx: ToolContext,
): Promise<ToolResult> {
  const limit = Math.min(args.limit ?? 20, 100);

  // 1) Determine reference tags
  let refTags: string[] = [];
  let refFilePath: string | null = null;
  if (args.chunkId !== undefined) {
    const tags = ctx.db
      .query<{ tag: string }, [number]>(`SELECT tag FROM chunk_tags WHERE chunk_id = ?`)
      .all(args.chunkId)
      .map((r) => r.tag);
    refTags = tags;
    const fileRow = ctx.db
      .query<{ file_path: string }, [number]>(`SELECT file_path FROM chunks WHERE id = ?`)
      .get(args.chunkId);
    refFilePath = fileRow?.file_path ?? null;
  } else if (args.filePath) {
    refFilePath = args.filePath;
    refTags = ctx.db
      .query<{ tag: string }, [string]>(
        `SELECT DISTINCT ct.tag
           FROM chunk_tags ct JOIN chunks c ON c.id = ct.chunk_id
          WHERE c.file_path = ?`,
      )
      .all(args.filePath)
      .map((r) => r.tag);
  } else {
    return textResult("[error] filePath 또는 chunkId 중 하나를 지정해야 합니다.");
  }

  if (refTags.length === 0) {
    return textResult(
      `[no tags found for reference ${refFilePath ?? args.chunkId}]\n` +
        `get_related는 chunk_tags 정규화 테이블을 사용합니다. 인덱싱이 완료됐는지 확인하세요.`,
    );
  }

  // 2) Find chunks sharing the most tags (exclude reference file)
  const placeholders = refTags.map(() => "?").join(",");
  const params: Array<string | number> = [...refTags];
  let excludeClause = "";
  if (refFilePath) {
    excludeClause = "AND c.file_path != ?";
    params.push(refFilePath);
  }
  params.push(limit);

  const sql = `
    SELECT c.id, c.file_path, c.language, c.chunk_type, c.symbol_name,
           c.start_line, c.end_line, COUNT(ct.tag) AS overlap
      FROM chunk_tags ct
      JOIN chunks c ON c.id = ct.chunk_id
     WHERE ct.tag IN (${placeholders})
       ${excludeClause}
     GROUP BY c.id
     ORDER BY overlap DESC, c.file_path, c.start_line
     LIMIT ?
  `;

  const rows = ctx.db.query<RelatedRow, typeof params>(sql).all(...params);

  if (rows.length === 0) {
    return textResult(`[no related chunks; reference tags=${refTags.join(",")}]`);
  }

  const lines = [`[${rows.length} related chunks] reference_tags=${refTags.join(",")}`];
  for (const r of rows) {
    lines.push(
      `${r.file_path}:${r.start_line}-${r.end_line} [${r.chunk_type}:${r.symbol_name ?? "anon"}] (${r.language}) overlap=${r.overlap}`,
    );
  }
  return textResult(lines.join("\n"));
}
