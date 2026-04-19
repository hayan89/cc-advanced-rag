import type { Database } from "bun:sqlite";
import { distanceToCosineSimilarity } from "../search/distance.ts";

/**
 * L2 semantic cache.
 *
 * Matches previous queries by embedding proximity (cosine similarity ≥
 * threshold) under the same git HEAD / mode / scope / limit. Relies on
 * `semantic_cache` (metadata + result JSON) + `semantic_cache_vec` (vec0
 * virtual table, dimension-dependent, created in client.ensureVecTable).
 *
 * Vectors stored here are L2-normalized (caller guarantees via
 * `normalizeL2` in src/indexer/embedder.ts), so sqlite-vec's L2 distance is
 * convertible to cosine similarity via `distanceToCosineSimilarity`.
 */

export interface SemanticCacheKey {
  queryVector: Float32Array;
  queryText: string;
  scope?: string;
  mode: "hybrid" | "semantic";
  limit: number;
  gitHeadSha: string;
}

export interface SemanticCacheHit<T = unknown> {
  result: T;
  similarity: number;
  hitCount: number;
}

// sqlite-vec MATCH returns the top-k rows *before* WHERE filters are applied.
// We over-fetch with a large k and then let the JOIN + WHERE filter down so
// that mode/scope/HEAD mismatches don't eat the first k slots.
const KNN_OVER_FETCH = 50;

export function getCachedSemantic<T = unknown>(
  db: Database,
  key: SemanticCacheKey,
  similarityThreshold: number,
): SemanticCacheHit<T> | null {
  const vecBytes = toBytes(key.queryVector);
  const scope = key.scope ?? null;

  const row = db
    .query<
      { id: number; result_json: string; hit_count: number; distance: number },
      [Uint8Array, number, string, string, number, string | null, number]
    >(
      `SELECT sc.id, sc.result_json, sc.hit_count, scv.distance
         FROM semantic_cache_vec scv
         JOIN semantic_cache sc ON sc.id = scv.rowid
        WHERE scv.embedding MATCH ?
          AND scv.k = ?
          AND sc.git_head_sha = ?
          AND sc.mode = ?
          AND sc.limit_n = ?
          AND sc.scope IS ?
          AND sc.expires_at > ?
        ORDER BY scv.distance ASC
        LIMIT 1`,
    )
    .get(vecBytes, KNN_OVER_FETCH, key.gitHeadSha, key.mode, key.limit, scope, unixNow());

  if (!row) return null;

  const similarity = distanceToCosineSimilarity(row.distance);
  if (similarity < similarityThreshold) return null;

  db.query(`UPDATE semantic_cache SET hit_count = hit_count + 1 WHERE id = ?`).run(row.id);

  return {
    result: JSON.parse(row.result_json) as T,
    similarity,
    hitCount: row.hit_count + 1,
  };
}

export function setCachedSemantic(
  db: Database,
  key: SemanticCacheKey,
  result: unknown,
  ttlHours: number,
  maxEntries?: number,
): void {
  const expiresAt = unixNow() + ttlHours * 3600;
  const scope = key.scope ?? null;

  const inserted = db
    .query<
      { id: number },
      [string, string, string, string | null, string, number, number]
    >(
      `INSERT INTO semantic_cache
         (query_text, result_json, git_head_sha, scope, mode, limit_n, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      key.queryText,
      JSON.stringify(result),
      key.gitHeadSha,
      scope,
      key.mode,
      key.limit,
      expiresAt,
    );

  if (!inserted) return;

  const vecBytes = toBytes(key.queryVector);
  db.query(`INSERT INTO semantic_cache_vec (rowid, embedding) VALUES (?, ?)`).run(
    inserted.id,
    vecBytes,
  );

  if (maxEntries && maxEntries > 0) enforceMaxEntries(db, maxEntries);
}

/** Drop cache entries for any prior git HEAD (vec rows deleted in lockstep). */
export function invalidateSemanticForGitHead(db: Database, currentSha: string): number {
  const ids = db
    .query<{ id: number }, [string]>(`SELECT id FROM semantic_cache WHERE git_head_sha != ?`)
    .all(currentSha)
    .map((r) => r.id);
  return deleteByIds(db, ids);
}

/** Expire sweep. */
export function purgeSemanticExpired(db: Database): number {
  const ids = db
    .query<{ id: number }, [number]>(`SELECT id FROM semantic_cache WHERE expires_at < ?`)
    .all(unixNow())
    .map((r) => r.id);
  return deleteByIds(db, ids);
}

/** Full wipe — used on dimension mismatch / schema rebuilds. */
export function purgeAllSemantic(db: Database): number {
  const count = db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM semantic_cache`)
    .get()?.n ?? 0;
  db.query(`DELETE FROM semantic_cache_vec`).run();
  db.query(`DELETE FROM semantic_cache`).run();
  return count;
}

export interface SemanticCacheStats {
  entries: number;
  hitTotal: number;
  expired: number;
}

export function getSemanticCacheStats(db: Database): SemanticCacheStats {
  const now = unixNow();
  const row = db
    .query<{ entries: number; hits: number; expired: number }, [number]>(
      `SELECT COUNT(*) AS entries,
              COALESCE(SUM(hit_count), 0) AS hits,
              SUM(CASE WHEN expires_at < ? THEN 1 ELSE 0 END) AS expired
         FROM semantic_cache`,
    )
    .get(now);
  return {
    entries: row?.entries ?? 0,
    hitTotal: row?.hits ?? 0,
    expired: row?.expired ?? 0,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function deleteByIds(db: Database, ids: number[]): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(",");
  db.query(`DELETE FROM semantic_cache_vec WHERE rowid IN (${placeholders})`).run(...ids);
  db.query(`DELETE FROM semantic_cache WHERE id IN (${placeholders})`).run(...ids);
  return ids.length;
}

/**
 * Keep the table bounded. Evict least-recently-hit entries (lowest hit_count,
 * then oldest created_at) until entries ≤ maxEntries. Cheaper than a strict
 * LRU table and good enough for a cache.
 */
function enforceMaxEntries(db: Database, maxEntries: number): void {
  const count = db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM semantic_cache`)
    .get()?.n ?? 0;
  if (count <= maxEntries) return;

  const overflow = count - maxEntries;
  const victims = db
    .query<{ id: number }, [number]>(
      `SELECT id FROM semantic_cache
        ORDER BY hit_count ASC, created_at ASC
        LIMIT ?`,
    )
    .all(overflow)
    .map((r) => r.id);
  deleteByIds(db, victims);
}

function toBytes(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}
