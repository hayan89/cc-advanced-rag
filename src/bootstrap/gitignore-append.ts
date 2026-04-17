import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const RAG_GITIGNORE_BLOCK = [
  "# cc-advanced-rag — plugin artifacts",
  "/.claude/code-rag.db*",
  "/.claude/code-rag.log",
  "/.claude/code-rag.lock",
];

const BEGIN_MARK = "# cc-advanced-rag — plugin artifacts";

export interface AppendResult {
  action: "created" | "already-present" | "appended";
  path: string;
}

/**
 * Non-destructively ensure the RAG ignore block is present in `.gitignore`.
 * - If the file does not exist, create it with the block.
 * - If the marker is already present, do nothing.
 * - Otherwise append the block preceded by a blank line.
 */
export function ensureGitignoreEntries(projectRoot: string): AppendResult {
  const path = join(projectRoot, ".gitignore");
  if (!existsSync(path)) {
    writeFileSync(path, RAG_GITIGNORE_BLOCK.join("\n") + "\n", "utf-8");
    return { action: "created", path };
  }
  const current = readFileSync(path, "utf-8");
  if (current.includes(BEGIN_MARK)) {
    return { action: "already-present", path };
  }
  const suffix =
    (current.endsWith("\n") ? "" : "\n") + "\n" + RAG_GITIGNORE_BLOCK.join("\n") + "\n";
  writeFileSync(path, current + suffix, "utf-8");
  return { action: "appended", path };
}
