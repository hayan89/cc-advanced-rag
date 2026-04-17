/**
 * Progress reporting for indexing runs. Consumed by:
 * - CLI scripts (stderr line updates)
 * - MCP tool handlers (emit hookSpecificOutput updates to Claude)
 */

export interface ProgressEvent {
  phase: "start" | "file" | "embed" | "commit" | "done" | "error";
  filesProcessed: number;
  filesTotal: number;
  chunksCreated: number;
  lastFile?: string;
  etaSeconds?: number;
  message?: string;
  error?: string;
}

export type ProgressListener = (event: ProgressEvent) => void;

export interface ProgressReporterOptions {
  /** Minimum ms between emitted events (rate-limit the stream). Default 250. */
  minIntervalMs?: number;
  listener: ProgressListener;
}

export class ProgressReporter {
  private filesProcessed = 0;
  private filesTotal = 0;
  private chunksCreated = 0;
  private startedAt = 0;
  private lastEmitAt = 0;
  private readonly listener: ProgressListener;
  private readonly minIntervalMs: number;

  constructor(opts: ProgressReporterOptions) {
    this.listener = opts.listener;
    this.minIntervalMs = opts.minIntervalMs ?? 250;
  }

  start(filesTotal: number): void {
    this.filesTotal = filesTotal;
    this.filesProcessed = 0;
    this.chunksCreated = 0;
    this.startedAt = Date.now();
    this.emit({ phase: "start", message: `Indexing ${filesTotal} files` });
  }

  fileProcessed(path: string, chunks: number): void {
    this.filesProcessed += 1;
    this.chunksCreated += chunks;
    this.maybeEmit({
      phase: "file",
      lastFile: path,
    });
  }

  embedBatch(size: number): void {
    this.maybeEmit({
      phase: "embed",
      message: `Embedding batch of ${size}`,
    });
  }

  committing(): void {
    this.emit({ phase: "commit", message: "Committing to DB" });
  }

  done(): void {
    this.emit({ phase: "done", message: `Done — ${this.chunksCreated} chunks in ${this.elapsedSeconds()}s` });
  }

  error(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.emit({ phase: "error", error: message });
  }

  private maybeEmit(partial: Partial<ProgressEvent>): void {
    const now = Date.now();
    if (now - this.lastEmitAt < this.minIntervalMs) return;
    this.emit(partial);
  }

  private emit(partial: Partial<ProgressEvent>): void {
    const etaSeconds = this.estimateEta();
    const event: ProgressEvent = {
      phase: partial.phase ?? "file",
      filesProcessed: this.filesProcessed,
      filesTotal: this.filesTotal,
      chunksCreated: this.chunksCreated,
      ...partial,
      ...(etaSeconds !== undefined ? { etaSeconds } : {}),
    };
    this.lastEmitAt = Date.now();
    this.listener(event);
  }

  private estimateEta(): number | undefined {
    if (this.filesTotal === 0 || this.filesProcessed === 0) return undefined;
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const rate = this.filesProcessed / elapsed;
    if (rate === 0) return undefined;
    const remaining = this.filesTotal - this.filesProcessed;
    return Math.round(remaining / rate);
  }

  private elapsedSeconds(): number {
    return Math.round((Date.now() - this.startedAt) / 1000);
  }
}

/** Default listener: write one-line progress to stderr. */
export function stderrListener(prefix = "[cc-advanced-rag]"): ProgressListener {
  return (event) => {
    const eta = event.etaSeconds !== undefined ? ` ETA=${event.etaSeconds}s` : "";
    const file = event.lastFile ? ` file=${event.lastFile}` : "";
    const msg = event.message ? ` ${event.message}` : "";
    const err = event.error ? ` ERROR=${event.error}` : "";
    const progress = event.filesTotal > 0
      ? ` [${event.filesProcessed}/${event.filesTotal} files, ${event.chunksCreated} chunks]`
      : "";
    console.error(`${prefix} ${event.phase}${progress}${eta}${file}${msg}${err}`);
  };
}
