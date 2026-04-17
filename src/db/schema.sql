-- cc-advanced-rag SQLite schema
-- Requires sqlite-vec extension loaded by the client before this runs.
-- The `chunks_vec` virtual table is created programmatically by client.ts
-- because its dimension depends on config.embedding.dimension.

-- ────────────────────────────────────────────────
-- Schema version for migrations
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);
INSERT OR IGNORE INTO schema_version (version) VALUES (1);

-- ────────────────────────────────────────────────
-- Meta key-value (stored_dimension, etc.)
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ────────────────────────────────────────────────
-- 1. Code chunks (main table)
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chunks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path       TEXT NOT NULL,
  file_hash       TEXT NOT NULL,
  chunk_type      TEXT NOT NULL,
  symbol_name     TEXT,
  receiver_type   TEXT,
  signature       TEXT,
  package_name    TEXT,
  language        TEXT NOT NULL,
  scope           TEXT,
  start_line      INTEGER NOT NULL,
  end_line        INTEGER NOT NULL,
  content         TEXT NOT NULL,
  doc_comment     TEXT,
  imports_json    TEXT,
  tags_json       TEXT,
  indexed_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(file_path, symbol_name, chunk_type, start_line)
);

CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path);
CREATE INDEX IF NOT EXISTS idx_chunks_symbol ON chunks(symbol_name) WHERE symbol_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chunks_scope ON chunks(scope);
CREATE INDEX IF NOT EXISTS idx_chunks_language ON chunks(language);

-- ────────────────────────────────────────────────
-- 2. FTS5 index for BM25 (rowid-linked to chunks.id)
-- ────────────────────────────────────────────────
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  signature,
  symbol_name,
  content,
  content='chunks',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- FTS5 sync triggers
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, signature, symbol_name, content)
  VALUES (new.id, new.signature, new.symbol_name, new.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, signature, symbol_name, content)
  VALUES ('delete', old.id, old.signature, old.symbol_name, old.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, signature, symbol_name, content)
  VALUES ('delete', old.id, old.signature, old.symbol_name, old.content);
  INSERT INTO chunks_fts(rowid, signature, symbol_name, content)
  VALUES (new.id, new.signature, new.symbol_name, new.content);
END;

-- Also remove the embedding row from chunks_vec when a chunk is deleted
-- (the client's transactional API ensures inserts/updates keep them in sync).
CREATE TRIGGER IF NOT EXISTS chunks_vec_ad AFTER DELETE ON chunks BEGIN
  DELETE FROM chunks_vec WHERE rowid = old.id;
END;

-- ────────────────────────────────────────────────
-- 3. File metadata
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS files (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path       TEXT NOT NULL UNIQUE,
  file_hash       TEXT NOT NULL,
  language        TEXT NOT NULL,
  scope           TEXT,
  line_count      INTEGER NOT NULL,
  chunk_count     INTEGER NOT NULL,
  imports_json    TEXT,
  symbols_json    TEXT,
  last_indexed_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_files_hash ON files(file_hash);
CREATE INDEX IF NOT EXISTS idx_files_scope ON files(scope);

-- ────────────────────────────────────────────────
-- 4. Incremental indexing ledger (git blob SHA + AST hash)
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS index_ledger (
  file_path       TEXT PRIMARY KEY,
  blob_sha        TEXT NOT NULL,
  signature_hash  TEXT NOT NULL,
  chunk_count     INTEGER NOT NULL,
  indexed_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ────────────────────────────────────────────────
-- 5. L1 exact match cache (query_hash + git HEAD bound)
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS exact_cache (
  query_hash      TEXT PRIMARY KEY,
  query_text      TEXT NOT NULL,
  result_json     TEXT NOT NULL,
  git_head_sha    TEXT NOT NULL,
  hit_count       INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ecache_expires ON exact_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_ecache_git_head ON exact_cache(git_head_sha);
