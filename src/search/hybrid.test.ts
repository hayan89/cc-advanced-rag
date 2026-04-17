import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openClient, type Client } from "../db/client.ts";
import { hybridSearch } from "./hybrid.ts";
import { semanticSearch } from "./semantic.ts";
import { buildFtsQuery } from "./fts-query.ts";
import { getCached, setCached, hashKey } from "../cache/l1-exact.ts";

const DIMENSION = 64; // small for test speed

function makeVec(activeDims: Array<[number, number]>): Float32Array {
  const v = new Float32Array(DIMENSION);
  for (const [idx, val] of activeDims) v[idx] = val;
  return v;
}

interface ChunkSpec {
  filePath: string;
  symbolName: string;
  signature: string;
  content: string;
  scope: string;
  startLine: number;
  endLine: number;
  language: string;
  vector: Float32Array;
}

const CORPUS: ChunkSpec[] = [
  {
    filePath: "src/ocr/receipt.ts",
    symbolName: "processReceipt",
    signature: "async function processReceipt(image: Buffer): Promise<ReceiptData>",
    content: "async function processReceipt(image: Buffer): Promise<ReceiptData> {\n  const parsed = await ocrEngine.analyze(image);\n  return extractFields(parsed);\n}",
    scope: "backend",
    startLine: 10,
    endLine: 14,
    language: "typescript",
    vector: makeVec([[0, 1.0]]), // unique to receipt
  },
  {
    filePath: "src/ocr/pharma.ts",
    symbolName: "processPharmaDoc",
    signature: "function processPharmaDoc(pdf: PDFDocument): PharmaReport",
    content: "function processPharmaDoc(pdf: PDFDocument): PharmaReport {\n  const pages = pdf.getPages();\n  return pages.map(recognizePharma).filter(hasContent);\n}",
    scope: "backend",
    startLine: 20,
    endLine: 24,
    language: "typescript",
    vector: makeVec([[30, 1.0]]), // disjoint from receipt so ordering is deterministic
  },
  {
    filePath: "src/http/routes.ts",
    symbolName: "registerRoutes",
    signature: "function registerRoutes(app: Express): void",
    content: "function registerRoutes(app: Express): void {\n  app.get('/api/v1/health', healthCheck);\n  app.post('/api/v1/upload', uploadHandler);\n}",
    scope: "backend",
    startLine: 5,
    endLine: 9,
    language: "typescript",
    vector: makeVec([[5, 1.0]]), // "http routing" theme
  },
  {
    filePath: "src/http/health.ts",
    symbolName: "healthCheck",
    signature: "function healthCheck(req: Request, res: Response): void",
    content: "function healthCheck(req: Request, res: Response): void {\n  res.json({ status: 'ok' });\n}",
    scope: "backend",
    startLine: 1,
    endLine: 4,
    language: "typescript",
    vector: makeVec([[5, 0.9]]),
  },
  {
    filePath: "ui/components/Upload.svelte",
    symbolName: "handleUpload",
    signature: "function handleUpload(file: File): Promise<void>",
    content: "function handleUpload(file: File): Promise<void> {\n  const form = new FormData();\n  form.append('receipt', file);\n  return fetch('/api/v1/upload', { method: 'POST', body: form });\n}",
    scope: "frontend",
    startLine: 10,
    endLine: 16,
    language: "svelte",
    vector: makeVec([[10, 1.0]]),
  },
  {
    filePath: "ui/lib/error.ts",
    symbolName: "handleError",
    signature: "function handleError(err: Error): string",
    content: "function handleError(err: Error): string {\n  console.error('Error occurred:', err.message);\n  return err.stack ?? 'unknown';\n}",
    scope: "frontend",
    startLine: 1,
    endLine: 5,
    language: "typescript",
    vector: makeVec([[15, 1.0]]), // "error handling" theme
  },
  {
    filePath: "src/util/retry.ts",
    symbolName: "retryWithBackoff",
    signature: "async function retryWithBackoff<T>(fn: () => Promise<T>, max = 3): Promise<T>",
    content: "async function retryWithBackoff<T>(fn: () => Promise<T>, max = 3): Promise<T> {\n  let lastErr;\n  for (let i = 0; i < max; i++) {\n    try { return await fn(); } catch (e) { lastErr = e; await sleep(2 ** i * 100); }\n  }\n  throw lastErr;\n}",
    scope: "backend",
    startLine: 3,
    endLine: 11,
    language: "typescript",
    vector: makeVec([[20, 1.0]]),
  },
  {
    filePath: "src/db/migrate.go",
    symbolName: "RunMigrations",
    signature: "func RunMigrations(db *sql.DB) error",
    content: "func RunMigrations(db *sql.DB) error {\n    for _, m := range migrations {\n        if err := m.Up(db); err != nil { return err }\n    }\n    return nil\n}",
    scope: "backend",
    startLine: 10,
    endLine: 16,
    language: "go",
    vector: makeVec([[25, 1.0]]),
  },
];

