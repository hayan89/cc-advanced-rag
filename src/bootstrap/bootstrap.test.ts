import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { ensureGitignoreEntries, RAG_GITIGNORE_BLOCK } from "./gitignore-append.ts";
import { installPostCommitHook, findHooksDir } from "./install-git-hook.ts";

let root: string;
const pluginRoot = "/tmp/fake-plugin-root";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ccrag-bootstrap-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ensureGitignoreEntries", () => {
  beforeEach(() => {
    const p = join(root, ".gitignore");
    if (existsSync(p)) rmSync(p);
  });

  test("creates .gitignore when absent", () => {
    const r = ensureGitignoreEntries(root);
    expect(r.action).toBe("created");
    const content = readFileSync(r.path, "utf-8");
    for (const line of RAG_GITIGNORE_BLOCK) expect(content).toContain(line);
  });

  test("appends block when file exists without marker", () => {
    writeFileSync(join(root, ".gitignore"), "node_modules/\n", "utf-8");
    const r = ensureGitignoreEntries(root);
    expect(r.action).toBe("appended");
    const content = readFileSync(r.path, "utf-8");
    expect(content).toContain("node_modules/");
    expect(content).toContain(RAG_GITIGNORE_BLOCK[0]!);
  });

  test("idempotent when marker already present", () => {
    writeFileSync(
      join(root, ".gitignore"),
      "node_modules/\n" + RAG_GITIGNORE_BLOCK.join("\n") + "\n",
      "utf-8",
    );
    const r = ensureGitignoreEntries(root);
    expect(r.action).toBe("already-present");
  });
});

describe("installPostCommitHook", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "ccrag-hook-"));
    execSync("git init -q", { cwd: repo });
  });

  test("creates hook file when absent", () => {
    const r = installPostCommitHook(repo, pluginRoot);
    expect(r.action).toBe("created");
    const content = readFileSync(r.path!, "utf-8");
    expect(content).toContain("#!/bin/sh");
    expect(content).toContain("BEGIN cc-advanced-rag");
    expect(content).toContain(pluginRoot);
  });

  test("appends block to existing user hook", () => {
    const hooksDir = findHooksDir(repo)!;
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      join(hooksDir, "post-commit"),
      "#!/bin/sh\n\necho 'user hook'\n",
      "utf-8",
    );
    const r = installPostCommitHook(repo, pluginRoot);
    expect(r.action).toBe("appended");
    const content = readFileSync(r.path!, "utf-8");
    expect(content).toContain("echo 'user hook'");
    expect(content).toContain("BEGIN cc-advanced-rag");
  });

  test("replaces only the managed block on re-install", () => {
    installPostCommitHook(repo, "/old/plugin/root");
    const r = installPostCommitHook(repo, pluginRoot);
    expect(["replaced", "already-present"]).toContain(r.action);
    const content = readFileSync(r.path!, "utf-8");
    expect(content).toContain(pluginRoot);
    expect(content).not.toContain("/old/plugin/root");
  });

  test("returns skipped-no-git outside a repo", () => {
    const notRepo = mkdtempSync(join(tmpdir(), "ccrag-nogit-"));
    const r = installPostCommitHook(notRepo, pluginRoot);
    expect(r.action).toBe("skipped-no-git");
    rmSync(notRepo, { recursive: true, force: true });
  });
});
