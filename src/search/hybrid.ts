import type { Database } from "bun:sqlite";
import { buildFtsQuery } from "./fts-query.ts";
import { truncateSnippet } from "./semantic.ts";
import { DEFAULT_LIMIT, type SearchOptions, type SearchResult } from "./types.ts";

type Binding = string | number | bigint | boolean | null | Uint8Array;
type Bindings = Binding[];

const RRF_K = 60;
const FETCH_PER_CHANNEL = 20;

export interface HybridSearchInput extends SearchOptions {
  db: Database;
  query: string;
  queryVector: Float32Array;
}

interface RankEntry {
  id: number;
  rank: number;
  /** Channel-specific raw score (vec = cosine similarity, bm = -bm25). */
  score: number;
}

/**
 * Hybrid search: dense vectors + BM25, fused with Reciprocal Rank Fusion.
 *
 * Runs two independent top-K queries (vector / FTS5) and combines in the
 * application layer — much simpler than a single SQL CTE, and avoids
 * edge cases where one channel returns zero results.
 */
export function hybridSearch(input: HybridSearchInput): SearchResult[] {
  const { db, query, queryVector, scope, limit = DEFAULT_LIMIT } = input;

  const vecRanks = runVectorChannel(db, queryVector, scope);
  const bmRanks = runBm25Channel(db, query, scope);

  // RRF fusion: sum of 1/(k + rank) across channels.
  const fused = new Map<number, { rrf: number; vec?: number; bm?: number }>();
  for (const e of vecRanks) {
    const entry = fused.get(e.id) ?? { rrf: 0 };
    entry.rrf += 1 / (RRF_K + e.rank);
    entry.vec = e.score;
    fused.set(e.id, entry);
  }
  for (const e of bmRanks) {
    const entry = fused.get(e.id) ?? { rrf: 0 };
    entry.rrf += 1 / (RRF_K + e.rank);
    entry.bm = e.score;
    fused.set(e.id, entry);
  }

  const ranked = [...fused.entries()]
    .sort((a, b) => b[1].rrf - a[1].rrf)
    .slice(0, limit);

  if (ranked.length === 0) return [];

  return hydrateResults(db, ranked, query);
}

function runVectorChannel(
  db: Database,
  queryVector: Float32Array,
  scope: string | undefined,
): RankEntry[] {
  const vecBytes = new Uint8Array(queryVector.buffer, queryVector.byteOffset, queryVector.byteLength);
  const scopeClause = scope ? `AND c.scope = ?` : "";
  const sql = `
    SELECT v.rowid AS id, v.distance
      FROM chunks_vec v
      JOIN chunks c ON c.id = v.rowid
     WHERE v.embedding MATCH ?
       AND k = ?
       ${scopeClause}
     ORDER BY v.distance
  `;
  const params: Bindings = [vecBytes, FETCH_PER_CHANNEL];
  if (scope) params.push(scope);

  const rows = db
    .query<{ id: number; distance: number }, Bindings>(sql)
    .all(...params);

  return rows.map((r, idx) => ({
    id: r.id,
    rank: idx + 1,
    score: 1 - r.distance,
  }));
}

function runBm25Channel(
  db: Database,
  query: string,
  scope: string | undefined,
): RankEntry[] {
  const ftsExpr = buildFtsQuery(query);
  if (!ftsExpr) return [];

  const scopeClause = scope ? `AND c.scope = ?` : "";
  const sql = `
    SELECT f.rowid AS id, f.rank AS bm_rank
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.rowid
     WHERE chunks_fts MATCH ?
       ${scopeClause}
     ORDER BY f.rank
     LIMIT ?
  `;
  const params: Bindings = [ftsExpr];
  if (scope) params.push(scope);
  params.push(FETCH_PER_CHANNEL);

  const rows = db
    .query<{ id: number; bm_rank: number }, Bindings>(sql)
    .all(...params);

  return rows.map((r, idx) => ({
    id: r.id,
    rank: idx + 1,
    // bm_rank is negative (FTS5 convention); larger magnitude = better match.
    score: -r.bm_rank,
  }));
}

function hydrateResults(
  db: Database,
  ranked: [number, { rrf: number; vec?: number; bm?: number }][],
  query: string,
): SearchResult[] {
  const ids = ranked.map(([id]) => id);
  const placeholders = ids.map(() => "?").join(",");

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
      },
      Bindings
    >(
      `SELECT id, file_path, symbol_name, chunk_type, signature, content,
              start_line, end_line, scope
         FROM chunks
        WHERE id IN (${placeholders})`,
    )
    .all(...ids);

  const byId = new Map(rows.map((r) => [r.id, r]));

  // Attach FTS5 snippet excerpts. `snippet()` needs a MATCH query, so we run
  // a dedicated small query for the matched rows.
  const ftsExpr = buildFtsQuery(query);
  const highlights = ftsExpr ? fetchHighlights(db, ids, ftsExpr) : new Map<number, string>();

  return ranked
    .map(([id, meta]) => {
      const row = byId.get(id);
      if (!row) return null;
      return {
        filePath: row.file_path,
        symbolName: row.symbol_name,
        chunkType: row.chunk_type,
        signature: row.signature,
        snippet: truncateSnippet(row.content),
        highlight: highlights.get(id) ?? null,
        score: meta.rrf,
        startLine: row.start_line,
        endLine: row.end_line,
        scope: row.scope,
      } satisfies SearchResult;
    })
    .filter((r): r is SearchResult => r !== null);
}

function fetchHighlights(
  db: Database,
  ids: number[],
  ftsExpr: string,
): Map<number, string> {
  const placeholders = ids.map(() => "?").join(",");
  // snippet(table, colIndex, start, end, ellipsis, maxTokens)
  // col 2 = content in chunks_fts
  const sql = `
    SELECT rowid AS id,
           snippet(chunks_fts, 2, '<<', '>>', '…', 16) AS highlight
      FROM chunks_fts
     WHERE chunks_fts MATCH ?
       AND rowid IN (${placeholders})
  `;
  const params: Bindings = [ftsExpr, ...ids];
  const rows = db.query<{ id: number; highlight: string | null }, Bindings>(sql).all(...params);
  return new Map(rows.filter((r) => r.highlight).map((r) => [r.id, r.highlight!]));
}

export const RRF_CONSTANTS = { RRF_K, FETCH_PER_CHANNEL } as const;
