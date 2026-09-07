# RAG Plugin Guide

Shared defaults: `/home/hyunseung/AGENTS.md`.

- Use `README.md`, `package.json`, and `src/config/schema.ts` for interfaces/configuration. Keep tools, hooks, skills, and plugin metadata consistent.
- External embedding providers receive source-derived content. Honor the user's approved provider/privacy scope; do not run setup, indexing, or the server for documentation validation.
- Protect keys, indexed content, and generated databases; preserve exclusions and symlink boundaries. Use fixtures or disposable projects for tests.
- Run `bun test` for behavior changes and `bun run typecheck` for TypeScript changes. Documentation-only work needs path checks and `git diff --check`.
- Preserve unrelated changes and use task branches with PRs into `master`.
