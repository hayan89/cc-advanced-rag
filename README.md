# cc-advanced-rag

Zero-infra code search RAG plugin for Claude Code.

> Placeholder README. Full documentation (Component Roles, installation, usage, troubleshooting) is added in Step 13 of the implementation plan.

## Highlights

- **Zero infra** — SQLite + `sqlite-vec` embedded. No Docker, no external vector DB.
- **Hybrid search** — Dense vectors + BM25 (FTS5), fused with RRF.
- **Multi-provider embeddings** — Voyage (default), Ollama (local fallback), OpenAI.
- **Multi-language** — tree-sitter parsers for Go, TypeScript/TSX/JSX, Python, Rust, Java, C/C++, C#, Svelte.
- **Auto-bootstrap** — Plugin hooks auto-register on install; first time you open a project, a skill asks once then sets everything up.
- **Incremental** — git post-commit hook auto-reindexes changed files.

## Installation

```bash
claude plugin add --from https://github.com/hayan89/cc-advanced-rag
```

## Status

Under active development. See the implementation plan at `/home/hyunseung/.claude/plans/replicated-frolicking-giraffe.md`.

## License

MIT
