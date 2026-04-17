-- Migration 0001: initial schema
-- Content is identical to src/db/schema.sql (kept in sync).
-- Applied when schema_version < 1.

-- See src/db/schema.sql for the full DDL. client.ts runs schema.sql
-- on first initialization; migrations/*.sql are only used for upgrades.

-- (intentionally minimal — v1 is the baseline)
