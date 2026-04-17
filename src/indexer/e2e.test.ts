import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { runIndex } from "./index.ts";
import { defaultConfig } from "../config/defaults.ts";
import { openClient } from "../db/client.ts";
import { hybridSearch } from "../search/hybrid.ts";
import { lookupFileHandler } from "../tools/lookup-file.ts";
import { searchSymbolHandler } from "../tools/search-symbol.ts";
import { getRelatedHandler } from "../tools/get-related.ts";
import { indexStatusHandler } from "../tools/index-status.ts";
import type { Embedder } from "./embedder.ts";
import type { ToolContext } from "../tools/context.ts";

let repo: string;

/**
 * Deterministic fake embedder: maps each input to a unit-length vector whose
 * dominant dimension is derived from a simple hash of distinctive keywords.
 * Enough to produce a stable, semantically "nearest" ordering in tests.
 */
function makeFakeEmbedder(dimension: number): Embedder {
  function embedOne(text: string): Float32Array {
    const v = new Float32Array(dimension);
    let hash = 2166136261;
    for (const ch of text) {
      hash ^= ch.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    const slot = Math.abs(hash) % dimension;
    v[slot] = 1.0;
    return v;
  }
  return {
    config: {
      provider: "ollama",
      model: "fake",
      dimension,
      privacyMode: true,
    },
    async embed(texts) {
      return { vectors: texts.map(embedOne), provider: "ollama" };
    },
    async healthCheck() {},
  };
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ccrag-e2e-"));
  execSync("git init -q", { cwd: repo });
  execSync('git config user.email "t@t.test"', { cwd: repo });
  execSync('git config user.name "t"', { cwd: repo });

  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(
    join(repo, "src/handlers.ts"),
    `/** Upload a receipt image and validate its metadata. */
export function uploadReceipt(id: string): boolean {
  return id.length > 0;
}

export class ReceiptService {
  validate(): boolean { return true; }
}
`,
  );
  writeFileSync(
    join(repo, "src/api.ts"),
    `import { apiRequest } from "./client";
/** Fetch receipts from the backend. */
export async function fetchReceipts(): Promise<unknown[]> {
  return apiRequest("/receipts");
}
`,
  );
  writeFileSync(join(repo, "src/client.ts"), `export function apiRequest(p: string) { return p; }`);
  writeFileSync(
    join(repo, ".gitignore"),
    "node_modules/\n.claude/code-rag.db*\n.claude/code-rag.log\n.claude/code-rag.lock\n",
  );

  execSync("git add -A", { cwd: repo });
  execSync('git commit -q -m init', { cwd: repo });
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("end-to-end indexing + query", () => {
  const dimension = 64;

  test("full index populates chunks, files, ledger, chunk_tags", async () => {
    const config = defaultConfig();
    config.embedding.provider = "ollama";
    config.embedding.model = "fake";
    config.embedding.dimension = dimension;
    config.embedding.privacyMode = true;
    config.languages = ["typescript", "tsx"];
    config.tagging.customTags = [{ name: "receipt", regex: "[Rr]eceipt" }];

    const summary = await runIndex({
      projectRoot: repo,
      config,
      mode: "full",
      embedder: makeFakeEmbedder(dimension),
    });

    expect(summary.errors).toEqual([]);
    expect(summary.filesProcessed).toBeGreaterThanOrEqual(3);
    expect(summary.chunksInserted).toBeGreaterThan(0);

    const client = openClient({
      dbPath: join(repo, config.dbPath),
      dimension,
    });
    const nChunks = client.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM chunks`).get()?.n ?? 0;
    const nFiles = client.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM files`).get()?.n ?? 0;
    const nLedger = client.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM index_ledger`).get()?.n ?? 0;
    const nTags = client.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM chunk_tags`).get()?.n ?? 0;

    expect(nChunks).toBeGreaterThan(0);
    expect(nFiles).toBe(3);
    expect(nLedger).toBe(3);
    // receipt custom tag should have attached to handlers.ts + api.ts chunks
    expect(nTags).toBeGreaterThan(0);
    client.close();
  });

  test("tool handlers return expected shapes against indexed DB", async () => {
    const config = defaultConfig();
    config.embedding.provider = "ollama";
    config.embedding.model = "fake";
    config.embedding.dimension = dimension;
    config.embedding.privacyMode = true;
    const client = openClient({ dbPath: join(repo, config.dbPath), dimension });
    const ctx: ToolContext = {
      db: client.db,
      config,
      embedder: makeFakeEmbedder(dimension),
      projectRoot: repo,
    };

    try {
      const lookup = await lookupFileHandler({ filePath: "src/handlers.ts" }, ctx);
      expect(lookup.content[0]?.text).toContain("uploadReceipt");

      const symbols = await searchSymbolHandler({ name: "Receipt" }, ctx);
      expect(symbols.content[0]?.text).toContain("ReceiptService");

      const related = await getRelatedHandler({ filePath: "src/handlers.ts", limit: 5 }, ctx);
      expect(related.content[0]?.text).toContain("src/api.ts");

      const status = await indexStatusHandler({}, ctx);
      const text = status.content[0]?.text ?? "";
      expect(text).toContain("chunks:");
      expect(text).toContain("typescript");
    } finally {
      client.close();
    }
  });

  test("hybridSearch returns at least one result for a seeded query", async () => {
    const config = defaultConfig();
    config.embedding.dimension = dimension;
    const client = openClient({ dbPath: join(repo, config.dbPath), dimension });
    try {
      const { vectors } = await makeFakeEmbedder(dimension).embed(["Upload a receipt"], {
        inputType: "query",
      });
      const results = hybridSearch({
        db: client.db,
        query: "upload receipt",
        queryVector: vectors[0]!,
        limit: 5,
      });
      expect(results.length).toBeGreaterThan(0);
      const paths = results.map((r) => r.filePath);
      expect(paths.some((p) => p.includes("handlers.ts"))).toBe(true);
    } finally {
      client.close();
    }
  });

  test("deletion propagates through classifier + GC", async () => {
    rmSync(join(repo, "src/client.ts"));
    execSync("git add -A", { cwd: repo });
    execSync('git commit -q -m delete', { cwd: repo });

    const config = defaultConfig();
    config.embedding.provider = "ollama";
    config.embedding.model = "fake";
    config.embedding.dimension = dimension;
    config.embedding.privacyMode = true;
    config.languages = ["typescript", "tsx"];

    const summary = await runIndex({
      projectRoot: repo,
      config,
      mode: "incremental",
      embedder: makeFakeEmbedder(dimension),
    });
    expect(summary.filesDeleted).toBeGreaterThanOrEqual(1);

    const client = openClient({ dbPath: join(repo, config.dbPath), dimension });
    const leftover = client.db
      .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM chunks WHERE file_path = ?`)
      .get("src/client.ts");
    expect(leftover?.n ?? 0).toBe(0);
    client.close();
  });
});
