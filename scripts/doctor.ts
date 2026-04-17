#!/usr/bin/env bun
// cc-advanced-rag diagnostics.
//
// Usage:
//   bun <plugin>/scripts/doctor.ts [--root=<path>] [--config=<path>] [--fix]
//
// Output is a checklist of ✅ / ⚠️ / ❌ per category. `--fix` attempts safe
// remediations (git hook reinstall, .gitignore append, WAL checkpoint on DB
// integrity failure, corrupted-DB quarantine).

import { existsSync, renameSync, statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { loadConfig, ConfigError } from "../src/config/loader.ts";
import { defaultConfig, DEFAULT_CONFIG_PATH } from "../src/config/defaults.ts";
import { ensureGitignoreEntries } from "../src/bootstrap/gitignore-append.ts";
import { installPostCommitHook, findHooksDir } from "../src/bootstrap/install-git-hook.ts";

type Status = "ok" | "warn" | "fail";

interface Check {
  label: string;
  status: Status;
  detail?: string;
}

function mark(status: Status): string {
  return status === "ok" ? "✅" : status === "warn" ? "⚠️" : "❌";
}

interface Args {
  root: string;
  configPath: string;
  fix: boolean;
  pluginRoot: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    root: process.cwd(),
    configPath: "",
    fix: false,
    pluginRoot: resolve(import.meta.dir, ".."),
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--fix") args.fix = true;
    else if (arg.startsWith("--root=")) args.root = resolve(arg.slice("--root=".length));
    else if (arg.startsWith("--config=")) args.configPath = resolve(arg.slice("--config=".length));
  }
  args.configPath ||= resolve(args.root, DEFAULT_CONFIG_PATH);
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  console.error(`[doctor] project=${args.root}`);
  console.error(`[doctor] plugin=${args.pluginRoot}`);

  const checks: Check[] = [];

  checks.push(checkRuntime());
  checks.push(checkSqliteVec());

  const { config, configCheck } = loadConfigSafely(args.configPath);
  checks.push(configCheck);

  if (config) {
    checks.push(checkSecrets(config));
    const dbCheck = await checkDb(args.root, config, args.fix);
    checks.push(...dbCheck);
    checks.push(checkIndexFreshness(args.root, config));
    checks.push(checkWorktree(args.root));
    checks.push(checkGitHook(args.root, args.pluginRoot, args.fix));
    checks.push(checkGitignore(args.root, args.fix));
    checks.push(checkLog(args.root, config));
  }

  // Render report.
  console.log(`# cc-advanced-rag /rag-doctor report`);
  for (const c of checks) {
    console.log(`${mark(c.status)} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  const failed = checks.some((c) => c.status === "fail");
  if (failed) process.exit(1);
}

// ── Checks ─────────────────────────────────────────────────────────────

function checkRuntime(): Check {
  try {
    const bunVersion = Bun.version;
    const nodeVersion = process.versions.node;
    return {
      label: `runtime: bun=${bunVersion} node=${nodeVersion}`,
      status: "ok",
    };
  } catch (err) {
    return { label: "runtime", status: "fail", detail: String(err) };
  }
}

function checkSqliteVec(): Check {
  try {
    const db = new Database(":memory:");
    db.loadExtension(sqliteVec.getLoadablePath());
    const row = db.query<{ v: string }, []>("SELECT vec_version() AS v").get();
    db.close();
    return { label: `sqlite-vec: ${row?.v ?? "(?)"}`, status: "ok" };
  } catch (err) {
    return {
      label: "sqlite-vec load",
      status: "fail",
      detail: `${(err as Error).message}. Try SQLITE3_VEC_PREBUILT=0 SQLITE3_VEC_POSTINSTALL=1 bun install.`,
    };
  }
}

function loadConfigSafely(path: string): {
  config: ReturnType<typeof defaultConfig> | null;
  configCheck: Check;
} {
  if (!existsSync(path)) {
    return {
      config: null,
      configCheck: {
        label: `config: missing (${path})`,
        status: "warn",
        detail: "Run /rag-init to create it.",
      },
    };
  }
  try {
    const cfg = loadConfig(path);
    return {
      config: cfg,
      configCheck: { label: `config: ok (${path})`, status: "ok" },
    };
  } catch (err) {
    return {
      config: null,
      configCheck: {
        label: "config: invalid",
        status: "fail",
        detail: err instanceof ConfigError ? err.message : String(err),
      },
    };
  }
}

function checkSecrets(config: ReturnType<typeof defaultConfig>): Check {
  const p = config.embedding.provider;
  if (p === "voyage") {
    if (process.env.VOYAGE_API_KEY) return { label: "secrets: VOYAGE_API_KEY set", status: "ok" };
    return { label: "secrets: VOYAGE_API_KEY missing", status: "fail", detail: "Set in .env or shell." };
  }
  if (p === "openai") {
    if (process.env.OPENAI_API_KEY) return { label: "secrets: OPENAI_API_KEY set", status: "ok" };
    return { label: "secrets: OPENAI_API_KEY missing", status: "fail" };
  }
  if (p === "ollama") {
    const base = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
    return {
      label: `secrets: ollama at ${base}`,
      status: "warn",
      detail: "Ensure the ollama server is running. No reachability probe performed here.",
    };
  }
  return { label: `secrets: unknown provider ${p as string}`, status: "fail" };
}

async function checkDb(
  root: string,
  config: ReturnType<typeof defaultConfig>,
  fix: boolean,
): Promise<Check[]> {
  const dbPath = resolve(root, config.dbPath);
  if (!existsSync(dbPath)) {
    return [
      {
        label: `db file missing: ${dbPath}`,
        status: "warn",
        detail: "Run `bun <plugin>/scripts/setup.sh` then index.",
      },
    ];
  }

  const db = new Database(dbPath);
  db.loadExtension(sqliteVec.getLoadablePath());
  const checks: Check[] = [];
  try {
    const integ = db
      .query<{ integrity_check: string }, []>(`PRAGMA integrity_check`)
      .all()
      .map((r) => r.integrity_check);
    const ok = integ.length === 1 && integ[0] === "ok";
    checks.push({
      label: `db integrity_check`,
      status: ok ? "ok" : "fail",
      detail: ok ? undefined : integ.join("; "),
    });
    if (!ok && fix) {
      db.close();
      const quarantined = quarantineCorruptDb(dbPath);
      checks.push({
        label: `db quarantined`,
        status: "warn",
        detail: `moved to ${quarantined}. Run \`bun <plugin>/scripts/index.ts --full\` to rebuild.`,
      });
      return checks;
    }

    const schemaVersion =
      db.query<{ v: number | null }, []>(`SELECT MAX(version) AS v FROM schema_version`).get()?.v ??
      0;
    checks.push({ label: `schema_version=${schemaVersion}`, status: schemaVersion >= 2 ? "ok" : "warn" });

    const dimRow = db
      .query<{ value: string }, [string]>(`SELECT value FROM meta WHERE key = ?`)
      .get("stored_dimension");
    if (!dimRow) {
      checks.push({ label: "stored_dimension: unknown", status: "warn" });
    } else if (Number(dimRow.value) !== config.embedding.dimension) {
      checks.push({
        label: `dimension mismatch stored=${dimRow.value} config=${config.embedding.dimension}`,
        status: "fail",
        detail: "Run `bun <plugin>/scripts/index.ts --full` after adjusting provider/model.",
      });
    } else {
      checks.push({ label: `dimension=${dimRow.value}`, status: "ok" });
    }
  } finally {
    try {
      db.close();
    } catch {
      /* already closed after quarantine */
    }
  }
  return checks;
}

