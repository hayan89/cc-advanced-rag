import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openClient, type Client } from "../db/client.ts";
import { normalizeL2 } from "../indexer/embedder.ts";
import {
  getCachedSemantic,
  setCachedSemantic,
  invalidateSemanticForGitHead,
  purgeAllSemantic,
  purgeSemanticExpired,
  getSemanticCacheStats,
} from "./l2-semantic.ts";

const DIMENSION = 32;

function vec(seed: Array<[number, number]>): Float32Array {
  const v = new Float32Array(DIMENSION);
  for (const [i, x] of seed) v[i] = x;
  return normalizeL2(v);
}

function addNoise(v: Float32Array, epsilon: number): Float32Array {
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! + (i % 2 === 0 ? epsilon : -epsilon);
  return normalizeL2(out);
}

let tmpDir: string;
let client: Client;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ccrag-l2-test-"));
  client = openClient({ dbPath: join(tmpDir, "test.db"), dimension: DIMENSION });
});

afterEach(() => {
  client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("L2 semantic cache", () => {
  test("exact vector lookup hits with similarity ~1", () => {
    const v = vec([[0, 1]]);
    setCachedSemantic(
      client.db,
      { queryVector: v, queryText: "q", mode: "hybrid", limit: 10, gitHeadSha: "sha1" },
      [{ filePath: "a.ts" }],
      24,
    );
    const hit = getCachedSemantic<{ filePath: string }[]>(
      client.db,
      { queryVector: v, queryText: "q", mode: "hybrid", limit: 10, gitHeadSha: "sha1" },
      0.95,
    );
    expect(hit).not.toBeNull();
    expect(hit!.similarity).toBeGreaterThan(0.999);
    expect(hit!.result[0]!.filePath).toBe("a.ts");
    expect(hit!.hitCount).toBe(1);
  });

  test("nearby vector hits under threshold 0.95", () => {
    const v = vec([[0, 1]]);
    setCachedSemantic(
      client.db,
      { queryVector: v, queryText: "q", mode: "hybrid", limit: 10, gitHeadSha: "sha1" },
      [{ id: 1 }],
      24,
    );
    const near = addNoise(v, 0.05);
    const hit = getCachedSemantic(
      client.db,
      { queryVector: near, queryText: "q2", mode: "hybrid", limit: 10, gitHeadSha: "sha1" },
      0.95,
    );
    expect(hit).not.toBeNull();
    expect(hit!.similarity).toBeGreaterThan(0.95);
  });

  test("far vector misses under threshold", () => {
    setCachedSemantic(
      client.db,
      { queryVector: vec([[0, 1]]), queryText: "q", mode: "hybrid", limit: 10, gitHeadSha: "sha1" },
      [],
      24,
    );
    const other = vec([[15, 1]]); // orthogonal dimension
    const hit = getCachedSemantic(
      client.db,
      { queryVector: other, queryText: "q", mode: "hybrid", limit: 10, gitHeadSha: "sha1" },
      0.95,
    );
    expect(hit).toBeNull();
  });

  test("different git HEAD → miss, ancestor invalidation works", () => {
    const v = vec([[0, 1]]);
    setCachedSemantic(
      client.db,
      { queryVector: v, queryText: "q", mode: "hybrid", limit: 10, gitHeadSha: "old" },
      [],
      24,
    );
    // Same query, different HEAD
    const miss = getCachedSemantic(
      client.db,
      { queryVector: v, queryText: "q", mode: "hybrid", limit: 10, gitHeadSha: "new" },
      0.95,
    );
    expect(miss).toBeNull();

    const removed = invalidateSemanticForGitHead(client.db, "new");
    expect(removed).toBe(1);
    expect(getSemanticCacheStats(client.db).entries).toBe(0);
  });

  test("k=50 over-fetch surfaces HEAD-matching entry past nearer wrong-HEAD entries", () => {
    // Saturate cache with many near vectors under a stale HEAD, then a
    // slightly-further entry under the live HEAD.
    const target = vec([[0, 1]]);
    for (let i = 0; i < 10; i++) {
      setCachedSemantic(
        client.db,
        {
          queryVector: addNoise(target, 0.001 * (i + 1)),
          queryText: `stale${i}`,
          mode: "hybrid",
          limit: 10,
          gitHeadSha: "stale",
        },
        [{ stale: true }],
        24,
      );
    }
    setCachedSemantic(
      client.db,
      {
        queryVector: addNoise(target, 0.05),
        queryText: "live",
        mode: "hybrid",
        limit: 10,
        gitHeadSha: "live",
      },
      [{ live: true }],
      24,
    );
    const hit = getCachedSemantic<Array<{ live?: boolean; stale?: boolean }>>(
      client.db,
      { queryVector: target, queryText: "probe", mode: "hybrid", limit: 10, gitHeadSha: "live" },
      0.95,
    );
    expect(hit).not.toBeNull();
    expect(hit!.result[0]!.live).toBe(true);
  });

  test("scope IS ? with null bound matches scope-less entry", () => {
    const v = vec([[0, 1]]);
    setCachedSemantic(
      client.db,
      { queryVector: v, queryText: "q", mode: "hybrid", limit: 10, gitHeadSha: "s" },
      [{ ok: 1 }],
      24,
    );
    const hit = getCachedSemantic(
      client.db,
      {
        queryVector: v,
        queryText: "q",
        mode: "hybrid",
        limit: 10,
        gitHeadSha: "s",
        scope: undefined,
      },
      0.95,
    );
    expect(hit).not.toBeNull();
  });

  test("purgeAllSemantic wipes both tables", () => {
    setCachedSemantic(
      client.db,
      { queryVector: vec([[0, 1]]), queryText: "a", mode: "hybrid", limit: 10, gitHeadSha: "s" },
      [],
      24,
    );
    setCachedSemantic(
      client.db,
      { queryVector: vec([[1, 1]]), queryText: "b", mode: "hybrid", limit: 10, gitHeadSha: "s" },
      [],
      24,
    );
    expect(getSemanticCacheStats(client.db).entries).toBe(2);
    const removed = purgeAllSemantic(client.db);
    expect(removed).toBe(2);
    expect(getSemanticCacheStats(client.db).entries).toBe(0);
    const vecCount = client.db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM semantic_cache_vec`)
      .get();
    expect(vecCount?.n).toBe(0);
  });

  test("purgeSemanticExpired removes stale rows only", () => {
    setCachedSemantic(
      client.db,
      { queryVector: vec([[0, 1]]), queryText: "live", mode: "hybrid", limit: 10, gitHeadSha: "s" },
      [],
      24,
    );
    // Insert one with expires_at in the past.
    const past = Math.floor(Date.now() / 1000) - 10;
    client.db
      .query(
        `UPDATE semantic_cache SET expires_at = ? WHERE query_text = 'live'`,
      )
      .run(past);
    setCachedSemantic(
      client.db,
      { queryVector: vec([[1, 1]]), queryText: "fresh", mode: "hybrid", limit: 10, gitHeadSha: "s" },
      [],
      24,
    );
    const removed = purgeSemanticExpired(client.db);
    expect(removed).toBe(1);
    expect(getSemanticCacheStats(client.db).entries).toBe(1);
  });
});
