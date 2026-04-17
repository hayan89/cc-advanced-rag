import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openClient, type Client } from "../db/client.ts";
import {
  applyRename,
  classifyChanges,
  deleteLedgerEntry,
  garbageCollectFile,
  loadLedger,
  parseDiffNameStatus,
  upsertLedgerEntry,
} from "./ledger.ts";

let tmp: string;
let client: Client;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "ccrag-ledger-"));
  client = openClient({ dbPath: join(tmp, "ledger.db"), dimension: 64 });
});

afterAll(() => {
  client.close();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  // Reset ledger-related tables between tests.
  client.db.exec("DELETE FROM index_ledger; DELETE FROM chunks; DELETE FROM files;");
});

describe("parseDiffNameStatus", () => {
  test("parses A/M/D/R entries", () => {
    const out = [
      "A\tsrc/new.ts",
      "M\tsrc/modified.ts",
      "D\tsrc/deleted.ts",
      "R100\tsrc/old.ts\tsrc/new-name.ts",
    ].join("\n");
    const diff = parseDiffNameStatus(out);
    expect(diff.added).toEqual(["src/new.ts"]);
    expect(diff.modified).toEqual(["src/modified.ts"]);
    expect(diff.deleted).toEqual(["src/deleted.ts"]);
    expect(diff.renamed).toEqual([{ from: "src/old.ts", to: "src/new-name.ts" }]);
  });

  test("ignores empty lines", () => {
    const diff = parseDiffNameStatus("\n\n");
    expect(diff.added).toEqual([]);
  });
});

describe("ledger CRUD", () => {
  test("upsert then load round-trip", () => {
    upsertLedgerEntry(client.db, {
      filePath: "a.ts",
      blobSha: "sha-a",
      signatureHash: "sig-a",
      chunkCount: 3,
    });
    const map = loadLedger(client.db);
    expect(map.size).toBe(1);
    expect(map.get("a.ts")?.blobSha).toBe("sha-a");
  });

  test("delete entry", () => {
    upsertLedgerEntry(client.db, {
      filePath: "b.ts",
      blobSha: "sha-b",
      signatureHash: "sig-b",
      chunkCount: 1,
    });
    deleteLedgerEntry(client.db, "b.ts");
    expect(loadLedger(client.db).has("b.ts")).toBe(false);
  });

  test("garbageCollectFile removes chunks + files + ledger", () => {
    // Insert a chunk + file + ledger row for the same path
    client.db
      .query<{ id: number }, [string, string, string, string, number, number, string]>(
        `INSERT INTO chunks (file_path, file_hash, chunk_type, symbol_name, language, start_line, end_line, content)
         VALUES (?, ?, 'function', ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get("gc.ts", "h1", "sym", "typescript", 1, 2, "code");
    client.db
      .query(
        `INSERT INTO files (file_path, file_hash, language, line_count, chunk_count) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("gc.ts", "h1", "typescript", 10, 1);
    upsertLedgerEntry(client.db, {
      filePath: "gc.ts",
      blobSha: "b1",
      signatureHash: "s1",
      chunkCount: 1,
    });

    garbageCollectFile(client.db, "gc.ts");

    expect(loadLedger(client.db).has("gc.ts")).toBe(false);

    const chunks = client.db
      .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM chunks WHERE file_path = ?`)
      .get("gc.ts");
    expect(chunks?.n).toBe(0);

    const files = client.db
      .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM files WHERE file_path = ?`)
      .get("gc.ts");
    expect(files?.n).toBe(0);
  });

  test("applyRename updates all tables without losing data", () => {
    client.db
      .query(
        `INSERT INTO chunks (file_path, file_hash, chunk_type, symbol_name, language, start_line, end_line, content)
         VALUES (?, ?, 'function', ?, ?, ?, ?, ?)`,
      )
      .run("old.ts", "h1", "sym", "typescript", 1, 2, "code");
    client.db
      .query(
        `INSERT INTO files (file_path, file_hash, language, line_count, chunk_count) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("old.ts", "h1", "typescript", 1, 1);
    upsertLedgerEntry(client.db, {
      filePath: "old.ts",
      blobSha: "b1",
      signatureHash: "s1",
      chunkCount: 1,
    });

    applyRename(client.db, "old.ts", "new.ts");

    const ledger = loadLedger(client.db);
    expect(ledger.has("old.ts")).toBe(false);
    expect(ledger.has("new.ts")).toBe(true);

    const chunkRows = client.db
      .query<{ file_path: string }, []>(`SELECT file_path FROM chunks`)
      .all();
    expect(chunkRows.every((r) => r.file_path === "new.ts")).toBe(true);
  });
});

describe("classifyChanges", () => {
  test("classifies new/unchanged/content-only/deleted", () => {
    const ledger = new Map([
      ["keep.ts", { filePath: "keep.ts", blobSha: "sha1", signatureHash: "sig", chunkCount: 1 }],
      ["edit.ts", { filePath: "edit.ts", blobSha: "sha2", signatureHash: "sig2", chunkCount: 2 }],
      ["gone.ts", { filePath: "gone.ts", blobSha: "sha3", signatureHash: "sig3", chunkCount: 1 }],
    ]);
    const current = new Map([
      ["keep.ts", "sha1"],
      ["edit.ts", "sha2-new"],
      ["fresh.ts", "sha4"],
    ]);

    const changes = classifyChanges(current, ledger);
    const byType = Object.fromEntries(
      ["new", "unchanged", "content-only", "deleted"].map((t) => [
        t,
        changes.filter((c) => c.type === t).map((c) => c.filePath),
      ]),
    );
    expect(byType.new).toEqual(["fresh.ts"]);
    expect(byType.unchanged).toEqual(["keep.ts"]);
    expect(byType["content-only"]).toEqual(["edit.ts"]);
    expect(byType.deleted).toEqual(["gone.ts"]);
  });

  test("respects filter function", () => {
    const ledger = new Map();
    const current = new Map([
      ["a.ts", "sha"],
      ["b.md", "sha"],
    ]);
    const changes = classifyChanges(current, ledger, (p) => p.endsWith(".ts"));
    expect(changes.map((c) => c.filePath)).toEqual(["a.ts"]);
  });
});
