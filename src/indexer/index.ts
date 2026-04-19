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
import { applyTagRules, compileTagRules, mergeTags } from "../tagging/custom-tags.ts";
import {
  DEFAULT_STRUCTURAL_BUCKETS,
  DEFAULT_SYMBOL_SUFFIXES,
  extractResourceTags,
  tagWeight,
  type ExtractorOpts,
} from "../tagging/resource-extractor.ts";
import {
  getGitBlobShas,
  gitDiffSince,
  loadLedger,
  upsertLedgerEntry,
  garbageCollectFile,
  applyRename,
  buildOldChunkHashMap,
  type ChunkHashEntry,
  type LedgerEntry,
} from "./ledger.ts";
import { computeChunkSignatureHash, computeSignatureHash } from "./parsers/common.ts";

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
    const resourceCfg = config.tagging.resourceExtractor;
    const resourceOpts: ExtractorOpts = {
      structuralBuckets: DEFAULT_STRUCTURAL_BUCKETS,
      symbolSuffixes: DEFAULT_SYMBOL_SUFFIXES,
      stopwords: new Set(resourceCfg.stopwords),
      includePaths: resourceCfg.includePaths,
      excludePaths: resourceCfg.excludePaths,
    };
    const resourceEnabled = resourceCfg.enabled;
    const resourceWeight = resourceCfg.resourceWeight;

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
        const inserted = await indexOneFile(
          client.db,
          parsed,
          blobSha,
          source,
          embedder,
          tagRules,
          ledger.get(filePath),
          { enabled: resourceEnabled, opts: resourceOpts, weight: resourceWeight },
        );
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
interface ResourceConfig {
  enabled: boolean;
  opts: ExtractorOpts;
  weight: number;
}

