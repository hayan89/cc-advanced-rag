#!/usr/bin/env bun
// Thin entry script that merges the 6 cc-advanced-rag MCP tool ids into
// `<project>/.claude/settings.local.json` under `permissions.allow`.
//
// Usage:
//   bun ${CLAUDE_PLUGIN_ROOT}/scripts/merge-settings.ts <project-root>
//
// Exits non-zero on malformed settings.local.json (with original backed up to
// `*.bak-<ts>`); the caller (setup.sh / rag-bootstrap) should surface a
// `/rag-doctor` recovery hint.

import { resolve } from "node:path";
import { mergeSettings, MalformedSettingsError } from "../src/bootstrap/settings-merge.ts";

const root = resolve(process.argv[2] ?? process.cwd());

try {
  const result = mergeSettings(root);
  console.log(`[merge-settings] ${result.action}: ${result.path} (added=${result.added.length})`);
  process.exit(0);
} catch (err) {
  if (err instanceof MalformedSettingsError) {
    console.error(`[merge-settings] ERROR: ${err.message}`);
    process.exit(2);
  }
  console.error(
    `[merge-settings] ERROR: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
