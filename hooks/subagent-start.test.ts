import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const handler = join(import.meta.dir, "subagent-start.mjs");

type RunResult = { stdout: string; stderr: string; json: unknown };

function runHook(cwd: string, stdinPayload: unknown): RunResult {
  const input = stdinPayload === undefined ? "" : JSON.stringify(stdinPayload);
  const res = spawnSync("bun", [handler], {
    cwd,
    input,
    encoding: "utf-8",
  });
  const stdout = res.stdout.trim();
  let json: unknown;
  try {
    json = stdout ? JSON.parse(stdout) : {};
  } catch {
    json = { __parseError: true, raw: stdout };
  }
  return { stdout, stderr: res.stderr, json };
}

function seedConfigAndDb(root: string, dbSize = 16384) {
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(
    join(root, ".claude/code-rag.config.json"),
    JSON.stringify({ dbPath: ".claude/code-rag.db" }),
    "utf-8",
  );
  writeFileSync(join(root, ".claude/code-rag.db"), Buffer.alloc(dbSize, 1));
}

describe("subagent-start hook", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ccrag-subagent-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("injects RAG guide when config and db are ready", () => {
    seedConfigAndDb(root);
    const { json } = runHook(root, {
      hook_event_name: "SubagentStart",
      agent_type: "Explore",
    });
    expect(json).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "SubagentStart",
        additionalContext: expect.stringContaining("mcp__cc-advanced-rag__search_code"),
      },
    });
  });

  test("returns empty payload when config is missing", () => {
    const { json } = runHook(root, {
      hook_event_name: "SubagentStart",
      agent_type: "Explore",
    });
    expect(json).toEqual({});
  });

  test("returns empty payload when db file is missing", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude/code-rag.config.json"),
      JSON.stringify({ dbPath: ".claude/code-rag.db" }),
      "utf-8",
    );
    const { json } = runHook(root, {
      hook_event_name: "SubagentStart",
      agent_type: "Explore",
    });
    expect(json).toEqual({});
  });

  test("returns empty payload when db is below 8KB", () => {
    seedConfigAndDb(root, 1024);
    const { json } = runHook(root, {
      hook_event_name: "SubagentStart",
      agent_type: "Explore",
    });
    expect(json).toEqual({});
  });

  test("returns empty payload for non-Explore agent_type", () => {
    seedConfigAndDb(root);
    const { json } = runHook(root, {
      hook_event_name: "SubagentStart",
      agent_type: "Plan",
    });
    expect(json).toEqual({});
  });

  test("returns empty payload on malformed stdin", () => {
    seedConfigAndDb(root);
    const res = spawnSync("bun", [handler], {
      cwd: root,
      input: "{not json",
      encoding: "utf-8",
    });
    const json = JSON.parse(res.stdout.trim() || "{}");
    expect(json).toMatchObject({
      hookSpecificOutput: { hookEventName: "SubagentStart" },
    });
  });

  test("omits agent_type is treated as Explore (matcher already filtered)", () => {
    seedConfigAndDb(root);
    const { json } = runHook(root, { hook_event_name: "SubagentStart" });
    expect(json).toMatchObject({
      hookSpecificOutput: {
        additionalContext: expect.stringContaining("search_code"),
      },
    });
  });
});
