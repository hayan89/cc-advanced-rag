import { describe, test, expect, afterAll } from "bun:test";
import {
  autoDetectProvider,
  createEmbedder,
  embedInputText,
  PrivacyModeViolation,
  MissingApiKey,
} from "./embedder.ts";

describe("embedInputText", () => {
  test("joins signature + doc + content", () => {
    const text = embedInputText({
      signature: "function foo()",
      docComment: "does something",
      content: "function foo() { return 1; }",
    });
    expect(text).toContain("function foo()");
    expect(text).toContain("// does something");
    expect(text).toContain("return 1");
  });

  test("omits missing fields", () => {
    const text = embedInputText({
      signature: null,
      docComment: null,
      content: "just content",
    });
    expect(text).toBe("just content");
  });
});

describe("autoDetectProvider", () => {
  const origVoyage = process.env.VOYAGE_API_KEY;
  const origOpenAI = process.env.OPENAI_API_KEY;

  test("prefers voyage when VOYAGE_API_KEY is set", () => {
    process.env.VOYAGE_API_KEY = "test";
    delete process.env.OPENAI_API_KEY;
    expect(autoDetectProvider()).toBe("voyage");
  });

  test("falls back to openai when only OPENAI_API_KEY is set", () => {
    delete process.env.VOYAGE_API_KEY;
    process.env.OPENAI_API_KEY = "test";
    expect(autoDetectProvider()).toBe("openai");
  });

  test("falls back to ollama when no key is set", () => {
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    expect(autoDetectProvider()).toBe("ollama");
  });

  afterAll(() => {
    if (origVoyage !== undefined) process.env.VOYAGE_API_KEY = origVoyage;
    else delete process.env.VOYAGE_API_KEY;
    if (origOpenAI !== undefined) process.env.OPENAI_API_KEY = origOpenAI;
    else delete process.env.OPENAI_API_KEY;
  });
});

describe("createEmbedder", () => {
  test("creates a voyage embedder", () => {
    const embedder = createEmbedder({
      provider: "voyage",
      model: "voyage-code-3",
      dimension: 1024,
    });
    expect(embedder.config.provider).toBe("voyage");
  });

  test("creates an openai embedder", () => {
    const embedder = createEmbedder({
      provider: "openai",
      model: "text-embedding-3-small",
      dimension: 1536,
    });
    expect(embedder.config.provider).toBe("openai");
  });

  test("creates an ollama embedder", () => {
    const embedder = createEmbedder({
      provider: "ollama",
      model: "qwen3-embedding:0.6b",
      dimension: 1024,
    });
    expect(embedder.config.provider).toBe("ollama");
  });

  test("privacy mode rejects voyage", () => {
    expect(() =>
      createEmbedder({
        provider: "voyage",
        model: "voyage-code-3",
        dimension: 1024,
        privacyMode: true,
      }),
    ).toThrow(PrivacyModeViolation);
  });

  test("privacy mode rejects openai", () => {
    expect(() =>
      createEmbedder({
        provider: "openai",
        model: "text-embedding-3-small",
        dimension: 1536,
        privacyMode: true,
      }),
    ).toThrow(PrivacyModeViolation);
  });

  test("privacy mode allows ollama", () => {
    expect(
      createEmbedder({
        provider: "ollama",
        model: "qwen3-embedding:0.6b",
        dimension: 1024,
        privacyMode: true,
      }),
    ).toBeDefined();
  });
});

describe("embed() error paths", () => {
  test("voyage embedder throws MissingApiKey when VOYAGE_API_KEY is absent", async () => {
    const original = process.env.VOYAGE_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    try {
      const embedder = createEmbedder({
        provider: "voyage",
        model: "voyage-code-3",
        dimension: 1024,
      });
      await expect(embedder.embed(["hi"], { inputType: "query" })).rejects.toThrow(MissingApiKey);
    } finally {
      if (original !== undefined) process.env.VOYAGE_API_KEY = original;
    }
  });

  test("openai embedder throws MissingApiKey when OPENAI_API_KEY is absent", async () => {
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const embedder = createEmbedder({
        provider: "openai",
        model: "text-embedding-3-small",
        dimension: 1536,
      });
      await expect(embedder.embed(["hi"], { inputType: "query" })).rejects.toThrow(MissingApiKey);
    } finally {
      if (original !== undefined) process.env.OPENAI_API_KEY = original;
    }
  });

  test("empty input returns empty result without touching provider", async () => {
    const embedder = createEmbedder({
      provider: "voyage",
      model: "voyage-code-3",
      dimension: 1024,
    });
    const result = await embedder.embed([], { inputType: "query" });
    expect(result.vectors).toEqual([]);
    expect(result.provider).toBe("voyage");
  });
});
