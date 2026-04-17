// Build an FTS5 MATCH expression from a user query.
//
// Strategy: extract alphanumeric tokens (including hangul), drop noise words,
// apply prefix match (`token*`) to each, and OR them together. No CamelCase
// splitting for v1 — FTS5 with the porter+unicode61 tokenizer handles most
// cases well enough; we can revisit if recall is poor after E2E testing.

const TOKEN_RE = /[\p{L}\p{N}_]{2,}/gu;
// FTS5 reserved words that can't appear unquoted.
const RESERVED = new Set(["AND", "OR", "NOT", "NEAR"]);

export function buildFtsQuery(query: string): string | null {
  const tokens = query.match(TOKEN_RE) ?? [];
  const filtered = tokens
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .map((t) => (RESERVED.has(t.toUpperCase()) ? `"${t}"` : t))
    // FTS5 prefix match
    .map((t) => (t.endsWith('"') ? t : `${t}*`));

  if (filtered.length === 0) return null;
  return filtered.join(" OR ");
}
