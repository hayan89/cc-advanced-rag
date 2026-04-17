import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseConfig, ConfigError } from "./loader.ts";
import { defaultConfig } from "./defaults.ts";

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "ccrag-cfg-"));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("defaultConfig", () => {
  test("produces a valid Config with schema defaults", () => {
    const cfg = defaultConfig();
    expect(cfg.dbPath).toBe(".claude/code-rag.db");
    expect(cfg.embedding.provider).toBe("voyage");
    expect(cfg.embedding.dimension).toBe(1024);
    expect(cfg.indexing.maxFileSizeBytes).toBe(1_048_576);
    expect(cfg.cache.l1TtlHours).toBe(24);
    expect(cfg.gitignoreRespect).toBe(true);
    expect(cfg.scope).toBeNull();
  });
});

describe("parseConfig - valid inputs", () => {
  test("accepts an empty object (all defaults)", () => {
    const cfg = parseConfig({});
    expect(cfg.embedding.provider).toBe("voyage");
  });

  test("accepts a fully specified config", () => {
    const raw = {
      dbPath: "custom/path.db",
      logPath: "custom/log.log",
      lockPath: "custom/lock",
      embedding: {
        provider: "openai",
        model: "text-embedding-3-large",
        dimension: 3072,
        batchSize: 50,
        rateLimitPerMinute: 500,
        privacyMode: false,
      },
      languages: ["python", "rust"],
      scope: ["src/**"],
      gitignoreRespect: false,
      exclude: ["*.tmp"],
      indexing: {
        maxFileSizeBytes: 2_000_000,
        followSymlinks: true,
        binaryDetect: false,
      },
      tagging: {
        customTags: [{ name: "res", regex: "\\bfoo\\b" }],
      },
      cache: { l1TtlHours: 48 },
    };
    const cfg = parseConfig(raw);
    expect(cfg.embedding.provider).toBe("openai");
    expect(cfg.languages).toEqual(["python", "rust"]);
    expect(cfg.scope).toEqual(["src/**"]);
    expect(cfg.tagging.customTags).toHaveLength(1);
  });

  test("privacyMode is respected when set", () => {
    const cfg = parseConfig({
      embedding: { provider: "ollama", privacyMode: true },
    });
    expect(cfg.embedding.privacyMode).toBe(true);
  });
});

describe("parseConfig - invalid inputs", () => {
  test("rejects unknown top-level keys (strict schema)", () => {
    expect(() => parseConfig({ notAField: "x" })).toThrow(ConfigError);
  });

  test("rejects unknown embedding keys", () => {
    expect(() => parseConfig({ embedding: { provider: "voyage", unknown: true } })).toThrow(
      ConfigError,
    );
  });

  test("rejects invalid provider enum", () => {
    expect(() => parseConfig({ embedding: { provider: "unknown" } })).toThrow(ConfigError);
  });

  test("rejects invalid language enum", () => {
    expect(() => parseConfig({ languages: ["klingon"] })).toThrow(ConfigError);
  });

  test("rejects negative dimension", () => {
    expect(() => parseConfig({ embedding: { dimension: -1 } })).toThrow(ConfigError);
  });

  test("rejects dimension above max", () => {
    expect(() => parseConfig({ embedding: { dimension: 100000 } })).toThrow(ConfigError);
  });

  test("rejects invalid customTag shape", () => {
    expect(() =>
      parseConfig({ tagging: { customTags: [{ name: "" }] } }),
    ).toThrow(ConfigError);
  });

  test("includes field path in error message", () => {
    try {
      parseConfig({ embedding: { provider: "not-a-provider" } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain("embedding.provider");
    }
  });
});

describe("loadConfig from file", () => {
  test("loads a valid config JSON", () => {
    const p = join(tmp, "valid.json");
    writeFileSync(p, JSON.stringify({ embedding: { dimension: 512 } }));
    const cfg = loadConfig(p);
    expect(cfg.embedding.dimension).toBe(512);
  });

  test("throws on missing file", () => {
    expect(() => loadConfig(join(tmp, "nope.json"))).toThrow(ConfigError);
  });

  test("throws on invalid JSON", () => {
    const p = join(tmp, "malformed.json");
    writeFileSync(p, "{ this is not json");
    expect(() => loadConfig(p)).toThrow(ConfigError);
  });

  test("throws on invalid schema", () => {
    const p = join(tmp, "bad-schema.json");
    writeFileSync(p, JSON.stringify({ embedding: { provider: "unknown" } }));
    expect(() => loadConfig(p)).toThrow(ConfigError);
  });
});

describe("ConfigSchema exports", () => {
  test("SUPPORTED_LANGUAGES includes C#", () => {
    const cfg = parseConfig({ languages: ["csharp"] });
    expect(cfg.languages).toContain("csharp");
  });
});
