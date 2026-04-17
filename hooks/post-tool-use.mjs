#!/usr/bin/env bun
// cc-advanced-rag PostToolUse hook.
//
// Two branches, both non-interactive:
//   (a) bootstrap incomplete + Claude just Read/Edit/Write a code file
//       → inject rag-bootstrap magic keyword (debounced, max 2 per session).
//   (b) index exists + Claude Read/Grep'd a code file (Bash excluded)
//       → nudge Claude to prefer `search_code` (max 2 per session).
//
// Execution budget: p95 < 100ms. All heavy work is delegated to the MCP
// server; this hook performs only small filesystem probes.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const cwd = process.cwd();
const configPath = join(cwd, ".claude/code-rag.config.json");
const dbPath = join(cwd, ".claude/code-rag.db");
const stateDir = resolve(process.env.CLAUDE_PLUGIN_DATA ?? join(cwd, ".claude/.cc-advanced-rag"));
const stateFile = join(stateDir, "hook-state.json");

const CODE_EXTS = /\.(ts|tsx|js|jsx|py|go|rs|java|cs|cpp|cc|h|hpp|svelte)$/i;
const MAX_BOOTSTRAP_NUDGE = 2;
const MAX_SEARCH_NUDGE = 2;

function emit(additionalContext) {
  const payload = additionalContext
    ? { hookSpecificOutput: { additionalContext } }
    : {};
  process.stdout.write(JSON.stringify(payload));
}

function readStdin() {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function loadState() {
  try {
    return JSON.parse(readFileSync(stateFile, "utf-8"));
  } catch {
    return { bootstrapNudges: 0, searchNudges: 0, lastInvokedAt: 0 };
  }
}

function saveState(s) {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stateFile, JSON.stringify(s), "utf-8");
  } catch {
    // best effort
  }
}

function extractFilePath(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return null;
  if (typeof toolInput.file_path === "string") return toolInput.file_path;
  if (typeof toolInput.path === "string") return toolInput.path;
  if (typeof toolInput.notebook_path === "string") return toolInput.notebook_path;
  return null;
}

function isCodeFile(p) {
  return typeof p === "string" && CODE_EXTS.test(p);
}

function main() {
  let payload = {};
  try {
    payload = JSON.parse(readStdin() || "{}");
  } catch {
    payload = {};
  }
  const toolName = payload.tool_name ?? payload.toolName ?? "";
  const toolInput = payload.tool_input ?? payload.toolInput ?? {};

  // Skip tools we don't watch.
  if (!["Read", "Edit", "Write", "Grep", "NotebookEdit"].includes(toolName)) {
    emit(null);
    return;
  }

  const filePath = extractFilePath(toolInput);
  if (!isCodeFile(filePath)) {
    emit(null);
    return;
  }

  const state = loadState();

  const bootstrapDone = existsSync(configPath);
  const indexExists = existsSync(dbPath);

  // Branch (a): bootstrap not done → nudge rag-bootstrap skill.
  if (!bootstrapDone && state.bootstrapNudges < MAX_BOOTSTRAP_NUDGE) {
    state.bootstrapNudges += 1;
    state.lastInvokedAt = Date.now();
    saveState(state);
    emit(
      "[MAGIC KEYWORD: rag-bootstrap] 코드 파일 접근이 감지됐으나 RAG가 아직 설정되지 않았습니다. " +
        "rag-bootstrap 스킬을 호출해 1회성 질문 후 자동 구성하세요.",
    );
    return;
  }

  // Branch (b): index exists → nudge search_code usage.
  if (indexExists && state.searchNudges < MAX_SEARCH_NUDGE) {
    state.searchNudges += 1;
    state.lastInvokedAt = Date.now();
    saveState(state);
    emit(
      "[cc-advanced-rag hint] search_code MCP 툴을 Read/Grep보다 먼저 사용하세요. " +
        "의미 기반 결과가 빠르고 맥락이 풍부합니다. 이 힌트는 세션당 최대 2회 표시됩니다.",
    );
    return;
  }

  emit(null);
}

try {
  main();
} catch (err) {
  process.stderr.write(`[cc-advanced-rag post-tool-use] ${err.message ?? err}\n`);
  process.stdout.write("{}");
}
