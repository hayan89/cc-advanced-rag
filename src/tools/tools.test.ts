import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openClient } from "../db/client.ts";
import { defaultConfig } from "../config/defaults.ts";
import type { ToolContext } from "./context.ts";
import { lookupFileHandler } from "./lookup-file.ts";
import { searchSymbolHandler } from "./search-symbol.ts";
import { getRelatedHandler } from "./get-related.ts";
import { indexStatusHandler } from "./index-status.ts";
import { rebuildIndexHandler } from "./rebuild-index.ts";

let tmp: string;
let ctx: ToolContext;
let client: ReturnType<typeof openClient>;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "ccrag-tools-"));
  const config = defaultConfig();
  config.dbPath = join(tmp, "db.sqlite");
  client = openClient({ dbPath: config.dbPath, dimension: config.embedding.dimension });

  // Seed two chunks + tags for get_related coverage.
  client.db.exec(`
    INSERT INTO chunks (file_path, file_hash, chunk_type, symbol_name, signature,
                        language, start_line, end_line, content, tags_json)
    VALUES ('src/a.ts','h','function','foo','function foo()','typescript',1,5,'function foo(){}','[]');
    INSERT INTO chunks (file_path, file_hash, chunk_type, symbol_name, signature,
                        language, start_line, end_line, content, tags_json)
    VALUES ('src/b.ts','h','function','bar','function bar()','typescript',10,15,'function bar(){}','[]');
    INSERT INTO files (file_path, file_hash, language, line_count, chunk_count)
    VALUES ('src/a.ts','h','typescript',5,1);
    INSERT INTO files (file_path, file_hash, language, line_count, chunk_count)
    VALUES ('src/b.ts','h','typescript',20,1);
    INSERT INTO chunk_tags (chunk_id, tag, weight) VALUES
      (1,'handler',1),(1,'api',1),(1,'resource:receipt-upload',3),
      (2,'handler',1),(2,'validation',1),(2,'resource:receipt-upload',3);
  `);

  ctx = {
    db: client.db,
    config,
    projectRoot: tmp,
    // Minimal fake embedder; not used by the handlers exercised here.
    embedder: {
      config: config.embedding,
      async embed() {
        throw new Error("embedder not expected in these tests");
      },
      async healthCheck() {},
    },
  };
});

afterAll(() => {
  client.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("lookup_file", () => {
  test("returns chunks for an indexed file", async () => {
    const result = await lookupFileHandler({ filePath: "src/a.ts" }, ctx);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("src/a.ts");
    expect(text).toContain("foo");
  });

  test("reports not indexed for unknown file", async () => {
    const result = await lookupFileHandler({ filePath: "src/nope.ts" }, ctx);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("not indexed");
  });
});

describe("search_symbol", () => {
  test("partial match returns results", async () => {
    const result = await searchSymbolHandler({ name: "foo" }, ctx);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("foo");
    expect(text).toContain("src/a.ts");
  });

  test("exact match respects boundary", async () => {
    const result = await searchSymbolHandler({ name: "foo", exact: true }, ctx);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("1 symbols");
  });

  test("language filter narrows results", async () => {
    const result = await searchSymbolHandler({ name: "foo", language: "go" }, ctx);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("no symbols");
  });
});

describe("get_related", () => {
  test("finds related file via weighted tag score", async () => {
    // src/a.ts has tags {handler, api, resource:receipt-upload}; src/b.ts has
    // {handler, validation, resource:receipt-upload}. Shared tags are
    // `handler` (weight 1) and `resource:receipt-upload` (weight 3) ⇒ score 4.
    const result = await getRelatedHandler({ filePath: "src/a.ts" }, ctx);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("src/b.ts");
    expect(text).toContain("score=4");
  });

  test("resourceOnly restricts to resource:* tags", async () => {
    const result = await getRelatedHandler(
      { filePath: "src/a.ts", resourceOnly: true },
      ctx,
    );
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("src/b.ts");
    // Only resource:receipt-upload (weight 3) counts under resourceOnly.
    expect(text).toContain("score=3");
    expect(text).toContain("reference_tags=resource:receipt-upload");
  });

  test("reports missing tags when no reference exists", async () => {
    const result = await getRelatedHandler({ filePath: "src/none.ts" }, ctx);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("no tags found");
  });
});

describe("index_status", () => {
  test("summary includes chunks/files/language breakdown", async () => {
    const result = await indexStatusHandler({}, ctx);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("chunks: 2");
    expect(text).toContain("files: 2");
    expect(text).toContain("typescript");
  });
});

describe("rebuild_index", () => {
  test("returns command guidance (no direct run in server)", async () => {
    const result = await rebuildIndexHandler({ full: true }, ctx);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("rebuild_index requested");
    expect(text).toContain("bun");
    expect(text).toContain("--full");
  });
});
