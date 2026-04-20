import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { runIndex } from "./index.ts";
import { defaultConfig } from "../config/defaults.ts";
import { openClient } from "../db/client.ts";
import { getRelatedHandler } from "../tools/get-related.ts";
import type { Embedder } from "./embedder.ts";
import type { ToolContext } from "../tools/context.ts";

/**
 * End-to-end regression test for the cross-stack failure reported by the
 * tb-ocr evaluation: a Go handler `api/handlers/receipt_upload.go` and its
 * SvelteKit frontend (`routes/receipt-upload/+page.svelte` + TS API client)
 * must surface as related via `get_related`. Before resource-tag weighting,
 * this scored 0/3; the assertions below lock in 3/3.
 */
let repo: string;
const DIMENSION = 64;

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
  repo = mkdtempSync(join(tmpdir(), "ccrag-cross-stack-"));
  execSync("git init -q", { cwd: repo });
  execSync('git config user.email "t@t.test"', { cwd: repo });
  execSync('git config user.name "t"', { cwd: repo });

  // ── Backend: Go handler ────────────────────────────────────────────
  mkdirSync(join(repo, "backend/api/handlers"), { recursive: true });
  writeFileSync(
    join(repo, "backend/api/handlers/receipt_upload.go"),
    `package handlers

import "net/http"

// ReceiptUploadHandler accepts a multipart receipt image, stores it, and
// enqueues OCR processing. Returns 201 on success.
func ReceiptUploadHandler(w http.ResponseWriter, r *http.Request) {
\tif r.Method != http.MethodPost {
\t\thttp.Error(w, "method not allowed", http.StatusMethodNotAllowed)
\t\treturn
\t}
\tw.WriteHeader(http.StatusCreated)
}
`,
  );

  // ── Frontend: SvelteKit route ──────────────────────────────────────
  mkdirSync(join(repo, "frontend/src/routes/receipt-upload"), { recursive: true });
  writeFileSync(
    join(repo, "frontend/src/routes/receipt-upload/+page.svelte"),
    `<script lang="ts">
  import { uploadReceipt } from "$lib/api/receiptUpload";

  let file: File | null = null;

  async function handleSubmit() {
    if (!file) return;
    await uploadReceipt(file);
  }
</script>

<form on:submit|preventDefault={handleSubmit}>
  <input type="file" accept="image/*" on:change={(e) => file = e.currentTarget.files?.[0] ?? null} />
  <button type="submit">Upload</button>
</form>
`,
  );

  // ── Frontend: TS API client ────────────────────────────────────────
  mkdirSync(join(repo, "frontend/src/lib/api"), { recursive: true });
  writeFileSync(
    join(repo, "frontend/src/lib/api/receiptUpload.ts"),
    `/** Upload a receipt to the backend /receipts endpoint. */
export async function uploadReceipt(file: File): Promise<Response> {
  const body = new FormData();
  body.append("file", file);
  return fetch("/api/receipts", { method: "POST", body });
}
`,
  );

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

