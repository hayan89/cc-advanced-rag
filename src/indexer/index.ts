import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { openClient, acquireLock } from "../db/client.ts";
import type { Config } from "../config/schema.ts";
import { createEmbedder, type Embedder } from "./embedder.ts";
import { detectLanguage, parseFile, preWarmParsers } from "./parsers/registry.ts";
import type { ParseResult } from "./parsers/types.ts";
import { decide } from "./file-filter.ts";
import { loadIgnoreMatcher } from "../gitignore/loader.ts";
import { applyTagRules, compileTagRules, mergeTags } from "../tagging/resource-tags.ts";
import {
  getGitBlobShas,
  gitDiffSince,
  loadLedger,
  upsertLedgerEntry,
  garbageCollectFile,
  applyRename,
} from "./ledger.ts";

type Binding = string | number | bigint | boolean | null | Uint8Array;
type Bindings = Binding[];

export interface IndexOptions {
  projectRoot: string;
  config: Config;
  mode: "full" | "incremental";
  /** For incremental mode only: base commit-ish. Defaults to ledger. */
  since?: string;
  /** Optional progress callback invoked per processed file. */
  onProgress?: (progress: { processed: number; total: number; filePath: string }) => void;
  /** Override the embedder (testing / offline mocking). */
  embedder?: Embedder;
}

export interface IndexSummary {
  filesProcessed: number;
  filesSkipped: number;
  filesDeleted: number;
  filesRenamed: number;
  chunksInserted: number;
  errors: Array<{ filePath: string; message: string }>;
}

/**
 * Orchestrate a single indexing run end-to-end.
 *
 * Guarantees:
 * - Acquires the plugin's advisory file lock so concurrent runs don't
 *   corrupt the DB.
 * - Each file is persisted in its own SQLite transaction → a mid-run crash
 *   leaves the ledger consistent, and restarting skips files whose blob sha
 *   already matches the ledger.
 * - A file whose parse/embed/write fails is logged and skipped; the rest
 *   still commit.
 * - WASM parser load failures are handled by `registry.ts` (language
 *   disabled on first error, rest continue).
 */
