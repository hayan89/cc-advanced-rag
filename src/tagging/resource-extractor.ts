/**
 * Resource-name extraction for cross-stack code matching.
 *
 * Given a file path (and optionally a symbol name), derive one or more
 * `resource:<kebab-name>` tags that describe the *domain resource* the code
 * touches (e.g. `resource:receipt-upload`). Two chunks that carry the same
 * resource tag are treated as cross-stack references — e.g. a Go handler and
 * its Svelte route — even when they live in different directory buckets.
 *
 * This module is pure: no I/O, no DB access. The indexer calls it once per
 * file (path-only) and once per chunk (path + symbol) and merges the result
 * into the regular tag set.
 */

import { tokenize } from "./case-normalize.ts";

export interface ExtractorOpts {
  /** Path segments dropped from the resource name (handlers, routes, …). */
  structuralBuckets: Set<string>;
  /** Tokens dropped when they appear alone (auth, user, index, …). */
  stopwords: Set<string>;
  /** Symbol-name suffixes stripped before tokenization (Handler, Service, …). */
  symbolSuffixes: string[];
  /** Glob-style path filters; empty = unrestricted. */
  includePaths: string[];
  /** Glob-style path blocks; takes precedence over includePaths. */
  excludePaths: string[];
}

export interface ExtractorInput {
  filePath: string;
  symbolName?: string | null;
}

export const DEFAULT_STRUCTURAL_BUCKETS = new Set<string>([
  "src",
  "lib",
  "app",
  "pkg",
  "internal",
  "cmd",
  "api",
  "handlers",
  "services",
  "models",
  "repository",
  "middleware",
  "worker",
  "routes",
  "components",
  "hooks",
  "controllers",
  "utils",
  "helpers",
  "store",
  "stores",
  "frontend",
  "backend",
]);

export const DEFAULT_SYMBOL_SUFFIXES = [
  "Handler",
  "Handlers",
  "Service",
  "Services",
  "Controller",
  "Controllers",
  "Store",
  "Stores",
  "Api",
  "API",
  "Route",
  "Routes",
  "Repository",
  "Repo",
  "Model",
  // Queue / worker / job family — keeps symbol-derived tags aligned with
  // structuralBuckets entries like `worker/` so handler↔worker pairs can
  // converge on the same resource tag.
  "Worker",
  "Workers",
  "Consumer",
  "Consumers",
  "Producer",
  "Producers",
  "Publisher",
  "Publishers",
  "Subscriber",
  "Subscribers",
  "Processor",
  "Processors",
  "Job",
  "Jobs",
  "Task",
  "Tasks",
];

const FILENAME_SKIPLIST = new Set<string>([
  "index",
  "main",
  "mod",
  "router",
  "routes",
  "layout",
  "page",
  "server",
  "+page",
  "+layout",
  "+server",
  "+error",
]);

const TEST_TOKENS = new Set<string>(["test", "tests", "spec", "specs"]);

/** Minimum final tag length after kebab normalization. */
const MIN_RESOURCE_LEN = 3;

/**
 * Convert a simple glob to a RegExp. Supports:
 *   - `*`   — any run of non-slash chars
 *   - `**`  — any chars including slashes
 *   - double-star prefix — optional leading path segments so a leading
 *     double-star slash pattern also matches the resource at the project root.
 */
function globToRegExp(glob: string): RegExp {
  let out = "^";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        // `**/` → zero-or-more leading segments.
        out += "(?:.*\\/)?";
        i += 3;
        continue;
      }
      // Bare `**` (including at end) — any chars including `/`.
      out += ".*";
      i += 2;
      continue;
    }
    if (ch === "*") {
      out += "[^/]*";
      i++;
      continue;
    }
    // Escape regex metacharacters (but NOT `/` since we use the default flavor).
    if (".+^${}()|[]\\".includes(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
    i++;
  }
  out += "$";
  return new RegExp(out);
}

function matchesAny(path: string, globs: string[]): boolean {
  if (globs.length === 0) return false;
  return globs.some((g) => globToRegExp(g).test(path));
}

function stripFilenameExtras(name: string): string {
  // Remove everything after first `.`: `receiptUpload.test.ts` → `receiptUpload`.
  // SvelteKit route files like `+page.svelte` are handled by the skiplist below.
  const dot = name.indexOf(".");
  return dot === -1 ? name : name.slice(0, dot);
}

function stripSymbolSuffix(name: string, suffixes: string[]): string {
  for (const suffix of suffixes) {
    if (name.endsWith(suffix) && name.length > suffix.length) {
      return name.slice(0, -suffix.length);
    }
  }
  return name;
}

/**
 * Filter tokens used for resource naming. Drops test-related tokens, empty
 * strings, and pure stopword singletons. A kept token must contain at least
 * one letter (so bare digits like `"2"` do not become resources).
 */
function meaningfulTokens(tokens: string[], stopwords: Set<string>): string[] {
  const filtered = tokens.filter((t) => t.length > 0 && !TEST_TOKENS.has(t) && /[a-z]/.test(t));
  if (filtered.length === 0) return [];
  // If the only surviving tokens are all stopwords, drop everything.
  if (filtered.every((t) => stopwords.has(t))) return [];
  // Otherwise, remove stopword tokens from the sequence but keep ordering.
  return filtered.filter((t) => !stopwords.has(t));
}

/**
 * Extract `resource:<kebab>` tags from a file path and optional symbol name.
 * Deduplicated, order-preserving. Returns `[]` when the filter rejects the
 * path or no meaningful tokens remain.
 */