function quarantineCorruptDb(dbPath: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const dest = `${dbPath}.corrupted-${ts}`;
  renameSync(dbPath, dest);
  for (const suffix of ["-wal", "-shm"]) {
    const aux = `${dbPath}${suffix}`;
    if (existsSync(aux)) renameSync(aux, `${dest}${suffix}`);
  }
  return dest;
}

function checkIndexFreshness(root: string, config: ReturnType<typeof defaultConfig>): Check {
  const dbPath = resolve(root, config.dbPath);
  if (!existsSync(dbPath)) return { label: "index freshness: n/a (db missing)", status: "warn" };
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .query<{ last: number | null }, []>(`SELECT MAX(last_indexed_at) AS last FROM files`)
      .get();
    db.close();
    const last = row?.last ?? 0;
    if (!last) return { label: "index freshness: never indexed", status: "warn" };
    const age = Date.now() / 1000 - last;
    const hours = Math.round(age / 3600);
    return {
      label: `last indexing ${hours}h ago`,
      status: hours > 72 ? "warn" : "ok",
    };
  } catch (err) {
    return { label: "index freshness", status: "fail", detail: String(err) };
  }
}

function checkWorktree(root: string): Check {
  try {
    const gitDir = execSync("git rev-parse --git-dir", { cwd: root, encoding: "utf-8" }).trim();
    const commonDir = execSync("git rev-parse --git-common-dir", {
      cwd: root,
      encoding: "utf-8",
    }).trim();
    if (gitDir !== commonDir) {
      return {
        label: "worktree: secondary",
        status: "warn",
        detail: "Sharing `.claude/code-rag.db` across worktrees can cause ledger/L1 drift. Consider a per-worktree dbPath.",
      };
    }
    return { label: "worktree: primary", status: "ok" };
  } catch {
    return { label: "worktree: not a git repo", status: "warn" };
  }
}

function checkGitHook(root: string, pluginRoot: string, fix: boolean): Check {
  const hooksDir = findHooksDir(root);
  if (!hooksDir) return { label: "git hook: not a git repo", status: "warn" };
  const hookPath = resolve(hooksDir, "post-commit");
  if (existsSync(hookPath)) {
    const content = readFileSync(hookPath, "utf-8");
    if (content.includes("cc-advanced-rag")) return { label: "git hook: installed", status: "ok" };
    if (fix) {
      const r = installPostCommitHook(root, pluginRoot);
      return { label: `git hook: ${r.action}`, status: "ok" };
    }
    return {
      label: "git hook: managed block missing",
      status: "warn",
      detail: "Run with --fix to re-install.",
    };
  }
  if (fix) {
    const r = installPostCommitHook(root, pluginRoot);
    return { label: `git hook: ${r.action}`, status: "ok" };
  }
  return { label: "git hook: absent", status: "warn", detail: "Run with --fix to install." };
}

function checkGitignore(root: string, fix: boolean): Check {
  const path = resolve(root, ".gitignore");
  const present =
    existsSync(path) && readFileSync(path, "utf-8").includes("cc-advanced-rag");
  if (present) return { label: ".gitignore block: present", status: "ok" };
  if (fix) {
    const r = ensureGitignoreEntries(root);
    return { label: `.gitignore block: ${r.action}`, status: "ok" };
  }
  return {
    label: ".gitignore block: missing",
    status: "warn",
    detail: "Run with --fix to append the safety block.",
  };
}

function checkLog(root: string, config: ReturnType<typeof defaultConfig>): Check {
  const logPath = resolve(root, config.logPath);
  if (!existsSync(logPath)) return { label: "log: absent (no errors yet)", status: "ok" };
  try {
    const size = statSync(logPath).size;
    return { label: `log: ${logPath} (${size}B)`, status: "ok" };
  } catch (err) {
    return { label: "log", status: "warn", detail: String(err) };
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[doctor] fatal: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  });
}
