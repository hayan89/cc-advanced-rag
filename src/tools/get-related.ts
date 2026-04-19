import { textResult, type ToolContext, type ToolResult } from "./context.ts";

export const getRelatedToolDef = {
  name: "get_related",
  description:
    "주어진 파일 또는 청크와 태그가 겹치는 관련 청크들을 반환합니다. " +
    "크로스-스택 연관 탐색(예: 백엔드 핸들러 → 프런트엔드 API 호출)에 유용. " +
    "`resource:*` 태그는 가중치 기반으로 상위 정렬되어 백엔드-프런트 파일을 우선 매칭합니다. " +
    "`resourceOnly: true`면 `resource:*` 태그만으로 엄격 매칭.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "기준 파일 경로 (선택)" },
      chunkId: { type: "number", description: "기준 청크 ID (선택, filePath보다 우선)" },
      limit: { type: "number", description: "최대 결과 수 (기본 20, 최대 100)" },
      resourceOnly: {
        type: "boolean",
        description:
          "true면 `resource:*` 태그만으로 매칭 (cross-stack 전용 엄격 모드).",
      },
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
  score: number;
}

export async function getRelatedHandler(
  args: { filePath?: string; chunkId?: number; limit?: number; resourceOnly?: boolean },
  ctx: ToolContext,
): Promise<ToolResult> {
  const limit = Math.min(args.limit ?? 20, 100);
  const resourceOnly = args.resourceOnly === true;

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

  // Strict mode: only consider resource:* tags on both sides.
  if (resourceOnly) {
    refTags = refTags.filter((t) => t.startsWith("resource:"));
    if (refTags.length === 0) {
      return textResult(
        `[no resource tags on reference ${refFilePath ?? args.chunkId}]\n` +
          `resourceOnly=true 모드이지만 참조 파일/청크에 resource:* 태그가 없습니다. ` +
          `인덱스에 resource 태그가 생성되려면 config의 tagging.resourceExtractor.enabled=true 및 재인덱싱이 필요합니다.`,
      );
    }
  }

  // 2) Find chunks sharing the most tag-weight (exclude reference file)
  const placeholders = refTags.map(() => "?").join(",");
  const params: Array<string | number> = [...refTags];
  let excludeClause = "";
  if (refFilePath) {
    excludeClause = "AND c.file_path != ?";
    params.push(refFilePath);
  }
  params.push(limit);

  // `resourceOnly` additionally filters the candidate side to resource:* tags.
  const tagFilter = resourceOnly ? `AND ct.tag LIKE 'resource:%'` : "";

  const sql = `
    SELECT c.id, c.file_path, c.language, c.chunk_type, c.symbol_name,
           c.start_line, c.end_line, SUM(ct.weight) AS score
      FROM chunk_tags ct
      JOIN chunks c ON c.id = ct.chunk_id
     WHERE ct.tag IN (${placeholders})
       ${tagFilter}
       ${excludeClause}
     GROUP BY c.id
     ORDER BY score DESC, c.file_path, c.start_line
     LIMIT ?
  `;

  const rows = ctx.db.query<RelatedRow, typeof params>(sql).all(...params);

  if (rows.length === 0) {
    return textResult(`[no related chunks; reference_tags=${refTags.join(",")}]`);
  }

  const lines = [`[${rows.length} related chunks] reference_tags=${refTags.join(",")}`];
  for (const r of rows) {
    lines.push(
      `${r.file_path}:${r.start_line}-${r.end_line} [${r.chunk_type}:${r.symbol_name ?? "anon"}] (${r.language}) score=${r.score}`,
    );
  }
  return textResult(lines.join("\n"));
}
