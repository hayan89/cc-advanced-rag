import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { runIndex } from "./index.ts";
import { defaultConfig } from "../config/defaults.ts";
import { openClient } from "../db/client.ts";
import type { Embedder } from "./embedder.ts";

/**
 * Spy embedder that records each call. Deterministic unit-length outputs so
 * that the indexer can store them without tripping L2 normalization assertions.
 */
interface SpyEmbedder extends Embedder {
  calls: Array<{ count: number; texts: string[] }>;
  totalEmbeddings: number;
  reset(): void;
}

function makeSpyEmbedder(dimension: number): SpyEmbedder {
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
  const e = {
    config: { provider: "ollama" as const, model: "fake", dimension, privacyMode: true },
    calls: [] as Array<{ count: number; texts: string[] }>,
    totalEmbeddings: 0,
    async embed(texts: string[]) {
      e.calls.push({ count: texts.length, texts: [...texts] });
      e.totalEmbeddings += texts.length;
      return { vectors: texts.map(embedOne), provider: "ollama" as const };
    },
    async healthCheck() {},
    reset() {
      e.calls = [];
      e.totalEmbeddings = 0;
    },
  };
  return e;
}

let repo: string;
const DIM = 64;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ccrag-chunk-level-"));
  execSync("git init -q", { cwd: repo });
  execSync('git config user.email "t@t.test"', { cwd: repo });
  execSync('git config user.name "t"', { cwd: repo });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(
    join(repo, "src/lib.ts"),
    `export function alpha(x: number): number { return x + 1; }
export function beta(x: string): string { return x.toUpperCase(); }
export function gamma(): void { console.log("g"); }
`,
  );
  writeFileSync(join(repo, ".gitignore"), ".claude/\n");
  execSync("git add -A", { cwd: repo });
  execSync('git commit -q -m init', { cwd: repo });
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

function buildConfig() {
  const config = defaultConfig();
  config.embedding.provider = "ollama";
  config.embedding.model = "fake";
  config.embedding.dimension = DIM;
  config.embedding.privacyMode = true;
  config.languages = ["typescript"];
  return config;
}

describe("chunk-level incremental re-embedding", () => {
  test("no-op incremental re-embeds zero chunks when file unchanged", async () => {
    const config = buildConfig();
    const spy = makeSpyEmbedder(DIM);

    await runIndex({ projectRoot: repo, config, mode: "full", embedder: spy });
    const initialEmbeds = spy.totalEmbeddings;
    expect(initialEmbeds).toBeGreaterThan(0);

    spy.reset();
    await runIndex({ projectRoot: repo, config, mode: "incremental", embedder: spy });
    expect(spy.totalEmbeddings).toBe(0);
  });

  test("whitespace/comment-only edit triggers zero re-embeddings", async () => {
    const config = buildConfig();
    const spy = makeSpyEmbedder(DIM);
    await runIndex({ projectRoot: repo, config, mode: "full", embedder: spy });

    // Add comments and extra whitespace — signatures unchanged.
    const src = readFileSync(join(repo, "src/lib.ts"), "utf-8");
    writeFileSync(
      join(repo, "src/lib.ts"),
      `// harmless comment\n${src.replace(/\{/g, "{ /* noop */")}`,
    );
    execSync("git add -A", { cwd: repo });
    execSync('git commit -q -m whitespace', { cwd: repo });

    spy.reset();
    await runIndex({ projectRoot: repo, config, mode: "incremental", embedder: spy });
    expect(spy.totalEmbeddings).toBe(0);
  });

  test("changing one function's signature re-embeds only that chunk", async () => {
    const config = buildConfig();
    const spy = makeSpyEmbedder(DIM);
    await runIndex({ projectRoot: repo, config, mode: "full", embedder: spy });

    // Modify only beta's signature.
    writeFileSync(
      join(repo, "src/lib.ts"),
      `export function alpha(x: number): number { return x + 1; }
export function beta(x: string, prefix: string): string { return prefix + x.toUpperCase(); }
export function gamma(): void { console.log("g"); }
`,
    );
    execSync("git add -A", { cwd: repo });
    execSync('git commit -q -m "edit beta"', { cwd: repo });

    spy.reset();
    await runIndex({ projectRoot: repo, config, mode: "incremental", embedder: spy });

    // Exactly one chunk (beta) should need a fresh embedding.
    expect(spy.totalEmbeddings).toBe(1);
    expect(spy.calls[0]!.texts[0]).toContain("beta");
  });
});

describe("ledger chunk_hashes_json", () => {
  test("populated for non-empty files, '[]' for empty files", async () => {
    const repo2 = mkdtempSync(join(tmpdir(), "ccrag-chunk-level-empty-"));
    try {
      execSync("git init -q", { cwd: repo2 });
      execSync('git config user.email "t@t.test"', { cwd: repo2 });
      execSync('git config user.name "t"', { cwd: repo2 });
      mkdirSync(join(repo2, "src"), { recursive: true });
      writeFileSync(join(repo2, "src/empty.ts"), `// only a comment\n`);
      writeFileSync(
        join(repo2, "src/full.ts"),
        `export function f(): number { return 1; }\n`,
      );
      writeFileSync(join(repo2, ".gitignore"), ".claude/\n");
      execSync("git add -A", { cwd: repo2 });
      execSync('git commit -q -m init', { cwd: repo2 });

      const config = buildConfig();
      config.dbPath = ".claude/chunk-level-empty.db";
      const spy = makeSpyEmbedder(DIM);
      await runIndex({ projectRoot: repo2, config, mode: "full", embedder: spy });

      const client = openClient({ dbPath: join(repo2, config.dbPath), dimension: DIM });
      const rows = client.db
        .query<
          { file_path: string; chunk_hashes_json: string | null; chunk_count: number },
          []
        >(`SELECT file_path, chunk_hashes_json, chunk_count FROM index_ledger`)
        .all();
      const byPath = new Map(rows.map((r) => [r.file_path, r]));
      expect(byPath.get("src/empty.ts")?.chunk_hashes_json).toBe("[]");
      expect(byPath.get("src/empty.ts")?.chunk_count).toBe(0);

      const full = byPath.get("src/full.ts");
      expect(full?.chunk_hashes_json).toBeTruthy();
      const parsed = JSON.parse(full!.chunk_hashes_json!) as Array<{ key: string; sig: string }>;
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0]!).toHaveProperty("key");
      expect(parsed[0]!).toHaveProperty("sig");
      client.close();
    } finally {
      rmSync(repo2, { recursive: true, force: true });
    }
  });
});
