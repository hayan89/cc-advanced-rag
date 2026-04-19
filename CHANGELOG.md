# Changelog

All notable changes are tracked in this file. This project loosely follows
[Semantic Versioning](https://semver.org/).

> **Upgrade note** — After upgrading across a `schema_version` bump, run
> `/cc-advanced-rag:rebuild` (or `bun <plugin>/scripts/index.ts --full`) so
> previously-indexed chunks pick up new tags.

## Unreleased

### Added

- **Cross-stack resource matching.** The indexer now auto-derives
  `resource:<kebab-name>` tags from file paths and symbol names, normalizing
  snake/camel/Pascal/kebab spellings to a single canonical form. A Go
  `ReceiptUploadHandler` at `backend/api/handlers/receipt_upload.go` and its
  SvelteKit counterpart `frontend/src/routes/receipt-upload/+page.svelte` now
  surface as strong matches in `get_related`.
- **Weighted `get_related` scoring.** `chunk_tags` gained a `weight` column.
  `resource:*` tags default to weight 3; structural tags (`handlers`, `api`,
  `function`, …) stay at 1. Candidates sort by `SUM(weight)` instead of raw
  overlap count.
- **`resourceOnly` strict mode.** `get_related(..., resourceOnly: true)`
  restricts both the reference and candidate side to `resource:*` tags for
  uncompromised cross-stack navigation; returns a dedicated message when the
  reference carries no resource tag.
- **`tagging.resourceExtractor` config block.** Fields: `enabled` (default
  `true`), `resourceWeight` (1–10, default 3), `stopwords`, `includePaths`,
  `excludePaths`. Glob support covers `*` (single segment) and `**` (any
  depth, including zero-prefix).
- `src/tagging/case-normalize.ts` and `src/tagging/resource-extractor.ts` as
  reusable, pure modules. `src/indexer/cross-stack.e2e.test.ts` locks in the
  tb-ocr regression (Go + Svelte + TS).

### Changed

- Schema upgraded to **v4**. The migration adds `chunk_tags.weight INTEGER
  NOT NULL DEFAULT 1` and an `(tag, weight DESC)` index; `schema.sql` is kept
  in lockstep so fresh DBs match migrated ones. Duplicate-column errors on
  re-run are swallowed (matches the v3 pattern).
- `src/tagging/resource-tags.ts` renamed to **`src/tagging/custom-tags.ts`**.
  The file never contained "resource" semantics — it compiles the
  user-supplied `customTags` regex rules — and the old name collided with the
  new resource extractor. Callers and tests updated.

### Breaking

- `get_related` output text now emits `score=<n>` instead of `overlap=<n>`.
  External parsers should update their regex. The value itself is a weighted
  sum, so it is not directly comparable to pre-v4 overlap counts.