async function indexOneFile(
  db: Database,
  parsed: ParseResult,
  blobSha: string,
  source: string,
  embedder: Embedder,
  tagRules: ReturnType<typeof compileTagRules>,
  prevLedgerEntry: LedgerEntry | undefined,
  resource: ResourceConfig,
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
        chunkHashesJson: "[]",
      });
    })();
    return 0;
  }

  // 1. Per-chunk signature hash for diff + ledger persistence.
  for (const chunk of parsed.chunks) {
    chunk.signatureHash = computeChunkSignatureHash(chunk);
  }

  // 2. Old key → sig map from ledger (or chunks-table fallback for legacy rows).
  const oldSigByKey = buildOldChunkHashMap(
    db,
    filePath,
    prevLedgerEntry?.chunkHashesJson,
    (row) =>
      computeSignatureHash([
        row.chunk_type,
        row.receiver_type ?? "",
        row.symbol_name ?? "",
        row.signature ?? "",
      ]),
  );

  // 3. Old embedding bytes keyed by the same `type:symbol:startLine` scheme —
  //    used to reuse embeddings when a chunk is unchanged or simply moved.
  const oldEmbeddingsByKey = loadEmbeddingsByKey(db, filePath);

  // Inverse map for move detection: sig → key(s) (first wins).
  const oldKeyBySig = new Map<string, string>();
  for (const [key, sig] of oldSigByKey) {
    if (!oldKeyBySig.has(sig)) oldKeyBySig.set(sig, key);
  }

  // 4. Classify new chunks and decide which need embedding.
  const toEmbedIdx: number[] = [];
  const reusedBytes = new Array<Uint8Array | null>(parsed.chunks.length).fill(null);
  for (let i = 0; i < parsed.chunks.length; i++) {
    const chunk = parsed.chunks[i]!;
    const newSig = chunk.signatureHash!;
    const newKey = chunkKey(chunk);

    const oldSigAtSameKey = oldSigByKey.get(newKey);
    if (oldSigAtSameKey === newSig) {
      const bytes = oldEmbeddingsByKey.get(newKey);
      if (bytes) {
        reusedBytes[i] = bytes;
        continue;
      }
    }
    // Moved: same signature elsewhere in the prior file.
    const movedKey = oldKeyBySig.get(newSig);
    if (movedKey && movedKey !== newKey) {
      const bytes = oldEmbeddingsByKey.get(movedKey);
      if (bytes) {
        reusedBytes[i] = bytes;
        continue;
      }
    }
    toEmbedIdx.push(i);
  }

  // 5. Embed only the new/changed subset.
  let freshVectors: Float32Array[] = [];
  if (toEmbedIdx.length > 0) {
    const inputs = toEmbedIdx.map((i) => chunkText(parsed.chunks[i]!));
    const { vectors } = await embedder.embed(inputs, { inputType: "document" });
    freshVectors = vectors;
  }
  const freshByIdx = new Map<number, Float32Array>();
  for (let j = 0; j < toEmbedIdx.length; j++) {
    const v = freshVectors[j];
    if (v) freshByIdx.set(toEmbedIdx[j]!, v);
  }

  const customFileTags = applyTagRules(tagRules, { filePath, content: source });
  const fileResourceTags = resource.enabled
    ? extractResourceTags({ filePath }, resource.opts)
    : [];

  // 6. Atomic write: replace file's rows, restore/insert embeddings, update ledger.
  const tx = db.transaction(() => {
    db.query<unknown, [string]>(`DELETE FROM chunks WHERE file_path = ?`).run(filePath);

    let inserted = 0;
    const hashes: ChunkHashEntry[] = [];
    for (let i = 0; i < parsed.chunks.length; i++) {
      const chunk = parsed.chunks[i]!;
      const reuse = reusedBytes[i];
      const fresh = freshByIdx.get(i);
      const vecBytes = reuse ?? (fresh ? toBytes(fresh) : null);
      if (!vecBytes) continue;
      const chunkResourceTags = resource.enabled
        ? extractResourceTags(
            { filePath, symbolName: chunk.symbolName },
            resource.opts,
          )
        : [];
      const chunkTags = mergeTags(
        chunk.tags,
        mergeTags(fileResourceTags, mergeTags(chunkResourceTags, customFileTags)),
      );

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

      db.query(`INSERT OR REPLACE INTO chunks_vec (rowid, embedding) VALUES (?, ?)`).run(
        res.id,
        vecBytes,
      );

      db.query(`DELETE FROM chunk_tags WHERE chunk_id = ?`).run(res.id);
      for (const tag of chunkTags) {
        db.query(
          `INSERT OR IGNORE INTO chunk_tags (chunk_id, tag, weight) VALUES (?, ?, ?)`,
        ).run(res.id, tag, tagWeight(tag, resource.weight));
      }
      inserted++;
      hashes.push({ key: chunkKey(chunk), sig: chunk.signatureHash! });
    }

    upsertFileRow(db, parsed);
    upsertLedgerEntry(db, {
      filePath,
      blobSha,
      signatureHash: parsed.signatureHash,
      chunkCount: inserted,
      chunkHashesJson: JSON.stringify(hashes),
    });
    return inserted;
  });
  return tx() as number;
}

function chunkKey(chunk: { chunkType: string; symbolName: string | null; startLine: number }): string {
  return `${chunk.chunkType}:${chunk.symbolName ?? ""}:${chunk.startLine}`;
}

function loadEmbeddingsByKey(db: Database, filePath: string): Map<string, Uint8Array> {
  const rows = db
    .query<
      {
        chunk_type: string;
        symbol_name: string | null;
        start_line: number;
        embedding: Uint8Array;
      },
      [string]
    >(
      `SELECT c.chunk_type, c.symbol_name, c.start_line, v.embedding
         FROM chunks c
         JOIN chunks_vec v ON v.rowid = c.id
        WHERE c.file_path = ?`,
    )
    .all(filePath);
  const map = new Map<string, Uint8Array>();
  for (const r of rows) {
    const key = `${r.chunk_type}:${r.symbol_name ?? ""}:${r.start_line}`;
    map.set(key, r.embedding);
  }
  return map;
}

function toBytes(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
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
