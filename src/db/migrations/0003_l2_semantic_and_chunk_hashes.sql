-- Migration v2 → v3:
--   1. Add semantic_cache table (query embedding + results, git HEAD bound).
--   2. Extend index_ledger with per-chunk signature hashes for chunk-level diff.
-- Idempotent via IF NOT EXISTS and a guarded PRAGMA-style ALTER.

CREATE TABLE IF NOT EXISTS semantic_cache (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  query_text      TEXT NOT NULL,
  result_json     TEXT NOT NULL,
  git_head_sha    TEXT NOT NULL,
  scope           TEXT,
  mode            TEXT NOT NULL,
  limit_n         INTEGER NOT NULL,
  hit_count       INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scache_git_head ON semantic_cache(git_head_sha);
CREATE INDEX IF NOT EXISTS idx_scache_expires ON semantic_cache(expires_at);

-- ALTER TABLE ADD COLUMN is safe when the column is absent. SQLite has no
-- native `ADD COLUMN IF NOT EXISTS`, so this migration assumes it runs exactly
-- once per DB (guarded by schema_version). The column is nullable:
--   NULL   → legacy row (v2 and earlier): chunk-level diff will fall back to
--            reconstructing from the chunks table on next incremental.
--   '[]'   → file parsed to zero chunks (empty/invalid).
--   '[...]' → JSON array of {key, sig} entries, key = "<type>:<symbol>:<startLine>".
ALTER TABLE index_ledger ADD COLUMN chunk_hashes_json TEXT;
