import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

const HOOK_BEGIN = "# BEGIN cc-advanced-rag post-commit";
const HOOK_END = "# END cc-advanced-rag post-commit";

export interface InstallResult {
  action: "created" | "appended" | "already-present" | "replaced" | "skipped-no-git";
  path: string | null;
}

/**
 * Locate the `.git/hooks` directory for the given project. Works for plain
 * repos, submodules (git-file pointer), and the primary working tree of a
 * multi-worktree setup.
 */
export function findHooksDir(projectRoot: string): string | null {
  try {
    const gitDir = execSync("git rev-parse --git-dir", {
      cwd: projectRoot,
      encoding: "utf-8",
    }).trim();
    const abs = resolve(projectRoot, gitDir);
    return join(abs, "hooks");
  } catch {
    return null;
  }
}

/**
 * Render the managed hook block. It runs the plugin indexer in the background
 * so commits remain fast, and silently no-ops if the plugin is not installed
 * (e.g. the repo was cloned on a machine without the plugin yet).
 */
function renderBlock(pluginRoot: string): string {
  const indexerPath = join(pluginRoot, "scripts/index.ts");
  return [
    HOOK_BEGIN,
    `# Managed by cc-advanced-rag. Safe to remove this block if you uninstall the plugin.`,
    `if [ -x "$(command -v bun)" ] && [ -f "${indexerPath}" ]; then`,
    `  (bun "${indexerPath}" --since=HEAD~1 >/dev/null 2>&1 &) || true`,
    `fi`,
    HOOK_END,
  ].join("\n");
}

/**
 * Install (or refresh) a chain-called post-commit hook for incremental indexing.
 * - Non-destructive: preserves any existing hook contents.
 * - Idempotent: replaces only the block between BEGIN/END markers.
 */
export function installPostCommitHook(
  projectRoot: string,
  pluginRoot: string,
): InstallResult {
  const hooksDir = findHooksDir(projectRoot);
  if (!hooksDir) {
    return { action: "skipped-no-git", path: null };
  }
  mkdirSync(hooksDir, { recursive: true });

  const path = join(hooksDir, "post-commit");
  const block = renderBlock(pluginRoot);

  if (!existsSync(path)) {
    writeFileSync(path, `#!/bin/sh\n\n${block}\n`, "utf-8");
    chmodIfPossible(path);
    return { action: "created", path };
  }

  const current = readFileSync(path, "utf-8");
  if (current.includes(HOOK_BEGIN) && current.includes(HOOK_END)) {
    const replaced = current.replace(
      new RegExp(`${escapeRegex(HOOK_BEGIN)}[\\s\\S]*?${escapeRegex(HOOK_END)}`),
      block,
    );
    if (replaced === current) return { action: "already-present", path };
    writeFileSync(path, replaced, "utf-8");
    chmodIfPossible(path);
    return { action: "replaced", path };
  }

  const appended = current + (current.endsWith("\n") ? "" : "\n") + "\n" + block + "\n";
  writeFileSync(path, appended, "utf-8");
  chmodIfPossible(path);
  return { action: "appended", path };
}

function chmodIfPossible(path: string): void {
  try {
    const mode = statSync(path).mode | 0o111;
    chmodSync(path, mode);
  } catch {
    // Permission errors on Windows or locked volumes — no-op.
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
