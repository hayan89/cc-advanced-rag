-- Migration v3 → v4: add weight column to chunk_tags for cross-stack scoring.
-- `resource:*` tags carry higher weight than structural tags so that cross-stack
-- references (backend handler ↔ frontend route) rank above mere bucket overlap.
--
-- SQLite has no native `ADD COLUMN IF NOT EXISTS`, so the caller wraps this in a
-- try/catch that swallows `duplicate column name` on re-run (matches the v3
-- ALTER on index_ledger). The added column is NOT NULL with DEFAULT 1, so
-- existing rows retain the legacy `COUNT(tag)` semantics.
ALTER TABLE chunk_tags ADD COLUMN weight INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_chunk_tags_tag_weight ON chunk_tags(tag, weight DESC);
