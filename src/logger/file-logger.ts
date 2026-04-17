import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Simple JSON-lines file logger with size-based rotation.
 * Thread-unsafe (we rely on advisory locks for the indexer). One writer at a time.
 */
export interface FileLoggerOptions {
  path: string;
  maxBytes?: number;
  retainRotated?: number;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

export class FileLogger {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly retainRotated: number;

  constructor(opts: FileLoggerOptions) {
    this.path = resolve(opts.path);
    this.maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
    this.retainRotated = opts.retainRotated ?? 3;
    mkdirSync(dirname(this.path), { recursive: true });
  }

  debug(msg: string, extra?: Record<string, unknown>) {
    this.write("debug", msg, extra);
  }
  info(msg: string, extra?: Record<string, unknown>) {
    this.write("info", msg, extra);
  }
  warn(msg: string, extra?: Record<string, unknown>) {
    this.write("warn", msg, extra);
  }
  error(msg: string, extra?: Record<string, unknown>) {
    this.write("error", msg, extra);
  }

  private write(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(extra ?? {}),
    };
    this.rotateIfNeeded();
    appendFileSync(this.path, JSON.stringify(entry) + "\n", "utf-8");
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.path)) return;
    const size = statSync(this.path).size;
    if (size < this.maxBytes) return;

    // Shift: .N-1 → .N, .0 → .1, current → .0
    for (let i = this.retainRotated - 1; i >= 0; i--) {
      const from = i === 0 ? this.path : `${this.path}.${i}`;
      const to = `${this.path}.${i + 1}`;
      if (existsSync(from)) {
        try {
          renameSync(from, to);
        } catch {
          /* best effort */
        }
      }
    }
  }
}
