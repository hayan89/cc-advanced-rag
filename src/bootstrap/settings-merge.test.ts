import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergeSettings,
  RAG_MCP_TOOLS,
  MalformedSettingsError,
  settingsLocalPath,
  _readMtimeMs,
} from "./settings-merge.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccrag-settings-merge-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("mergeSettings", () => {
  test("creates settings.local.json with all 6 entries when absent", () => {
    const result = mergeSettings(root);
    expect(result.action).toBe("created");
    expect(result.added).toEqual([...RAG_MCP_TOOLS]);
    const written = JSON.parse(readFileSync(settingsLocalPath(root), "utf-8"));
    expect(written.permissions.allow).toEqual([...RAG_MCP_TOOLS]);
  });

  test("preserves existing allow entries and unions the 6 tools", () => {
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      settingsLocalPath(root),
      JSON.stringify(
        {
          permissions: { allow: ["Bash(git status:*)", "WebFetch"] },
          someOtherField: { keep: true },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const result = mergeSettings(root);
    expect(result.action).toBe("merged");
    expect(result.added).toEqual([...RAG_MCP_TOOLS]);

    const written = JSON.parse(readFileSync(settingsLocalPath(root), "utf-8"));
    expect(written.permissions.allow).toContain("Bash(git status:*)");
    expect(written.permissions.allow).toContain("WebFetch");
    for (const tool of RAG_MCP_TOOLS) {
      expect(written.permissions.allow).toContain(tool);
    }
    expect(written.someOtherField).toEqual({ keep: true });
  });

  test("idempotent no-op when all 6 entries already present (mtime preserved)", async () => {
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      settingsLocalPath(root),
      JSON.stringify({ permissions: { allow: [...RAG_MCP_TOOLS] } }, null, 2),
      "utf-8",
    );
    const before = _readMtimeMs(settingsLocalPath(root));
    await new Promise((r) => setTimeout(r, 20));

    const result = mergeSettings(root);
    expect(result.action).toBe("already-present");
    expect(result.added).toEqual([]);

    const after = _readMtimeMs(settingsLocalPath(root));
    expect(after).toBe(before);
  });

  test("malformed JSON: backs up and throws, original file untouched", () => {
    mkdirSync(join(root, ".claude"));
    const original = "{ this is not: valid json,,, ]";
    writeFileSync(settingsLocalPath(root), original, "utf-8");

    expect(() => mergeSettings(root)).toThrow(MalformedSettingsError);

    expect(readFileSync(settingsLocalPath(root), "utf-8")).toBe(original);
    const backups = readdirSync(join(root, ".claude")).filter((n) =>
      n.startsWith("settings.local.json.bak-"),
    );
    expect(backups.length).toBe(1);
    expect(readFileSync(join(root, ".claude", backups[0]!), "utf-8")).toBe(original);
  });
});
