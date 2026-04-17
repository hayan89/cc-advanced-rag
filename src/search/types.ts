// Shared types for the search layer. Kept isolated so test fixtures don't
// need to import bun:sqlite.

export interface SearchResult {
  filePath: string;
  symbolName: string | null;
  chunkType: string;
  signature: string | null;
  snippet: string;
  /** FTS5 `snippet()` excerpt showing matched line(s). Only populated for hybrid search. */
  highlight: string | null;
  score: number;
  startLine: number;
  endLine: number;
  scope: string | null;
}

export interface SearchOptions {
  /** Scope name to filter by (matches `chunks.scope`). Omit to search across all scopes. */
  scope?: string;
  limit?: number;
}

export const MAX_QUERY_LENGTH = 500;
export const DEFAULT_LIMIT = 10;
