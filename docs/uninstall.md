# Uninstalling cc-advanced-rag

Removing the plugin itself via `claude plugin remove cc-advanced-rag` stops Claude from invoking the hooks, skills, commands, and MCP server. The on-disk artifacts below are **not** cleaned up automatically — remove them at your discretion.

## Checklist

1. **Plugin removal**
   ```bash
   claude plugin remove cc-advanced-rag
   ```

2. **Project DB / log / lock files** (per project that used the plugin)
   ```bash
   rm -f .claude/code-rag.db .claude/code-rag.db-wal .claude/code-rag.db-shm
   rm -f .claude/code-rag.log .claude/code-rag.lock
   rm -f .claude/code-rag.db.corrupted-*
   ```

3. **Config** (if you want a fully clean state)
   ```bash
   rm -f .claude/code-rag.config.json
   ```

4. **Git post-commit hook block** — the installer uses chain-call markers so you can remove only its block:
   ```bash
   awk '
     /# BEGIN cc-advanced-rag post-commit/ { skip=1 }
     !skip
     /# END cc-advanced-rag post-commit/ { skip=0; next }
   ' .git/hooks/post-commit > .git/hooks/post-commit.tmp
   mv .git/hooks/post-commit.tmp .git/hooks/post-commit
   chmod +x .git/hooks/post-commit
   ```
   If the hook becomes empty (the plugin was the sole content), you can delete it entirely.

5. **`.gitignore` block** — remove the managed block between the marker and the file artifacts:
   ```bash
   sed -i.bak '/# cc-advanced-rag — plugin artifacts/,/^\/.claude\/code-rag\.lock$/d' .gitignore
   rm -f .gitignore.bak
   ```

6. **Environment variables** — only if you stored provider keys exclusively for this plugin:
   - `VOYAGE_API_KEY`
   - `OPENAI_API_KEY`
   - `OLLAMA_BASE_URL`

   These are usually shared with other tools; remove only what you're sure is cc-advanced-rag-specific.

7. **Plugin data directory** (debounce state, caches under `$CLAUDE_PLUGIN_DATA`)
   ```bash
   rm -rf .claude/.cc-advanced-rag
   ```

## Sanity check

```bash
grep -r "cc-advanced-rag" .claude .git/hooks .gitignore 2>/dev/null
```

No output means the project is fully clean.

## Reinstalling later

All steps above are non-destructive to your source code. If you reinstall the plugin:

```bash
claude plugin add --from https://github.com/hayan89/cc-advanced-rag
```

the `rag-bootstrap` skill will detect the absent config on the next session and re-run setup from scratch.
