# CC Advanced RAG Repository Guide

## Scope And Sources Of Truth

- This is a Bun and TypeScript Claude Code plugin for local SQLite and `sqlite-vec` code search with configurable embedding providers.
- Use `README.md` and `package.json` for supported commands, `src/config/schema.ts` for configuration contracts, and `skills/rag-bootstrap/references/config-schema.md` for operator-facing configuration guidance.
- Keep MCP tools, commands, hooks, skills, templates, and `.claude-plugin` metadata aligned when public behavior changes.

## Privacy And Safety

- Indexing with Voyage or OpenAI sends source-derived content to an external embedding provider. Require an explicit privacy and provider decision before setup, indexing, reindexing, or server execution against user code.
- Reuse a provider and privacy decision already established for the same task and stay within its approved scope; do not request it again or broaden it silently.
- Do not run `setup`, `index`, `index:incremental`, `index:full`, or `server` merely to validate documentation. These commands can create databases, install hooks, modify project settings, or transmit content.
- Never commit or print `.env` values, API keys, generated databases, logs, locks, or indexed source content. Respect `.gitignore`, configured exclusions, file-size limits, and the default no-symlink-following boundary.
- Preserve unrelated changes and fix parser, indexing, and search behavior generally rather than special-casing known repositories or fixtures.

## Validation

- Run `bun test` for behavior changes and `bun run typecheck` for TypeScript changes.
- Use fixture or temporary-project tests for bootstrap and indexing changes; do not use a user's live codebase as test input without authorization.
- For documentation-only changes, verify referenced paths, scripts, config fields, and privacy statements, then run `git diff --check`.

## Model-Based Work Delegation

- When the main agent runs on the designated highest-tier model
  (currently GPT-6 Astra), reserve its work for planning, analysis,
  review, debugging/root-cause diagnosis, architecture, design,
  coordination, and final acceptance.
- Delegate all other execution work—including implementation,
  file edits, refactoring, test creation/execution, builds, and
  routine operational commands—to sub-agents using the designated
  second-tier model: currently gpt-5.6-sol with xhigh reasoning.
- Explicitly select the worker model and reasoning effort.
  Do not let workers inherit the highest-tier model by default.
- Give each worker clear scope, file ownership, acceptance criteria,
  and required verification. Provide only the context it needs.
- The main agent must review the resulting diff and verification
  evidence before declaring completion. Delegate review fixes back
  to the worker; do not duplicate the implementation.
- Reuse workers for related tasks. Parallelize only independent work.
  Workers must preserve other agents' and users' changes.
- Treat these model names as the configured role mapping, not as
  an inferred live price ranking. Do not silently substitute models.
- If delegation or the designated worker model is unavailable,
  report the limitation instead of silently doing execution work
  on the highest-tier model.
- Follow higher-priority instructions and existing authorization
  boundaries; delegation does not expand permission.
