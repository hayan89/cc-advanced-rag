import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIgnoreMatcher } from "./loader.ts";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ccrag-gitignore-"));
  mkdirSync(join(root, "node_modules"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, ".gitignore"),
    ["node_modules/", "*.log", "build.txt", "!build.txt.keep"].join("\n"),
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadIgnoreMatcher", () => {
  test("respects .gitignore when enabled", () => {
    const matcher = loadIgnoreMatcher({
      projectRoot: root,
      respectGitignore: true,
      extraPatterns: [],
    });
    expect(matcher.isIgnored("node_modules/foo/index.js")).toBe(true);
    expect(matcher.isIgnored("app.log")).toBe(true);
    expect(matcher.isIgnored("src/index.ts")).toBe(false);
  });

  test("skips .gitignore when disabled", () => {
    const matcher = loadIgnoreMatcher({
      projectRoot: root,
      respectGitignore: false,
      extraPatterns: [],
    });
    expect(matcher.isIgnored("node_modules/foo/index.js")).toBe(false);
    expect(matcher.isIgnored("app.log")).toBe(false);
  });

  test("extraPatterns merged with .gitignore", () => {
    const matcher = loadIgnoreMatcher({
      projectRoot: root,
      respectGitignore: true,
      extraPatterns: ["vendor/**", "**/*.min.js"],
    });
    expect(matcher.isIgnored("vendor/foo.ts")).toBe(true);
    expect(matcher.isIgnored("src/bundle.min.js")).toBe(true);
    expect(matcher.isIgnored("src/index.ts")).toBe(false);
  });

  test("negation pattern unignores a sibling file", () => {
    const matcher = loadIgnoreMatcher({
      projectRoot: root,
      respectGitignore: true,
      extraPatterns: [],
    });
    expect(matcher.isIgnored("build.txt")).toBe(true);
    expect(matcher.isIgnored("build.txt.keep")).toBe(false);
  });

  test("absolute path is normalized relative to root", () => {
    const matcher = loadIgnoreMatcher({
      projectRoot: root,
      respectGitignore: true,
      extraPatterns: [],
    });
    expect(matcher.isIgnored(join(root, "node_modules/foo/bar.js"))).toBe(true);
  });

  test("missing .gitignore is tolerated", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ccrag-nogi-"));
    try {
      const matcher = loadIgnoreMatcher({
        projectRoot: tmp,
        respectGitignore: true,
        extraPatterns: ["**/*.log"],
      });
      expect(matcher.isIgnored("a.log")).toBe(true);
      expect(matcher.isIgnored("a.ts")).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
