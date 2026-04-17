#!/usr/bin/env bun
// Plugin indexer entry point.
//
// Usage:
//   bun <plugin>/scripts/index.ts [--full] [--since=<commit>] [--root=<path>] [--config=<path>]
//
// - `--full`: rebuild every tracked+supported file (use after provider/dimension change)
// - `--since=<commit>`: incremental based on `git diff --name-status <commit>..HEAD`
// - default: incremental based on ledger vs current git blob shas

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { loadConfig } from "../src/config/loader.ts";
import { defaultConfig, DEFAULT_CONFIG_PATH } from "../src/config/defaults.ts";
import { runIndex } from "../src/indexer/index.ts";

interface Args {
  mode: "full" | "incremental";
  since?: string;
  root: string;
  configPath: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: "incremental",
    root: process.cwd(),
    configPath: "",
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--full") args.mode = "full";
    else if (arg.startsWith("--since=")) args.since = arg.slice("--since=".length);
    else if (arg.startsWith("--root=")) args.root = resolve(arg.slice("--root=".length));
    else if (arg.startsWith("--config=")) args.configPath = resolve(arg.slice("--config=".length));
  }
  args.configPath ||= resolve(args.root, DEFAULT_CONFIG_PATH);
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const config = existsSync(args.configPath) ? loadConfig(args.configPath) : defaultConfig();

  console.error(
    `[index] mode=${args.mode}${args.since ? ` since=${args.since}` : ""} root=${args.root}`,
  );
  console.error(
    `[index] provider=${config.embedding.provider} model=${config.embedding.model} dim=${config.embedding.dimension}`,
  );

  const start = Date.now();
  const summary = await runIndex({
    projectRoot: args.root,
    config,
    mode: args.mode,
    since: args.since,
    onProgress: ({ processed, total, filePath }) => {
      if (processed % 25 === 0 || processed === total) {
        console.error(`[index] ${processed}/${total} ${filePath}`);
      }
    },
  });
  const elapsedMs = Date.now() - start;

  console.error(`[index] done in ${Math.round(elapsedMs / 100) / 10}s`);
  console.error(
    `[index] processed=${summary.filesProcessed} skipped=${summary.filesSkipped} ` +
      `deleted=${summary.filesDeleted} renamed=${summary.filesRenamed} ` +
      `chunks=${summary.chunksInserted} errors=${summary.errors.length}`,
  );
  if (summary.errors.length > 0) {
    for (const err of summary.errors.slice(0, 10)) {
      console.error(`[index] ERROR ${err.filePath}: ${err.message}`);
    }
    if (summary.errors.length > 10) {
      console.error(`[index] ...and ${summary.errors.length - 10} more errors`);
    }
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[index] fatal: ${err instanceof Error ? err.message : err}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(2);
  });
}