export function extractResourceTags(
  input: ExtractorInput,
  opts: ExtractorOpts,
): string[] {
  const { filePath, symbolName } = input;
  if (!filePath) return [];

  // Rule 0 — path filter (opt-in scope control for consumers).
  if (matchesAny(filePath, opts.excludePaths)) return [];
  if (opts.includePaths.length > 0 && !matchesAny(filePath, opts.includePaths)) return [];

  const segments = filePath.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return [];

  // Rule 1-3 — path-derived resource name.
  const pathResource = derivePathResource(segments, opts);

  // Rule 4 — symbol-derived resource name.
  const symbolResource = symbolName
    ? deriveSymbolResource(symbolName, opts)
    : [];

  // Rule 6 — hierarchical nested resources.
  //   handlers/receipt/upload.go → `resource:receipt`, `resource:receipt-upload`
  const nestedResources = deriveNestedResources(segments, opts);

  const tags = new Set<string>();
  for (const r of [...pathResource, ...nestedResources, ...symbolResource]) {
    if (r.length >= MIN_RESOURCE_LEN) tags.add(`resource:${r}`);
  }
  return Array.from(tags);
}

function derivePathResource(segments: string[], opts: ExtractorOpts): string[] {
  // Work on a copy with extension + filename-extras stripped from the leaf.
  const parts = segments.slice();
  parts[parts.length - 1] = stripFilenameExtras(parts[parts.length - 1]!);

  // Drop structural buckets entirely.
  const filtered = parts.filter((p) => !opts.structuralBuckets.has(p));
  if (filtered.length === 0) return [];

  const leaf = filtered[filtered.length - 1]!;
  // If the leaf is a generic framework filename (index, +page, router, …),
  // fall back to the directory above it.
  if (FILENAME_SKIPLIST.has(leaf.toLowerCase())) {
    if (filtered.length < 2) return [];
    const parent = filtered[filtered.length - 2]!;
    if (opts.structuralBuckets.has(parent) || FILENAME_SKIPLIST.has(parent.toLowerCase())) {
      return [];
    }
    return resourceFromIdentifier(parent, opts);
  }
  return resourceFromIdentifier(leaf, opts);
}

function deriveNestedResources(segments: string[], opts: ExtractorOpts): string[] {
  const parts = segments.slice();
  parts[parts.length - 1] = stripFilenameExtras(parts[parts.length - 1]!);

  const meaningful = parts.filter(
    (p) => !opts.structuralBuckets.has(p) && !FILENAME_SKIPLIST.has(p.toLowerCase()),
  );
  if (meaningful.length < 2) return [];

  // Take the last two meaningful segments and emit both `parent` and
  // `parent-child` forms. Deeper nesting collapses to those two levels to
  // keep the tag surface bounded.
  const parent = meaningful[meaningful.length - 2]!;
  const child = meaningful[meaningful.length - 1]!;

  const parentKebab = meaningfulKebab(parent, opts);
  const childKebab = meaningfulKebab(child, opts);
  if (!parentKebab || !childKebab) return [];

  const combined = `${parentKebab}-${childKebab}`;
  const out: string[] = [];
  if (parentKebab.length >= MIN_RESOURCE_LEN) out.push(parentKebab);
  if (combined.length >= MIN_RESOURCE_LEN) out.push(combined);
  return out;
}

function deriveSymbolResource(symbolName: string, opts: ExtractorOpts): string[] {
  const stripped = stripSymbolSuffix(symbolName, opts.symbolSuffixes);
  return resourceFromIdentifier(stripped, opts);
}

/**
 * Tokenize an identifier, filter out stopwords/test-tokens, and emit a single
 * kebab-case string. Returns `[]` when nothing meaningful survives.
 */
function resourceFromIdentifier(id: string, opts: ExtractorOpts): string[] {
  const kebab = meaningfulKebab(id, opts);
  return kebab ? [kebab] : [];
}

function meaningfulKebab(id: string, opts: ExtractorOpts): string | null {
  const tokens = meaningfulTokens(tokenize(id), opts.stopwords);
  if (tokens.length === 0) return null;
  const kebab = tokens.join("-");
  return kebab.length >= MIN_RESOURCE_LEN ? kebab : null;
}

/** Default options mirroring the config schema defaults. */
export function defaultExtractorOpts(overrides?: Partial<ExtractorOpts>): ExtractorOpts {
  return {
    structuralBuckets: overrides?.structuralBuckets ?? DEFAULT_STRUCTURAL_BUCKETS,
    stopwords:
      overrides?.stopwords ??
      new Set([
        "index",
        "util",
        "helper",
        "types",
        "common",
        "main",
        "auth",
        "user",
        "config",
        // Message / job infrastructure tokens — drops the suffix half of
        // path leaves like `ocr_worker` or symbols like `publishOcrJob`
        // so handler↔worker↔job entries converge on the domain token.
        "worker",
        "workers",
        "job",
        "jobs",
        "task",
        "tasks",
        "consumer",
        "producer",
        "publisher",
        "subscriber",
        "processor",
        "publish",
        "consume",
        "subscribe",
        "handle",
        "process",
      ]),
    symbolSuffixes: overrides?.symbolSuffixes ?? DEFAULT_SYMBOL_SUFFIXES,
    includePaths: overrides?.includePaths ?? [],
    excludePaths: overrides?.excludePaths ?? [],
  };
}

/** Resolve a tag's weight: `resource:*` tags use `resourceWeight`, rest → 1. */
export function tagWeight(tag: string, resourceWeight: number): number {
  return tag.startsWith("resource:") ? resourceWeight : 1;
}
