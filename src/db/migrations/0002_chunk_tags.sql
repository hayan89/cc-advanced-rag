-- Migration v1 → v2: add normalized chunk_tags table + index
-- Idempotent via IF NOT EXISTS so it is safe to re-run.

CREATE TABLE IF NOT EXISTS chunk_tags (
  chunk_id  INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  tag       TEXT NOT NULL,
  PRIMARY KEY (chunk_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_chunk_tags_tag ON chunk_tags(tag);
