#!/usr/bin/env bash
# Reset the cc-advanced-rag index by removing the DB files and log.
# The config and git hook are left in place (run setup.sh again to rebuild).

set -euo pipefail
PROJECT_ROOT="${1:-$PWD}"

echo "[reset] project=${PROJECT_ROOT}"

for f in code-rag.db code-rag.db-wal code-rag.db-shm code-rag.log code-rag.lock; do
  path="${PROJECT_ROOT}/.claude/${f}"
  if [ -e "${path}" ]; then
    rm -f "${path}"
    echo "[reset] removed ${path}"
  fi
done

echo "[reset] done. Reindex with:"
echo "  bun <plugin>/scripts/index.ts --full"
