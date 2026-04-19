import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

export const RAG_MCP_TOOLS = [
  "mcp__cc-advanced-rag__search_code",
  "mcp__cc-advanced-rag__lookup_file",
  "mcp__cc-advanced-rag__search_symbol",
  "mcp__cc-advanced-rag__get_related",
  "mcp__cc-advanced-rag__index_status",
  "mcp__cc-advanced-rag__rebuild_index",
] as const;

export interface MergeResult {
  action: "created" | "merged" | "already-present";
  path: string;
  added: string[];
}

export class MalformedSettingsError extends Error {
  constructor(public readonly backupPath: string, cause: unknown) {
    super(
      `settings.local.json is malformed JSON; original preserved at ${backupPath}. ` +
        `Run /rag-doctor to recover.`,
    );
    this.name = "MalformedSettingsError";
    if (cause instanceof Error) this.cause = cause;
  }
}

export function settingsLocalPath(projectRoot: string): string {
  return join(projectRoot, ".claude/settings.local.json");
}

/**
 * Idempotently union the 6 cc-advanced-rag MCP tool ids into
 * `<project>/.claude/settings.local.json` `permissions.allow`.
 *
 * - File absent → create with all 6 entries.
 * - Existing entries preserved.
 * - All 6 already present → no-op (no rewrite, mtime unchanged).
 * - Malformed JSON → original backed up to `*.bak-<ts>`, throw MalformedSettingsError.
 *
 * Writes are atomic: data goes to a tempfile, then renameSync replaces the target.
 */
export function mergeSettings(projectRoot: string): MergeResult {
  const path = settingsLocalPath(projectRoot);
  const dir = dirname(path);

  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    const fresh = { permissions: { allow: [...RAG_MCP_TOOLS] } };
    atomicWriteJson(path, fresh);
    return { action: "created", path, added: [...RAG_MCP_TOOLS] };
  }

  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const backup = `${path}.bak-${Date.now()}`;
    writeFileSync(backup, raw, "utf-8");
    throw new MalformedSettingsError(backup, err);
  }

  const settings = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const permissions = (settings.permissions && typeof settings.permissions === "object"
    ? settings.permissions
    : {}) as Record<string, unknown>;
  const existingAllow = Array.isArray(permissions.allow) ? (permissions.allow as unknown[]) : [];
  const existingSet = new Set(existingAllow.filter((x): x is string => typeof x === "string"));

  const added: string[] = [];
  for (const tool of RAG_MCP_TOOLS) {
    if (!existingSet.has(tool)) {
      added.push(tool);
      existingSet.add(tool);
    }
  }

  if (added.length === 0) {
    return { action: "already-present", path, added: [] };
  }

  const merged = {
    ...settings,
    permissions: {
      ...permissions,
      allow: [...existingAllow.filter((x): x is string => typeof x === "string"), ...added],
    },
  };
  atomicWriteJson(path, merged);
  return { action: "merged", path, added };
}

function atomicWriteJson(target: string, data: unknown): void {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  renameSync(tmp, target);
}

export function readAllow(projectRoot: string): string[] {
  const path = settingsLocalPath(projectRoot);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    const allow = (parsed as { permissions?: { allow?: unknown } })?.permissions?.allow;
    return Array.isArray(allow) ? allow.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function isFullyAllowed(projectRoot: string): boolean {
  const allow = new Set(readAllow(projectRoot));
  return RAG_MCP_TOOLS.every((t) => allow.has(t));
}

export function _readMtimeMs(path: string): number {
  return statSync(path).mtimeMs;
}
