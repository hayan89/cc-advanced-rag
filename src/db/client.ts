import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync, openSync, closeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const CURRENT_SCHEMA_VERSION = 4;

export interface ClientOptions {
  dbPath: string;
  dimension: number;
  readonly?: boolean;
}

export interface Client {
  db: Database;
  dimension: number;
  close(): void;
  integrityCheck(): { ok: boolean; messages: string[] };
}

/**
 * Open a SQLite database, load sqlite-vec, apply PRAGMAs, run schema,
 * and ensure the `chunks_vec` virtual table matches the configured dimension.
 *
 * Throws if:
 * - sqlite-vec cannot be loaded (platform / install issue)
 * - stored dimension in meta does not match the requested dimension
 *   (caller should trigger rebuild_index)
 */
export function openClient(opts: ClientOptions): Client {
  const dbPath = resolve(opts.dbPath);
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath, { create: !opts.readonly, readonly: opts.readonly });

  // Load sqlite-vec extension before anything else.
  db.loadExtension(sqliteVec.getLoadablePath());

  // Performance PRAGMAs — safe defaults for a local code-search workload.
  // synchronous=NORMAL is safe with WAL and gives large throughput gains.
  // mmap_size=256MB allows SQLite to map the DB into memory for faster reads.
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA mmap_size = 268435456;
    PRAGMA foreign_keys = ON;
  `);

  if (!opts.readonly) {
    applySchema(db);
    ensureVecTable(db, opts.dimension);
    applyPendingMigrations(db);
  }

  return {
    db,
    dimension: opts.dimension,
    close() {
      db.close();
    },
    integrityCheck() {
      return runIntegrityCheck(db);
    },
  };
}

function applySchema(db: Database): void {
  const schemaPath = join(import.meta.dir, "schema.sql");
  const sql = readFileSync(schemaPath, "utf-8");
  db.exec(sql);
}

/**
 * Ensure chunks_vec and semantic_cache_vec virtual tables exist with the
 * requested dimension. If the stored dimension in meta differs, throw — caller
 * decides whether to rebuild.
 */
function ensureVecTable(db: Database, dimension: number): void {
  const storedRow = db
    .query<{ value: string }, [string]>(`SELECT value FROM meta WHERE key = ?`)
    .get("stored_dimension");

  if (storedRow) {
    const stored = Number(storedRow.value);
    if (stored !== dimension) {
      throw new DimensionMismatchError(stored, dimension);
    }
  } else {
    // First initialization — record the dimension.
    db.query(`INSERT INTO meta (key, value) VALUES ('stored_dimension', ?)`).run(String(dimension));
  }

  // Create the vec0 tables if they don't exist. The dimension is interpolated
  // into the DDL (sqlite-vec does not support parameterized dimensions).
  // Safe because `dimension` is validated as a positive integer.
  if (!Number.isInteger(dimension) || dimension <= 0 || dimension > 65536) {
    throw new Error(`Invalid embedding dimension: ${dimension}`);
  }

  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding float[${dimension}]);`,
  );
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS semantic_cache_vec USING vec0(embedding float[${dimension}]);`,
  );
}

function applyPendingMigrations(db: Database): void {
  const currentRow = db
    .query<{ version: number }, []>(`SELECT MAX(version) AS version FROM schema_version`)
    .get();
  const current = currentRow?.version ?? 0;

  if (current < 2) {
    const migrationPath = join(import.meta.dir, "migrations", "0002_chunk_tags.sql");
    if (existsSync(migrationPath)) {
      db.exec(readFileSync(migrationPath, "utf-8"));
    }
  }

  if (current < 3) {
    const migrationPath = join(import.meta.dir, "migrations", "0003_l2_semantic_and_chunk_hashes.sql");
    if (existsSync(migrationPath)) {
      // applySchema already ran CREATE TABLE IF NOT EXISTS for semantic_cache,
      // so the only SQL here that could raise is the ALTER TABLE for
      // index_ledger.chunk_hashes_json. Skip gracefully if the column already
      // exists (re-run on an already-migrated DB).
      try {
        db.exec(readFileSync(migrationPath, "utf-8"));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/duplicate column name/i.test(msg)) throw err;
      }
      // v2 embeddings were not L2-normalized. Mark that a full reindex is
      // required before the new cosine-similarity formulas are meaningful.
      db.query(
        `INSERT INTO meta (key, value) VALUES ('reindex_required', '1')
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run();
    }
  }

  if (current < 4) {
    const migrationPath = join(import.meta.dir, "migrations", "0004_chunk_tag_weights.sql");
    if (existsSync(migrationPath)) {
      // schema.sql already defines chunk_tags.weight for fresh DBs, so the
      // ALTER in 0004 is only meaningful on pre-v4 installs. Swallow the
      // duplicate-column error when the column is already present.
      try {
        db.exec(readFileSync(migrationPath, "utf-8"));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/duplicate column name/i.test(msg)) throw err;
      }
    }
  }

  if (current < CURRENT_SCHEMA_VERSION) {
    db.query(`INSERT OR IGNORE INTO schema_version (version) VALUES (?)`).run(
      CURRENT_SCHEMA_VERSION,
    );
  }
}

function runIntegrityCheck(db: Database): { ok: boolean; messages: string[] } {
  const rows = db.query<{ integrity_check: string }, []>(`PRAGMA integrity_check`).all();
  const messages = rows.map((r) => r.integrity_check);
  const ok = messages.length === 1 && messages[0] === "ok";
  return { ok, messages };
}

export class DimensionMismatchError extends Error {
  constructor(
    public readonly stored: number,
    public readonly requested: number,
  ) {
    super(
      `Embedding dimension mismatch: stored=${stored}, requested=${requested}. ` +
        `Run rebuild_index to regenerate embeddings with the new provider.`,
    );
    this.name = "DimensionMismatchError";
  }
}

/**
 * Minimal advisory file lock. Used by the indexer to prevent concurrent
 * writers (post-commit hook + MCP rebuild_index running simultaneously).
 *
 * Cross-platform (works on Linux/macOS/Windows) by using O_EXCL file creation.
 * Stale locks (dead PID) are cleaned up automatically.
 */
export interface LockHandle {
  release(): void;
}

export function acquireLock(lockPath: string, timeoutMs = 30000): LockHandle {
  const absPath = resolve(lockPath);
  mkdirSync(dirname(absPath), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(absPath, "wx");
      writeFileSync(fd, String(process.pid), "utf-8");
      closeSync(fd);
      return {
        release() {
          try {
            unlinkSync(absPath);
          } catch {
            /* already removed */
          }
        },
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Lock exists — check if holder is still alive.
      if (existsSync(absPath)) {
        try {
          const raw = readFileSync(absPath, "utf-8").trim();
          const holderPid = Number(raw);
          if (holderPid && !isProcessAlive(holderPid)) {
            unlinkSync(absPath);
            continue;
          }
        } catch {
          /* race: lock file vanished, retry */
        }
      }
      // Brief spin-wait.
      Bun.sleepSync(100);
    }
  }
  throw new Error(`Timed out acquiring lock at ${absPath}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
