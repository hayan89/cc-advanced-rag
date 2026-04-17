import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

const DEFAULT_TTL_HOURS = 24;

export interface CacheKey {
  query: string;
  scope?: string;
  limit?: number;
  gitHeadSha: string;
}

export interface CachedResult<T = unknown> {
  result: T;
  hitCount: number;
}

export function hashKey(key: CacheKey): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        q: key.query,
        s: key.scope ?? "all",
        l: key.limit ?? 10,
      }),
    )
    .digest("hex");
}

/**
 * Look up a cached result. Returns null on miss (or expired / git HEAD drift).
 * Increments hit_count as a side effect on hit.
 */
export function getCached<T = unknown>(db: Database, key: CacheKey): CachedResult<T> | null {
  const queryHash = hashKey(key);
  const row = db
    .query<{ result_json: string; hit_count: number }, [string, string, number]>(
      `SELECT result_json, hit_count
         FROM exact_cache
        WHERE query_hash = ?
          AND git_head_sha = ?
          AND expires_at > ?`,
    )
    .get(queryHash, key.gitHeadSha, unixNow());

  if (!row) return null;

  db.query(`UPDATE exact_cache SET hit_count = hit_count + 1 WHERE query_hash = ?`).run(queryHash);

  return {
    result: JSON.parse(row.result_json) as T,
    hitCount: row.hit_count + 1,
  };
}

export function setCached(
  db: Database,
  key: CacheKey,
  result: unknown,
  ttlHours: number = DEFAULT_TTL_HOURS,
): void {
  const queryHash = hashKey(key);
  const expiresAt = unixNow() + ttlHours * 3600;

  db.query(
    `INSERT INTO exact_cache (query_hash, query_text, result_json, git_head_sha, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(query_hash) DO UPDATE SET
       result_json = excluded.result_json,
       git_head_sha = excluded.git_head_sha,
       expires_at = excluded.expires_at,
       hit_count = exact_cache.hit_count`,
  ).run(queryHash, key.query, JSON.stringify(result), key.gitHeadSha, expiresAt);
}

export function purgeExpired(db: Database): number {
  const res = db.query(`DELETE FROM exact_cache WHERE expires_at < ?`).run(unixNow());
  return Number(res.changes);
}

/** Drop cache entries for any prior git HEAD. */
export function invalidateForGitHead(db: Database, currentGitHeadSha: string): number {
  const res = db.query(`DELETE FROM exact_cache WHERE git_head_sha != ?`).run(currentGitHeadSha);
  return Number(res.changes);
}

/** Cache statistics for /rag-status. */
export interface CacheStats {
  entries: number;
  hitCountTotal: number;
  expiredEntries: number;
}

export function getCacheStats(db: Database): CacheStats {
  const now = unixNow();
  const row = db
    .query<{ entries: number; hits: number; expired: number }, [number]>(
      `SELECT COUNT(*) AS entries,
              COALESCE(SUM(hit_count), 0) AS hits,
              SUM(CASE WHEN expires_at < ? THEN 1 ELSE 0 END) AS expired
         FROM exact_cache`,
    )
    .get(now);
  return {
    entries: row?.entries ?? 0,
    hitCountTotal: row?.hits ?? 0,
    expiredEntries: row?.expired ?? 0,
  };
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}
