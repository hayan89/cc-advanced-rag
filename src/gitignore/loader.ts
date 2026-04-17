import ignore, { type Ignore } from "ignore";
import { readFileSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export interface IgnoreMatcher {
  /** Test whether a path (relative to projectRoot) should be skipped. */
  isIgnored(relativePath: string): boolean;
  /** Absolute root the matcher was built against. */
  root: string;
}

export interface LoadIgnoreOptions {
  projectRoot: string;
  respectGitignore: boolean;
  extraPatterns: string[];
}

/**
 * Build an ignore matcher that fuses the project's `.gitignore` (optional)
 * with `config.exclude` globs. All paths passed to `isIgnored` are expected
 * to be relative to `projectRoot`.
 */
export function loadIgnoreMatcher(opts: LoadIgnoreOptions): IgnoreMatcher {
  const root = resolve(opts.projectRoot);
  const ig: Ignore = ignore();

  if (opts.respectGitignore) {
    const gitignorePath = join(root, ".gitignore");
    if (existsSync(gitignorePath)) {
      ig.add(readFileSync(gitignorePath, "utf-8"));
    }
  }

  if (opts.extraPatterns.length > 0) {
    ig.add(opts.extraPatterns);
  }

  return {
    root,
    isIgnored(relativePath: string): boolean {
      const rel = normalizeRelative(relativePath, root);
      if (rel.length === 0) return false;
      return ig.ignores(rel);
    },
  };
}

function normalizeRelative(p: string, root: string): string {
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) {
    return relative(root, p).split("\\").join("/");
  }
  return p.split("\\").join("/");
}
