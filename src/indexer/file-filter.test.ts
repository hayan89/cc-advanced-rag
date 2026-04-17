import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide } from "./file-filter.ts";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ccrag-filter-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("file-filter", () => {
  test("accepts a normal small text file", () => {
    const p = join(root, "hello.ts");
    writeFileSync(p, "export const hi = 'world';");
    const d = decide(p);
    expect(d.skip).toBe(false);
    expect(d.reason).toBe("ok");
  });

  test("rejects files larger than maxFileSizeBytes", () => {
    const p = join(root, "big.ts");
    writeFileSync(p, "x".repeat(2000));
    const d = decide(p, { maxFileSizeBytes: 1000 });
    expect(d.skip).toBe(true);
    expect(d.reason).toBe("too-large");
    expect(d.sizeBytes).toBe(2000);
  });

  test("rejects files containing null bytes (binary heuristic)", () => {
    const p = join(root, "image.bin");
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x1a, 0x0a]);
    writeFileSync(p, buf);
    const d = decide(p);
    expect(d.skip).toBe(true);
    expect(d.reason).toBe("binary");
  });

  test("can disable binary detection", () => {
    const p = join(root, "still-null.bin");
    writeFileSync(p, Buffer.from([0, 1, 2, 3]));
    const d = decide(p, { binaryDetect: false });
    expect(d.skip).toBe(false);
    expect(d.reason).toBe("ok");
  });

  test("skips symlinks by default", () => {
    const target = join(root, "target.ts");
    const link = join(root, "link.ts");
    writeFileSync(target, "x");
    symlinkSync(target, link);
    const d = decide(link);
    expect(d.skip).toBe(true);
    expect(d.reason).toBe("symlink");
  });

  test("follows symlinks when enabled", () => {
    const target = join(root, "follow-target.ts");
    const link = join(root, "follow-link.ts");
    writeFileSync(target, "y");
    symlinkSync(target, link);
    const d = decide(link, { followSymlinks: true });
    expect(d.skip).toBe(false);
    expect(d.reason).toBe("ok");
  });

  test("handles missing files gracefully", () => {
    const d = decide(join(root, "does-not-exist.ts"));
    expect(d.skip).toBe(true);
    expect(d.reason).toBe("missing");
  });

  test("rejects directories (not-file)", () => {
    const d = decide(root);
    expect(d.skip).toBe(true);
    expect(d.reason).toBe("not-file");
  });
});