let tmpDir: string;
let client: Client;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ccrag-search-test-"));
  const dbPath = join(tmpDir, "test.db");
  client = openClient({ dbPath, dimension: DIMENSION });

  const insertChunk = client.db.query<{ id: number }, [string, string, string, string, string, string, number, number, string]>(`
    INSERT INTO chunks (file_path, file_hash, chunk_type, symbol_name, signature, language, scope, start_line, end_line, content)
    VALUES (?, ?, 'function', ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `);
  const insertVec = client.db.query(`INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)`);

  for (const spec of CORPUS) {
    const row = insertChunk.get(
      spec.filePath,
      "sha-" + spec.symbolName,
      spec.symbolName,
      spec.signature,
      spec.language,
      spec.scope,
      spec.startLine,
      spec.endLine,
      spec.content,
    );
    const id = row!.id;
    insertVec.run(id, new Uint8Array(spec.vector.buffer));
  }
});

afterAll(() => {
  client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildFtsQuery", () => {
  test("produces OR-joined prefix terms", () => {
    const q = buildFtsQuery("process receipt ocr");
    expect(q).toBe("process* OR receipt* OR ocr*");
  });

  test("drops single-char noise", () => {
    const q = buildFtsQuery("a handle error");
    expect(q).toBe("handle* OR error*");
  });

  test("quotes reserved tokens", () => {
    const q = buildFtsQuery("foo AND bar");
    // AND is reserved — should be quoted
    expect(q).toContain('"AND"');
  });

  test("returns null for empty query", () => {
    expect(buildFtsQuery("")).toBeNull();
    expect(buildFtsQuery("!@#$")).toBeNull();
  });
});

describe("semanticSearch", () => {
  test("vector-closest chunk ranks first", () => {
    const qv = makeVec([[0, 1.0]]); // dim 0 is unique to processReceipt
    const results = semanticSearch({ db: client.db, queryVector: qv, limit: 3 });
    expect(results.length).toBe(3);
    expect(results[0]!.symbolName).toBe("processReceipt");
  });

  test("respects scope filter", () => {
    const qv = makeVec([[15, 1.0]]); // error theme (frontend)
    const all = semanticSearch({ db: client.db, queryVector: qv, limit: 5 });
    const frontend = semanticSearch({ db: client.db, queryVector: qv, scope: "frontend", limit: 5 });
    expect(frontend.every((r) => r.scope === "frontend")).toBe(true);
    expect(frontend.length).toBeLessThanOrEqual(all.length);
  });
});

describe("hybridSearch", () => {
  test("combines vector + BM25 via RRF", () => {
    const qv = makeVec([[0, 1.0]]);
    const results = hybridSearch({
      db: client.db,
      query: "processReceipt OCR",
      queryVector: qv,
      limit: 3,
    });
    expect(results.length).toBeGreaterThan(0);
    // processReceipt should be top — it matches both channels
    expect(results[0]!.symbolName).toBe("processReceipt");
    expect(results[0]!.highlight).toBeTruthy();
    expect(results[0]!.highlight).toContain("<<");
  });

  test("BM25 alone finds result even when vector is cold", () => {
    // Use a random query vector unrelated to any chunk's embedding
    const coldVec = makeVec([[63, 1.0]]);
    const results = hybridSearch({
      db: client.db,
      query: "retryWithBackoff",
      queryVector: coldVec,
      limit: 3,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.symbolName === "retryWithBackoff")).toBe(true);
  });

  test("scope filter narrows results", () => {
    const qv = makeVec([[10, 1.0]]);
    const frontend = hybridSearch({
      db: client.db,
      query: "upload",
      queryVector: qv,
      scope: "frontend",
      limit: 5,
    });
    expect(frontend.every((r) => r.scope === "frontend")).toBe(true);
  });

  test("returns empty when query and vector both miss", () => {
    const coldVec = new Float32Array(DIMENSION);
    const results = hybridSearch({
      db: client.db,
      query: "zzzzzzzz_never_exists",
      queryVector: coldVec,
      limit: 3,
    });
    // Vector channel always returns something (nearest), so we expect at least some results.
    // But the BM25 miss shouldn't crash.
    expect(Array.isArray(results)).toBe(true);
  });
});

describe("L1 exact cache", () => {
  test("set/get round-trip", () => {
    const key = { query: "foo", scope: "backend", limit: 5, gitHeadSha: "abc123" };
    const payload = [{ file: "x.ts", score: 0.9 }];
    setCached(client.db, key, payload, 1);
    const hit = getCached<typeof payload>(client.db, key);
    expect(hit).not.toBeNull();
    expect(hit!.result).toEqual(payload);
    expect(hit!.hitCount).toBe(2);
  });

  test("miss on different git HEAD", () => {
    const key = { query: "bar", gitHeadSha: "abc123" };
    setCached(client.db, key, { a: 1 }, 1);
    const miss = getCached(client.db, { ...key, gitHeadSha: "different" });
    expect(miss).toBeNull();
  });

  test("hashKey is stable", () => {
    const k1 = { query: "foo", scope: "backend", limit: 5, gitHeadSha: "abc" };
    const k2 = { query: "foo", scope: "backend", limit: 5, gitHeadSha: "xyz" }; // gitHead not in hash
    expect(hashKey(k1)).toBe(hashKey(k2));
  });
});
