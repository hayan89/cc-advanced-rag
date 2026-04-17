import { lstatSync, openSync, readSync, closeSync, statSync } from "node:fs";

export interface FileFilterOptions {
  maxFileSizeBytes?: number;
  binaryDetect?: boolean;
  followSymlinks?: boolean;
}

export interface FilterDecision {
  skip: boolean;
  reason: "ok" | "too-large" | "binary" | "symlink" | "not-file" | "missing";
  sizeBytes?: number;
}

const DEFAULT_MAX_BYTES = 1_048_576; // 1 MiB
const BINARY_PROBE_BYTES = 8192;

/**
 * Decide whether a file should be indexed based on size / binary / symlink rules.
 *
 * - Returns `skip: false` for normal small text files.
 * - `followSymlinks: false` (default) skips symlinks to prevent loops.
 * - `binaryDetect: true` (default) reads the first 8 KiB and skips files
 *   containing NUL bytes (a standard binary heuristic).
 */
export function decide(absPath: string, opts: FileFilterOptions = {}): FilterDecision {
  const maxBytes = opts.maxFileSizeBytes ?? DEFAULT_MAX_BYTES;
  const binaryDetect = opts.binaryDetect ?? true;
  const followSymlinks = opts.followSymlinks ?? false;

  let lstat;
  try {
    lstat = lstatSync(absPath);
  } catch {
    return { skip: true, reason: "missing" };
  }

  if (lstat.isSymbolicLink() && !followSymlinks) {
    return { skip: true, reason: "symlink" };
  }

  const stat = followSymlinks ? statSync(absPath, { throwIfNoEntry: false }) : lstat;
  if (!stat?.isFile()) {
    return { skip: true, reason: "not-file" };
  }

  if (stat.size > maxBytes) {
    return { skip: true, reason: "too-large", sizeBytes: stat.size };
  }

  if (binaryDetect && containsNullBytes(absPath, Math.min(stat.size, BINARY_PROBE_BYTES))) {
    return { skip: true, reason: "binary", sizeBytes: stat.size };
  }

  return { skip: false, reason: "ok", sizeBytes: stat.size };
}

function containsNullBytes(path: string, bytesToRead: number): boolean {
  if (bytesToRead === 0) return false;
  const buf = Buffer.alloc(bytesToRead);
  const fd = openSync(path, "r");
  try {
    const read = readSync(fd, buf, 0, bytesToRead, 0);
    for (let i = 0; i < read; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } finally {
    closeSync(fd);
  }
}
