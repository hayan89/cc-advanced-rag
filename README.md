# cc-advanced-rag

Zero-infra code search RAG plugin for Claude Code.

- **Zero infra** — SQLite + `sqlite-vec` embedded. No Docker, no external vector DB.
- **Hybrid search** — Dense vectors + BM25 (FTS5), fused with RRF.
- **Multi-provider embeddings** — Voyage (default), Ollama (local fallback), OpenAI.
- **Multi-language** — tree-sitter parsers for Go, TypeScript/TSX/JSX, Python, Rust, Java, C/C++, C#, Svelte.
- **Auto-bootstrap** — Plugin hooks auto-register on install; the `rag-bootstrap` skill asks once then configures everything.
- **Incremental** — git `post-commit` hook re-indexes only changed files.

## Installation

```bash
claude plugin add --from https://github.com/hayan89/cc-advanced-rag
```

The next session opens Claude in a project with supported-language files will nudge you via the `rag-bootstrap` skill. Answer the privacy question and the plugin generates the config, initializes the SQLite DB, installs the git hook, appends `.gitignore` entries, pre-warms parsers, and kicks off the initial indexing.

If anything fails or you want to re-run setup manually:

```bash
bash <plugin>/scripts/setup.sh
bun <plugin>/scripts/index.ts --full
```

## Component Roles

cc-advanced-rag is NOT a single process. It is four cooperating layers that
Claude Code orchestrates:

```
┌──────────────────────────────────────────────────────────────┐
│  Claude Code (the user's session)                            │
│  ┌────────┐   ┌──────────┐   ┌──────────┐   ┌────────────┐   │
│  │Commands│   │  Skills  │   │  Hooks   │   │ MCP server │   │
│  └───┬────┘   └────┬─────┘   └────┬─────┘   └─────┬──────┘   │
│      │             │              │                │           │
│      │   manual    │  "how / when │  auto-trigger  │ actual    │
│      │   entry     │   to use it" │  nudges        │ search    │
│      ▼             ▼              ▼                ▼           │
└──────┴─────────────┴──────────────┴────────────────┴───────────┘
          │                                           │
          └─── talks to ──── cc-advanced-rag  ◀───────┘
                             SQLite + sqlite-vec + FTS5
                             (embedded, on disk)
```

| Layer | Files | Purpose |
|---|---|---|
| **MCP server** | `server.ts`, `src/tools/*.ts` | The actual search engine. Runs as a stdio MCP subprocess. Exposes 6 tools: `search_code`, `lookup_file`, `search_symbol`, `get_related`, `index_status`, `rebuild_index`. |
| **Skills** | `skills/*/SKILL.md` + `scripts/` + `references/` | Tell Claude **when** and **how** to use the tools. `code-search` raises the priority of `search_code` over Read/Grep; `rag-bootstrap` orchestrates first-time setup. |
| **Hooks** | `hooks/hooks.json`, `session-start.mjs`, `post-tool-use.mjs` | Automatic triggers, no manual invocation. `SessionStart` checks DB health; `PostToolUse` nudges `search_code` when Claude reads a code file and auto-invokes the bootstrap skill if the project is un-initialized. |
| **Commands** | `commands/rag-*.md` | Manual entry points. `/rag-init`, `/rag-reindex`, `/rag-status`, `/rag-doctor`. Useful for recovery or explicit actions the user wants to take. |

### Why four layers?

- **Separation of concerns**: the MCP server knows nothing about when Claude should use it — that's the Skill's job. The Skill does not trigger itself — that's a Hook. Users who want full control bypass the Hook and go through a Command.
- **Progressive disclosure**: each Skill is a folder (`SKILL.md` + `scripts/` + `references/`). Claude loads the 3-sentence description first, then pulls in procedures, gotchas, or scripts as needed.
- **Plugin permissions**: `plugin.json` declares `mcp__cc-advanced-rag__*` so the six MCP tools are auto-allowed; users aren't prompted on every call.

## Tools

- `search_code(query, limit?, scope?, mode?)` — hybrid semantic+BM25 search. Always prefer over Read/Grep for discovery.
- `lookup_file(filePath, limit?)` — full set of chunks for a file (structure at a glance).
- `search_symbol(name, exact?, language?, limit?)` — name-based symbol lookup.
- `get_related(filePath|chunkId, limit?)` — related code via shared tags (cross-stack navigation).
- `index_status()` — chunks/files/language breakdown, dimension, cache stats.
- `rebuild_index({scope?, since?, full?, async?})` — returns the command to run out-of-process.

## Configuration

`<project>/.claude/code-rag.config.json`:

```json
{
  "$schema": "https://github.com/hayan89/cc-advanced-rag/raw/main/templates/code-rag.config.schema.json",
  "embedding": { "provider": "voyage", "model": "voyage-code-3", "dimension": 1024, "privacyMode": false },
  "languages": ["typescript", "tsx", "python"],
  "gitignoreRespect": true,
  "exclude": ["node_modules/**", "vendor/**"],
  "tagging": { "customTags": [{ "name": "receipt", "regex": "[Rr]eceipt" }] },
  "cache": { "l1TtlHours": 24 }
}
```

API keys live in `.env` only — never commit them. Supported: `VOYAGE_API_KEY`, `OPENAI_API_KEY`, `OLLAMA_BASE_URL`.

Detailed field reference: [`skills/rag-bootstrap/references/config-schema.md`](skills/rag-bootstrap/references/config-schema.md).

## Performance targets

| Metric | Target | Notes |
|---|---|---|
| Query p95 | < 1s | 10k chunks, L1 miss, hybrid mode |
| L1 cache hit | < 50ms | Same query + git HEAD |
| Initial indexing | ≤ 10 min | 10k files, Voyage API |
| Index size | ≈ 80MB | 10k chunks (60MB vec + 20MB text/FTS) |

## Troubleshooting

- `DimensionMismatchError`: provider/model changed. Run `bun <plugin>/scripts/index.ts --full`.
- `sqlite-vec` load failure: run `/rag-doctor`. It usually resolves with `SQLITE3_VEC_PREBUILT=0 SQLITE3_VEC_POSTINSTALL=1 bun install`.
- DB corruption: `/rag-doctor --fix` quarantines the DB as `*.corrupted-<ts>` and prints a rebuild command.
- Multi-worktree drift: `/rag-doctor` detects secondary worktrees; run each worktree with its own `dbPath`.

## Uninstall

See [`docs/uninstall.md`](docs/uninstall.md) for a full checklist (DB files, log, lock, git hook block, `.gitignore` lines, config).

## License

MIT
