#!/usr/bin/env bun
// cc-advanced-rag SessionStart hook — runs at the start of every session.
//
// Responsibilities (non-blocking, p95 < 100ms budget):
//   1) If `.claude/code-rag.config.json` exists → smoke-check the DB and
//      recommend `/rag-doctor` on problems. Do NOT re-bootstrap.
//   2) If config is absent AND we're in a git repo AND the project has
//      enough source files in supported languages → inject a magic keyword
//      that triggers the `rag-bootstrap` skill (asks the user once, then
//      auto-configures everything).
//
// The hook reads stdin (ignored by us) and writes a JSON payload on stdout
// per the Claude Code hook protocol.

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const cwd = process.cwd();
const configPath = join(cwd, ".claude/code-rag.config.json");

function emit(additionalContext) {
  const payload = additionalContext
    ? { hookSpecificOutput: { additionalContext } }
    : {};
  process.stdout.write(JSON.stringify(payload));
}

function isGitRepo(root) {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      cwd: root,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function quickHasCodeFiles(root) {
  // Count source files with a 10-file floor. Uses `git ls-files` when available
  // (fast, respects .gitignore). Capped at 50 files scanned for speed.
  try {
    const out = execSync(
      "git ls-files -z '*.ts' '*.tsx' '*.js' '*.jsx' '*.py' '*.go' '*.rs' '*.java' '*.cs' '*.cpp' '*.h' '*.svelte' | head -c 20000",
      { cwd: root, encoding: "utf-8" },
    );
    const count = out.split("\0").filter(Boolean).length;
    return count >= 10;
  } catch {
    return false;
  }
}

function smokeCheckDb(config) {
  const dbPath = config.dbPath ?? ".claude/code-rag.db";
  const abs = join(cwd, dbPath);
  if (!existsSync(abs)) {
    return { ok: false, reason: "DB 파일이 없습니다. /rag-init 또는 /rag-reindex 실행을 권장합니다." };
  }
  try {
    const st = statSync(abs);
    if (st.size < 8192) {
      return { ok: false, reason: "DB가 비어 있거나 손상된 것으로 보입니다. /rag-doctor를 실행하세요." };
    }
  } catch {
    return { ok: false, reason: "DB 상태 확인 실패. /rag-doctor를 실행하세요." };
  }
  return { ok: true };
}

function main() {
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      const check = smokeCheckDb(cfg);
      if (!check.ok) {
        emit(`[cc-advanced-rag] ${check.reason}`);
        return;
      }
      emit("[cc-advanced-rag] 인덱스 준비됨. search_code 툴이 Read/Grep보다 먼저 사용됩니다.");
      return;
    } catch (err) {
      emit(`[cc-advanced-rag] config 파싱 실패: ${err.message}. /rag-doctor로 진단하세요.`);
      return;
    }
  }

  // No config yet — consider bootstrap nudge.
  if (isGitRepo(cwd) && quickHasCodeFiles(cwd)) {
    emit(
      "[MAGIC KEYWORD: rag-bootstrap] 이 레포에는 지원 언어 코드가 충분합니다. " +
        "rag-bootstrap 스킬을 실행해 RAG 활성화 여부를 확인하세요 (1회성 질문 후 자동 구성).",
    );
    return;
  }

  emit(null);
}

try {
  main();
} catch (err) {
  process.stderr.write(`[cc-advanced-rag session-start] ${err.message ?? err}\n`);
  process.stdout.write("{}");
}