export async function runIndex(opts: IndexOptions): Promise<IndexSummary> {
  const { projectRoot, config, mode } = opts;
  const summary: IndexSummary = {
    filesProcessed: 0,
    filesSkipped: 0,
    filesDeleted: 0,
    filesRenamed: 0,
    chunksInserted: 0,
    errors: [],
  };

  const dbPath = resolve(projectRoot, config.dbPath);
  const client = openClient({ dbPath, dimension: config.embedding.dimension });
  const lock = acquireLock(resolve(projectRoot, config.lockPath));

  try {
    const embedder = opts.embedder ?? createEmbedder(config.embedding);
    await embedder.healthCheck();
    await preWarmParsers(config.languages, { warn: (m) => console.error(`[pre-warm] ${m}`) });

    const matcher = loadIgnoreMatcher({
      projectRoot,
      respectGitignore: config.gitignoreRespect,
      extraPatterns: config.exclude,
    });
    const tagRules = compileTagRules(config);

    const currentBlobs = safelyGetBlobs(projectRoot);
    const ledger = loadLedger(client.db);
    const { filesToIndex, deletions, renames } = classify(
      currentBlobs,
      ledger,
      mode,
      projectRoot,
      opts.since,
      (p) => {
        if (matcher.isIgnored(p)) return false;
        const lang = detectLanguage(p);
        if (!lang) return false;
        if (!config.languages.includes(lang)) return false;
        return true;
      },
    );

    for (const r of renames) {
      applyRename(client.db, r.from, r.to);
      summary.filesRenamed++;
    }
    for (const filePath of deletions) {
      garbageCollectFile(client.db, filePath);
      summary.filesDeleted++;
    }

    const total = filesToIndex.length;
    let processed = 0;
    for (const { filePath, blobSha } of filesToIndex) {
      processed++;
      try {
        const absPath = join(projectRoot, filePath);
        if (!existsSync(absPath)) {
          summary.filesSkipped++;
          continue;
        }
        const filterOutcome = decide(absPath, config.indexing);
        if (filterOutcome.skip) {
          summary.filesSkipped++;
          continue;
        }
        const source = readFileSync(absPath, "utf-8");
        const parsed = await parseFile(filePath, source, config.languages);
        if (!parsed) {
          summary.filesSkipped++;
          continue;
        }
        const inserted = await indexOneFile(client.db, parsed, blobSha, source, embedder, tagRules);
        summary.chunksInserted += inserted;
        summary.filesProcessed++;
        opts.onProgress?.({ processed, total, filePath });
      } catch (err) {
        summary.errors.push({
          filePath,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return summary;
  } finally {
    lock.release();
    client.close();
  }
}

// ────────────────────────────────────────────────────────────────────────
// File-level atomic writer
// ────────────────────────────────────────────────────────────────────────

/**
 * Embed one file's chunks, then persist everything in a single SQLite
 * transaction. Embedding happens *before* the transaction because Bun's
 * transaction callback must be synchronous with respect to DB writes.
 */
async function indexOneFile(
  db: Database,
  parsed: ParseResult,
  blobSha: string,
  source: string,
  embedder: Embedder,
  tagRules: ReturnType<typeof compileTagRules>,
): Promise<number> {
  const filePath = parsed.metadata.filePath;
  if (parsed.chunks.length === 0) {
    db.transaction(() => {
      upsertFileRow(db, parsed);
      upsertLedgerEntry(db, {
        filePath,
        blobSha,
        signatureHash: parsed.signatureHash,
        chunkCount: 0,
      });
    })();
    return 0;
  }

  const embedInputs = parsed.chunks.map(chunkText);
  const { vectors } = await embedder.embed(embedInputs, { inputType: "document" });
  const customFileTags = applyTagRules(tagRules, { filePath, content: source });

  const tx = db.transaction(() => {
    db.query<unknown, [string]>(`DELETE FROM chunks WHERE file_path = ?`).run(filePath);

    let inserted = 0;
    for (let i = 0; i < parsed.chunks.length; i++) {
      const chunk = parsed.chunks[i]!;
      const vec = vectors[i];
      if (!vec) continue;
      const chunkTags = mergeTags(chunk.tags, customFileTags);

      const res = db
        .query<
          { id: number },
          Bindings
        >(
          `INSERT INTO chunks (file_path, file_hash, chunk_type, symbol_name, receiver_type,
                                signature, package_name, language, start_line, end_line,
                                content, doc_comment, imports_json, tags_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(file_path, symbol_name, chunk_type, start_line) DO UPDATE SET
             file_hash = excluded.file_hash,
             signature = excluded.signature,
             content = excluded.content,
             doc_comment = excluded.doc_comment,
             imports_json = excluded.imports_json,
             tags_json = excluded.tags_json,
             indexed_at = unixepoch()
           RETURNING id`,
        )
        .get(
          filePath,
          parsed.metadata.fileHash,
          chunk.chunkType,
          chunk.symbolName,
          chunk.receiverType,
          chunk.signature,
          chunk.packageName,
          chunk.language,
          chunk.startLine,
          chunk.endLine,
          chunk.content,
          chunk.docComment,
          JSON.stringify(chunk.imports),
          JSON.stringify(chunkTags),
        );
      if (!res) continue;

      const vecBytes = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
      db.query(`INSERT OR REPLACE INTO chunks_vec (rowid, embedding) VALUES (?, ?)`).run(
        res.id,
        vecBytes,
      );

      db.query(`DELETE FROM chunk_tags WHERE chunk_id = ?`).run(res.id);
      for (const tag of chunkTags) {
        db.query(`INSERT OR IGNORE INTO chunk_tags (chunk_id, tag) VALUES (?, ?)`).run(
          res.id,
          tag,
        );
      }
      inserted++;
    }

    upsertFileRow(db, parsed);
    upsertLedgerEntry(db, {
      filePath,
      blobSha,
      signatureHash: parsed.signatureHash,
      chunkCount: inserted,
    });
    return inserted;
  });
  return tx() as number;
}

function upsertFileRow(db: Database, parsed: ParseResult): void {
  db.query(
    `INSERT INTO files (file_path, file_hash, language, line_count, chunk_count,
                        imports_json, symbols_json, last_indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(file_path) DO UPDATE SET
       file_hash = excluded.file_hash,
       language = excluded.language,
       line_count = excluded.line_count,
       chunk_count = excluded.chunk_count,
       imports_json = excluded.imports_json,
       symbols_json = excluded.symbols_json,
       last_indexed_at = unixepoch()`,
  ).run(
    parsed.metadata.filePath,
    parsed.metadata.fileHash,
    parsed.metadata.language,
    parsed.metadata.lineCount,
    parsed.chunks.length,
    JSON.stringify(parsed.metadata.imports),
    JSON.stringify(parsed.metadata.symbols),
  );
}

/** Text sent to the embedder: signature + doc + content for rich BM25+vector matching. */
function chunkText(chunk: ParseResult["chunks"][number]): string {
  const parts = [chunk.signature ?? "", chunk.docComment ?? "", chunk.content];
  return parts.filter((p) => p.length > 0).join("\n\n");
}

// ────────────────────────────────────────────────────────────────────────
// Change classification
// ────────────────────────────────────────────────────────────────────────

function safelyGetBlobs(projectRoot: string): Map<string, string> {
  try {
    return getGitBlobShas(projectRoot);
  } catch {
    return new Map();
  }
}

interface ClassifiedChanges {
  filesToIndex: Array<{ filePath: string; blobSha: string }>;
  deletions: string[];
  renames: Array<{ from: string; to: string }>;
}

function classify(
  currentBlobs: Map<string, string>,
  ledger: Map<string, { blobSha: string }>,
  mode: "full" | "incremental",
  projectRoot: string,
  since: string | undefined,
  shouldIndex: (path: string) => boolean,
): ClassifiedChanges {
  const out: ClassifiedChanges = { filesToIndex: [], deletions: [], renames: [] };

  if (mode === "full") {
    for (const [filePath, blobSha] of currentBlobs) {
      if (shouldIndex(filePath)) out.filesToIndex.push({ filePath, blobSha });
    }
    for (const [filePath] of ledger) {
      if (!currentBlobs.has(filePath)) out.deletions.push(filePath);
    }
    return out;
  }

  if (since) {
    try {
      const diff = gitDiffSince(projectRoot, since, "HEAD");
      for (const f of diff.added.concat(diff.modified)) {
        if (!shouldIndex(f)) continue;
        const blob = currentBlobs.get(f);
        if (blob) out.filesToIndex.push({ filePath: f, blobSha: blob });
      }
      for (const f of diff.deleted) out.deletions.push(f);
      for (const r of diff.renamed) out.renames.push(r);
      return out;
    } catch {
      // Fall through to ledger-based classification.
    }
  }

  for (const [filePath, blobSha] of currentBlobs) {
    if (!shouldIndex(filePath)) continue;
    const prev = ledger.get(filePath);
    if (!prev || prev.blobSha !== blobSha) {
      out.filesToIndex.push({ filePath, blobSha });
    }
  }
  for (const [filePath] of ledger) {
    if (!currentBlobs.has(filePath)) out.deletions.push(filePath);
  }
  return out;
}
