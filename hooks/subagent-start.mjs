#!/usr/bin/env bun
// cc-advanced-rag SubagentStart hook.
//
// Fires when Claude Code spawns an Explore subagent (hooks.json matcher).
// Injects RAG usage guide into the subagent's own context so it prefers
// `search_code` MCP tool over Read/Grep from the very first turn.
//
// The injected `additionalContext` lands in the subagent's context per
// https://code.claude.com/docs/en/hooks (SubagentStart > additionalContext).
//
// No debouncing: each Explore dispatch is a fresh context. Injection is
// skipped when bootstrap/index isn't ready so the subagent falls back to
// normal Read/Grep without confusing hints about tools it can't use.
//
// Budget: p95 < 100ms. Only cheap filesystem probes.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const cwd = process.cwd();
const configPath = join(cwd, ".claude/code-rag.config.json");
const defaultDbPath = join(cwd, ".claude/code-rag.db");

function emit(additionalContext) {
  const payload = additionalContext
    ? { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext } }
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

function indexReady() {
  if (!existsSync(configPath)) return false;
  let dbPath = defaultDbPath;
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
    if (typeof cfg?.dbPath === "string") dbPath = join(cwd, cfg.dbPath);
  } catch {
    return false;
  }
  if (!existsSync(dbPath)) return false;
  try {
    return statSync(dbPath).size >= 8192;
  } catch {
    return false;
  }
}

const RAG_GUIDE = [
  "[cc-advanced-rag] 이 프로젝트에는 semantic 코드 검색 인덱스가 준비되어 있습니다.",
  "Read/Grep보다 먼저 다음 MCP 툴을 사용하세요:",
  "",
  "| 상황 | 툴 |",
  "|---|---|",
  "| 기능/동작 찾기 (자연어) | mcp__cc-advanced-rag__search_code |",
  "| 심볼 정확 매칭 | mcp__cc-advanced-rag__search_symbol |",
  "| 파일 전체 구조 | mcp__cc-advanced-rag__lookup_file |",
  "| 연관 파일 (cross-stack) | mcp__cc-advanced-rag__get_related |",
  "",
  "쿼리 요령:",
  "- 자연어 + 도메인 용어 섞기 (\"receipt upload validation\")",
  "- 언어 필터는 인자(language)로 전달, 쿼리 본문에 언어명 포함 금지",
  "- 한글·1글자 심볼은 search_symbol 사용 (FTS 토크나이저가 2글자+ 요구)",
  "",
  "Gotcha: 결과가 부족하면 Grep로 폴백. FTS5 예약어(AND/OR/NOT/NEAR)는 자동 quote됨.",
].join("\n");

function main() {
  let payload = {};
  try {
    payload = JSON.parse(readStdin() || "{}");
  } catch {
    payload = {};
  }

  const agentType = payload.agent_type ?? payload.agentType ?? "";
  if (agentType && agentType !== "Explore") {
    emit(null);
    return;
  }

  if (!indexReady()) {
    emit(null);
    return;
  }

  emit(RAG_GUIDE);
}

try {
  main();
} catch (err) {
  process.stderr.write(`[cc-advanced-rag subagent-start] ${err.message ?? err}\n`);
  process.stdout.write("{}");
}
