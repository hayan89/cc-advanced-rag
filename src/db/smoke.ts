// Smoke test for the DB layer: schema apply, sqlite-vec load, FTS5 wiring,
// vector insert/search, and integrity_check.
//
// Run with: bun run src/db/smoke.ts [dbPath]

import { openClient } from "./client.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  const providedPath = process.argv[2];
  const tmp = providedPath ? null : mkdtempSync(join(tmpdir(), "ccrag-smoke-"));
  const dbPath = providedPath ?? join(tmp!, "smoke.db");

  console.log(`[smoke] Opening DB at ${dbPath}`);
  const client = openClient({ dbPath, dimension: 1024 });

  try {
    const { db } = client;

    // Verify sqlite-vec is loaded by querying vec_version()
    const versionRow = db.query<{ v: string }, []>(`SELECT vec_version() AS v`).get();
    console.log(`[smoke] sqlite-vec version: ${versionRow?.v}`);

    // Insert a chunk
    const insertChunk = db.query<
      { id: number },
      [string, string, string, string, string, string, string, string, number, number, string]
    >(`
      INSERT INTO chunks (file_path, file_hash, chunk_type, symbol_name, signature, package_name, language, scope, start_line, end_line, content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `);
    const row = insertChunk.get(
      "src/foo.ts",
      "sha-123",
      "function",
      "greet",
      "function greet(name: string): string",
      "main",
      "typescript",
      "backend",
      10,
      15,
      "function greet(name: string): string {\n  return `Hello, ${name}`;\n}",
    );
    const chunkId = row!.id;
    console.log(`[smoke] Inserted chunk id=${chunkId}`);

    // Insert its vector embedding (synthetic: all 0.01s with a 1 at position 0)
    const embedding = new Float32Array(1024);
    embedding[0] = 1.0;
    for (let i = 1; i < 1024; i++) embedding[i] = 0.01;

    db.query(`INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)`).run(
      chunkId,
      new Uint8Array(embedding.buffer),
    );

    // Vector search — should return the just-inserted chunk
    const vecRows = db
      .query<{ rowid: number; distance: number }, [Uint8Array]>(
        `SELECT rowid, distance FROM chunks_vec WHERE embedding MATCH ? AND k = 5 ORDER BY distance`,
      )
      .all(new Uint8Array(embedding.buffer));
    console.log(`[smoke] Vector search results: ${vecRows.length} row(s), closest rowid=${vecRows[0]?.rowid}`);

    // FTS5 search — should find "greet"
    const ftsRows = db.query<{ id: number }, [string]>(`SELECT rowid AS id FROM chunks_fts WHERE chunks_fts MATCH ?`).all("greet");
    console.log(`[smoke] FTS5 search results: ${ftsRows.length} row(s)`);

    // Integrity check
    const integrity = client.integrityCheck();
    console.log(`[smoke] integrity_check: ok=${integrity.ok} messages=${JSON.stringify(integrity.messages)}`);

    // Delete trigger test: removing the chunk should also remove from chunks_vec
    db.query(`DELETE FROM chunks WHERE id = ?`).run(chunkId);
    const remaining = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM chunks_vec`).get();
    console.log(`[smoke] chunks_vec after delete: ${remaining?.n} row(s)`);

    if (vecRows.length === 0) throw new Error("Vector search returned no results");
    if (ftsRows.length === 0) throw new Error("FTS5 search returned no results");
    if (!integrity.ok) throw new Error("Integrity check failed");
    if ((remaining?.n ?? -1) !== 0) throw new Error("Delete trigger did not propagate to chunks_vec");

    console.log("[smoke] ✅ All DB layer checks passed");
  } finally {
    client.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("[smoke] ❌ Failed:", err);
  process.exit(1);
});
