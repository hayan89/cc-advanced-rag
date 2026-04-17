#!/usr/bin/env bash
# cc-advanced-rag setup — run once per project to initialize the DB,
# install the git post-commit hook, and append the safety .gitignore block.
#
# Usage:
#   bash <plugin>/scripts/setup.sh [project-root]
#
# The plugin root is inferred from this script's location. Project root
# defaults to $PWD.

set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_ROOT="${1:-$PWD}"

echo "[setup] plugin=${PLUGIN_ROOT}"
echo "[setup] project=${PROJECT_ROOT}"

if ! command -v bun >/dev/null 2>&1; then
  echo "[setup] ERROR: bun not found in PATH. Install Bun ≥ 1.2 first." >&2
  exit 2
fi

# 1. Install dependencies inside the plugin (idempotent).
if [ ! -d "${PLUGIN_ROOT}/node_modules" ]; then
  echo "[setup] installing plugin dependencies..."
  (cd "${PLUGIN_ROOT}" && bun install --silent) || {
    echo "[setup] bun install failed. Run /rag-doctor for diagnosis." >&2
    exit 3
  }
fi

# 2. sqlite-vec native load smoke test — fail fast if the prebuilt is missing.
echo "[setup] smoke-testing sqlite-vec native load..."
if ! bun --cwd "${PLUGIN_ROOT}" -e '
import { Database } from "bun:sqlite";
import * as vec from "sqlite-vec";
const db = new Database(":memory:");
db.loadExtension(vec.getLoadablePath());
const row = db.query("SELECT vec_version() AS v").get();
if (!row) {
  console.error("sqlite-vec loaded but vec_version() returned no row");
  process.exit(1);
}
console.error("[setup] sqlite-vec ok, version=" + row.v);
'; then
  echo "[setup] ERROR: sqlite-vec native load failed." >&2
  echo "[setup]   Try: SQLITE3_VEC_PREBUILT=0 SQLITE3_VEC_POSTINSTALL=1 bun install --cwd '${PLUGIN_ROOT}'" >&2
  echo "[setup]   Or run /rag-doctor for platform-specific guidance." >&2
  exit 4
fi

# 3. Create .claude directory and run bootstrap (config / gitignore / hook).
mkdir -p "${PROJECT_ROOT}/.claude"
echo "[setup] running bootstrap (gitignore + git hook) ..."
bun "${PLUGIN_ROOT}/skills/rag-bootstrap/scripts/run-bootstrap.ts" --root="${PROJECT_ROOT}"

# 4. Initialize DB (creates schema + chunks_vec). This is idempotent.
echo "[setup] initializing DB ..."
bun --cwd "${PLUGIN_ROOT}" -e "
import { loadConfig } from '${PLUGIN_ROOT}/src/config/loader.ts';
import { defaultConfig, DEFAULT_CONFIG_PATH } from '${PLUGIN_ROOT}/src/config/defaults.ts';
import { openClient } from '${PLUGIN_ROOT}/src/db/client.ts';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
const projectRoot = '${PROJECT_ROOT}';
const cfgPath = resolve(projectRoot, DEFAULT_CONFIG_PATH);
const cfg = existsSync(cfgPath) ? loadConfig(cfgPath) : defaultConfig();
const dbPath = resolve(projectRoot, cfg.dbPath);
const client = openClient({ dbPath, dimension: cfg.embedding.dimension });
const check = client.integrityCheck();
console.error('[setup] integrity_check=' + (check.ok ? 'ok' : check.messages.join(';')));
client.close();
"

echo "[setup] done. Run the indexer next:"
echo "  bun ${PLUGIN_ROOT}/scripts/index.ts --full"
