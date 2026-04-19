import type { Config } from "../config/schema.ts";

export interface CompiledTagRule {
  /** Output tag name to attach when the pattern matches. */
  tag: string;
  /** Regular expression pattern matched against (filePath + "\n" + content). */
  pattern: RegExp;
}

export class InvalidTagRegex extends Error {
  constructor(
    public readonly rule: string,
    public override readonly cause: unknown,
  ) {
    super(
      `Invalid regex for tag rule "${rule}": ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "InvalidTagRegex";
  }
}

/**
 * Compile `config.tagging.customTags` to JS RegExps once per index run.
 * Throws `InvalidTagRegex` if any pattern fails to compile.
 */
export function compileTagRules(config: Config): CompiledTagRule[] {
  const rules: CompiledTagRule[] = [];
  for (const rule of config.tagging.customTags) {
    try {
      rules.push({ tag: rule.name, pattern: new RegExp(rule.regex) });
    } catch (err) {
      throw new InvalidTagRegex(rule.name, err);
    }
  }
  return rules;
}

/**
 * Apply compiled rules to a (filePath, content) pair and return the set of
 * tags that matched. Matches over `<filePath>\n<content>` so rules can target
 * either path segments or code tokens.
 */
export function applyTagRules(
  rules: CompiledTagRule[],
  inputs: { filePath: string; content: string },
): string[] {
  if (rules.length === 0) return [];
  const haystack = `${inputs.filePath}\n${inputs.content}`;
  const tags: string[] = [];
  for (const { tag, pattern } of rules) {
    if (pattern.test(haystack)) tags.push(tag);
  }
  return tags;
}

/**
 * Merge base tags (from parser) with custom tags (from config).
 * De-duplicates while preserving first-seen order.
 */
export function mergeTags(base: string[], extra: string[]): string[] {
  if (extra.length === 0) return base;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of base) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  for (const t of extra) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}