describe("cross-stack resource matching", () => {
  test("get_related links Go handler to Svelte route + TS client (3/3)", async () => {
    const config = defaultConfig();
    config.embedding.provider = "ollama";
    config.embedding.model = "fake";
    config.embedding.dimension = DIMENSION;
    config.embedding.privacyMode = true;
    config.languages = ["go", "typescript", "svelte"];

    const summary = await runIndex({
      projectRoot: repo,
      config,
      mode: "full",
      embedder: makeFakeEmbedder(DIMENSION),
    });
    expect(summary.errors).toEqual([]);
    expect(summary.filesProcessed).toBeGreaterThanOrEqual(3);

    const client = openClient({
      dbPath: join(repo, config.dbPath),
      dimension: DIMENSION,
    });
    try {
      const ctx: ToolContext = {
        db: client.db,
        config,
        embedder: makeFakeEmbedder(DIMENSION),
        projectRoot: repo,
      };

      // All three files must carry the `resource:receipt-upload` tag.
      const taggedFiles = client.db
        .query<{ file_path: string }, [string]>(
          `SELECT DISTINCT c.file_path
             FROM chunk_tags ct JOIN chunks c ON c.id = ct.chunk_id
            WHERE ct.tag = ?`,
        )
        .all("resource:receipt-upload")
        .map((r) => r.file_path);
      expect(taggedFiles).toContain("backend/api/handlers/receipt_upload.go");
      expect(taggedFiles).toContain("frontend/src/routes/receipt-upload/+page.svelte");
      expect(taggedFiles).toContain("frontend/src/lib/api/receiptUpload.ts");

      // From the Go handler, both frontend files must appear in get_related.
      const related = await getRelatedHandler(
        {
          filePath: "backend/api/handlers/receipt_upload.go",
          resourceOnly: true,
          limit: 10,
        },
        ctx,
      );
      const text = related.content[0]?.text ?? "";
      expect(text).toContain("frontend/src/routes/receipt-upload/+page.svelte");
      expect(text).toContain("frontend/src/lib/api/receiptUpload.ts");
      // resourceOnly weighting must be ≥ 3 (one resource tag match).
      expect(text).toMatch(/score=[3-9]|score=\d{2,}/);
    } finally {
      client.close();
    }
  });

  test("handler ↔ worker cross-stack matching (Q3 regression)", async () => {
    // Regression fixture for the tb-ocr Q3 failure: a Go handler and a Go
    // worker under `backend/internal/worker/` must share `resource:ocr` so
    // `get_related` returns the worker when asked about the handler (and
    // vice versa). Before the stopwords expansion the worker produced
    // `resource:ocr-worker` instead.
    const repo3 = mkdtempSync(join(tmpdir(), "ccrag-cross-stack-hw-"));
    try {
      execSync("git init -q", { cwd: repo3 });
      execSync('git config user.email "t@t.test"', { cwd: repo3 });
      execSync('git config user.name "t"', { cwd: repo3 });

      mkdirSync(join(repo3, "backend/api/handlers"), { recursive: true });
      writeFileSync(
        join(repo3, "backend/api/handlers/ocr.go"),
        `package handlers

import "net/http"

// OCRHandler serves the /ocr endpoint and enqueues work for the worker.
func OCRHandler(w http.ResponseWriter, r *http.Request) {
\tw.WriteHeader(http.StatusAccepted)
}
`,
      );

      mkdirSync(join(repo3, "backend/internal/worker"), { recursive: true });
      writeFileSync(
        join(repo3, "backend/internal/worker/ocr_worker.go"),
        `package worker

// UpstageOCRWorker consumes jobs enqueued by the /ocr handler.
type UpstageOCRWorker struct{}

func NewUpstageOCRWorker() *UpstageOCRWorker { return &UpstageOCRWorker{} }

// PublishOCRJob pushes a new OCR job onto the shared queue.
func PublishOCRJob(payload []byte) error { return nil }
`,
      );

      writeFileSync(
        join(repo3, ".gitignore"),
        "node_modules/\n.claude/code-rag.db*\n.claude/code-rag.log\n.claude/code-rag.lock\n",
      );
      execSync("git add -A", { cwd: repo3 });
      execSync('git commit -q -m init', { cwd: repo3 });

      const config = defaultConfig();
      config.embedding.provider = "ollama";
      config.embedding.model = "fake";
      config.embedding.dimension = DIMENSION;
      config.embedding.privacyMode = true;
      config.languages = ["go"];

      const summary = await runIndex({
        projectRoot: repo3,
        config,
        mode: "full",
        embedder: makeFakeEmbedder(DIMENSION),
      });
      expect(summary.errors).toEqual([]);
      expect(summary.filesProcessed).toBeGreaterThanOrEqual(2);

      const client = openClient({
        dbPath: join(repo3, config.dbPath),
        dimension: DIMENSION,
      });
      try {
        const ctx: ToolContext = {
          db: client.db,
          config,
          embedder: makeFakeEmbedder(DIMENSION),
          projectRoot: repo3,
        };

        // Both handler and worker files must carry `resource:ocr` — this is
        // the file-level tag that enables cross-stack matching.
        const taggedFiles = client.db
          .query<{ file_path: string }, [string]>(
            `SELECT DISTINCT c.file_path
               FROM chunk_tags ct JOIN chunks c ON c.id = ct.chunk_id
              WHERE ct.tag = ?`,
          )
          .all("resource:ocr")
          .map((r) => r.file_path);
        expect(taggedFiles).toContain("backend/api/handlers/ocr.go");
        expect(taggedFiles).toContain("backend/internal/worker/ocr_worker.go");

        // And the legacy split tag must NOT appear — stopwords `worker`
        // should collapse the worker leaf onto `resource:ocr`.
        const splitRows = client.db
          .query<{ n: number }, []>(
            `SELECT COUNT(*) AS n FROM chunk_tags WHERE tag = 'resource:ocr-worker'`,
          )
          .get()?.n ?? 0;
        expect(splitRows).toBe(0);

        // From the handler, the worker file must appear via get_related.
        const related = await getRelatedHandler(
          {
            filePath: "backend/api/handlers/ocr.go",
            resourceOnly: true,
            limit: 10,
          },
          ctx,
        );
        const text = related.content[0]?.text ?? "";
        expect(text).toContain("backend/internal/worker/ocr_worker.go");
        expect(text).toMatch(/score=[3-9]|score=\d{2,}/);
      } finally {
        client.close();
      }
    } finally {
      rmSync(repo3, { recursive: true, force: true });
    }
  });

  test("resourceExtractor.enabled=false returns to legacy behavior", async () => {
    const repo2 = mkdtempSync(join(tmpdir(), "ccrag-cross-stack-off-"));
    try {
      execSync("git init -q", { cwd: repo2 });
      execSync('git config user.email "t@t.test"', { cwd: repo2 });
      execSync('git config user.name "t"', { cwd: repo2 });
      mkdirSync(join(repo2, "api/handlers"), { recursive: true });
      writeFileSync(
        join(repo2, "api/handlers/receipt_upload.go"),
        `package handlers
func ReceiptUploadHandler() {}
`,
      );
      writeFileSync(join(repo2, ".gitignore"), ".claude/\nnode_modules/\n");
      execSync("git add -A", { cwd: repo2 });
      execSync('git commit -q -m init', { cwd: repo2 });

      const config = defaultConfig();
      config.embedding.provider = "ollama";
      config.embedding.model = "fake";
      config.embedding.dimension = DIMENSION;
      config.embedding.privacyMode = true;
      config.languages = ["go"];
      config.tagging.resourceExtractor.enabled = false;

      const summary = await runIndex({
        projectRoot: repo2,
        config,
        mode: "full",
        embedder: makeFakeEmbedder(DIMENSION),
      });
      expect(summary.errors).toEqual([]);

      const client = openClient({
        dbPath: join(repo2, config.dbPath),
        dimension: DIMENSION,
      });
      try {
        const resourceTags = client.db
          .query<{ n: number }, []>(
            `SELECT COUNT(*) AS n FROM chunk_tags WHERE tag LIKE 'resource:%'`,
          )
          .get()?.n ?? 0;
        expect(resourceTags).toBe(0);
      } finally {
        client.close();
      }
    } finally {
      rmSync(repo2, { recursive: true, force: true });
    }
  });
});
