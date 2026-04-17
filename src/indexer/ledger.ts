import type { Database } from "bun:sqlite";
import { execSync } from "node:child_process";

export interface LedgerEntry {
  filePath: string;
  blobSha: string;
  signatureHash: string;
  chunkCount: number;
}

export type ChangeType =
  | "unchanged"
  | "content-only"
  | "signature-changed"
  | "new"
  | "deleted"
  | "renamed";

export interface FileChange {
  filePath: string;
  type: ChangeType;
  /** For `renamed`, holds the previous path. */
  previousPath?: string;
  currentBlobSha?: string;
  previousBlobSha?: string;
  previousSignatureHash?: string;
}

// ────────────────────────────────────────────────────────────────────────
// Git helpers
// ────────────────────────────────────────────────────────────────────────

export function getGitBlobShas(repoRoot: string): Map<string, string> {
  const output = execSync("git ls-files -s", { cwd: repoRoot, encoding: "utf-8" });
  const map = new Map<string, string>();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(/^\d+ ([a-f0-9]+) \d+\t(.+)$/);
    if (match && match[1] && match[2]) {
      map.set(match[2], match[1]);
    }
  }
  return map;
}

export function getGitHeadSha(repoRoot: string): string {
  return execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();
}

/**
 * Parse `git diff --name-status <from>..<to>` to detect additions, modifications,
 * deletions, and renames. Format:
 *   A\tfile         (added)
 *   M\tfile         (modified)
 *   D\tfile         (deleted)
 *   R<score>\told\tnew  (renamed)
 */
export interface GitDiff {
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
}

export function parseDiffNameStatus(output: string): GitDiff {
  const diff: GitDiff = { added: [], modified: [], deleted: [], renamed: [] };
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    if (status.startsWith("A") && parts[1]) diff.added.push(parts[1]);
    else if (status.startsWith("M") && parts[1]) diff.modified.push(parts[1]);
    else if (status.startsWith("D") && parts[1]) diff.deleted.push(parts[1]);
    else if (status.startsWith("R") && parts[1] && parts[2]) {
      diff.renamed.push({ from: parts[1], to: parts[2] });
    }
  }
  return diff;
}

export function gitDiffSince(repoRoot: string, fromCommit: string, toCommit = "HEAD"): GitDiff {
  const output = execSync(`git diff --name-status ${fromCommit} ${toCommit}`, {
    cwd: repoRoot,
    encoding: "utf-8",
  });
  return parseDiffNameStatus(output);
}

// ────────────────────────────────────────────────────────────────────────
// Ledger CRUD
// ────────────────────────────────────────────────────────────────────────

export function loadLedger(db: Database): Map<string, LedgerEntry> {
  const rows = db
    .query<
      { file_path: string; blob_sha: string; signature_hash: string; chunk_count: number },
      []
    >(`SELECT file_path, blob_sha, signature_hash, chunk_count FROM index_ledger`)
    .all();
  const map = new Map<string, LedgerEntry>();
  for (const row of rows) {
    map.set(row.file_path, {
      filePath: row.file_path,
      blobSha: row.blob_sha,
      signatureHash: row.signature_hash,
      chunkCount: row.chunk_count,
    });
  }
  return map;
}

export function upsertLedgerEntry(db: Database, entry: LedgerEntry): void {
  db.query(
    `INSERT INTO index_ledger (file_path, blob_sha, signature_hash, chunk_count, indexed_at)
     VALUES (?, ?, ?, ?, unixepoch())
     ON CONFLICT(file_path) DO UPDATE SET
       blob_sha = excluded.blob_sha,
       signature_hash = excluded.signature_hash,
       chunk_count = excluded.chunk_count,
       indexed_at = unixepoch()`,
  ).run(entry.filePath, entry.blobSha, entry.signatureHash, entry.chunkCount);
}

export function deleteLedgerEntry(db: Database, filePath: string): void {
  db.query(`DELETE FROM index_ledger WHERE file_path = ?`).run(filePath);
}

/**
 * Garbage-collect all chunks and the ledger entry for a deleted file.
 * The FTS5 and chunks_vec triggers take care of the derived tables.
 */
export function garbageCollectFile(db: Database, filePath: string): number {
  const res = db.query(`DELETE FROM chunks WHERE file_path = ?`).run(filePath);
  db.query(`DELETE FROM files WHERE file_path = ?`).run(filePath);
  deleteLedgerEntry(db, filePath);
  return Number(res.changes);
}

/**
 * For a rename, update chunks/files/ledger in place so we keep embeddings
 * without re-indexing.
 */
export function applyRename(db: Database, fromPath: string, toPath: string): void {
  db.query(`UPDATE chunks SET file_path = ? WHERE file_path = ?`).run(toPath, fromPath);
  db.query(`UPDATE files SET file_path = ? WHERE file_path = ?`).run(toPath, fromPath);
  db.query(`UPDATE index_ledger SET file_path = ? WHERE file_path = ?`).run(toPath, fromPath);
}

// ────────────────────────────────────────────────────────────────────────
// Change classification (compare current git tracking vs. stored ledger)
// ────────────────────────────────────────────────────────────────────────

export function classifyChanges(
  currentBlobs: Map<string, string>,
  ledger: Map<string, LedgerEntry>,
  filter?: (path: string) => boolean,
): FileChange[] {
  const changes: FileChange[] = [];

  for (const [filePath, blobSha] of currentBlobs) {
    if (filter && !filter(filePath)) continue;
    const prev = ledger.get(filePath);
    if (!prev) {
      changes.push({ filePath, type: "new", currentBlobSha: blobSha });
    } else if (prev.blobSha === blobSha) {
      changes.push({ filePath, type: "unchanged", currentBlobSha: blobSha });
    } else {
      changes.push({
        filePath,
        type: "content-only",
        currentBlobSha: blobSha,
        previousBlobSha: prev.blobSha,
        previousSignatureHash: prev.signatureHash,
      });
    }
  }

  for (const [filePath] of ledger) {
    if (filter && !filter(filePath)) continue;
    if (!currentBlobs.has(filePath)) {
      changes.push({ filePath, type: "deleted" });
    }
  }

  return changes;
}
