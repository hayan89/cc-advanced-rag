import type { Database } from "bun:sqlite";
import type { Config } from "../config/schema.ts";
import type { Embedder } from "../indexer/embedder.ts";

export interface ToolContext {
  db: Database;
  config: Config;
  embedder: Embedder;
  /** Absolute path used for git commands (ledger lookups, git HEAD sha). */
  projectRoot: string;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(msg: string): ToolResult {
  return { content: [{ type: "text", text: msg }], isError: true };
}
