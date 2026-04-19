import type { Database } from "bun:sqlite";
import { distanceToCosineSimilarity } from "./distance.ts";
import { DEFAULT_LIMIT, type SearchOptions, type SearchResult } from "./types.ts";

type Binding = string | number | bigint | boolean | null | Uint8Array;
type Bindings = Binding[];

export interface SemanticSearchInput extends SearchOptions {
  db: Database;
  queryVector: Float32Array;
}

/**
 * Pure vector similarity search using sqlite-vec's vec0 table.
 * Returns up to `limit` chunks ordered by cosine distance (ascending = better).
 */
export function semanticSearch(input: SemanticSearchInput): SearchResult[] {
  const { db, queryVector, scope, limit = DEFAULT_LIMIT } = input;

  const k = Math.max(limit, 1);
  const vecBytes = new Uint8Array(queryVector.buffer, queryVector.byteOffset, queryVector.byteLength);

  const scopeClause = scope ? `AND c.scope = ?` : "";
  const sql = `
    SELECT c.id,
           c.file_path,
           c.symbol_name,
           c.chunk_type,
           c.signature,
           c.content,
           c.start_line,
           c.end_line,
           c.scope,
           v.distance
      FROM chunks_vec v
      JOIN chunks c ON c.id = v.rowid
     WHERE v.embedding MATCH ?
       AND k = ?
       ${scopeClause}
     ORDER BY v.distance
     LIMIT ?
  `;

  const params: Bindings = [vecBytes, k];
  if (scope) params.push(scope);
  params.push(limit);

  const rows = db
    .query<
      {
        id: number;
        file_path: string;
        symbol_name: string | null;
        chunk_type: string;
        signature: string | null;
        content: string;
        start_line: number;
        end_line: number;
        scope: string | null;
        distance: number;
      },
      Bindings
    >(sql)
    .all(...params);

  return rows.map((row) => ({
    filePath: row.file_path,
    symbolName: row.symbol_name,
    chunkType: row.chunk_type,
    signature: row.signature,
    snippet: truncateSnippet(row.content),
    highlight: null,
    score: distanceToCosineSimilarity(row.distance),
    startLine: row.start_line,
    endLine: row.end_line,
    scope: row.scope,
  }));
}

export function truncateSnippet(content: string, maxLines = 30): string {
  const lines = content.split("\n");
  if (lines.length <= maxLines) return content;
  return lines.slice(0, maxLines).join("\n") + "\n// ...(truncated)";
}
