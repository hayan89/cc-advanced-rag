import { VoyageAIClient } from "voyageai";
import OpenAI from "openai";

export type EmbedProvider = "voyage" | "ollama" | "openai";

export interface EmbedProviderConfig {
  provider: EmbedProvider;
  model: string;
  dimension: number;
  batchSize?: number;
  rateLimitPerMinute?: number;
  /** If true, disallow external providers (voyage, openai) and require Ollama. */
  privacyMode?: boolean;
}

export interface EmbedOptions {
  inputType: "document" | "query";
}

export interface EmbedResult {
  vectors: Float32Array[];
  provider: EmbedProvider;
}

export interface Embedder {
  config: EmbedProviderConfig;
  embed(texts: string[], options: EmbedOptions): Promise<EmbedResult>;
  /** Verify the provider is reachable and the dimension matches. Throws on mismatch. */
  healthCheck(): Promise<void>;
}

/** Build an embedder instance from a config object. */
export function createEmbedder(config: EmbedProviderConfig): Embedder {
  if (config.privacyMode && config.provider !== "ollama") {
    throw new PrivacyModeViolation(config.provider);
  }

  switch (config.provider) {
    case "voyage":
      return new VoyageEmbedder(config);
    case "openai":
      return new OpenAIEmbedder(config);
    case "ollama":
      return new OllamaEmbedder(config);
  }
}

/**
 * Decide which provider to use given current env. Caller config takes
 * precedence; falls back to Voyage if key present, else Ollama.
 */
export function autoDetectProvider(): EmbedProvider {
  if (process.env.VOYAGE_API_KEY) return "voyage";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "ollama";
}

/** Input text for document embedding: signature + doc + content. */
export function embedInputText(chunk: {
  signature: string | null;
  docComment: string | null;
  content: string;
}): string {
  const parts: string[] = [];
  if (chunk.signature) parts.push(chunk.signature);
  if (chunk.docComment) parts.push(`// ${chunk.docComment}`);
  parts.push(chunk.content);
  return parts.join("\n");
}

// ────────────────────────────────────────────────────────────────────────
// Shared helpers
// ────────────────────────────────────────────────────────────────────────

function toFloat32Array(arr: number[]): Float32Array {
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i]!;
  return out;
}

/**
 * L2-normalize a vector in place and return it. Required so that sqlite-vec's
 * default L2 distance corresponds to cosine distance (norm=1 → L2² = 2(1-cos)).
 * Zero vectors are returned unchanged — the caller will see distance ≥ 2.
 */
export function normalizeL2(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i]! * vec[i]!;
  if (sumSq === 0) return vec;
  const inv = 1 / Math.sqrt(sumSq);
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! * inv;
  return vec;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) break;
      const delay = baseMs * 2 ** i + Math.random() * 250;
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Naive rate limiter: cap requests per minute by tracking timestamps.
 * For the indexing workload this is sufficient — we're not optimizing for
 * burst handling.
 */
class RateLimiter {
  private readonly perMinute: number;
  private readonly windowMs = 60_000;
  private timestamps: number[] = [];

  constructor(perMinute: number) {
    this.perMinute = perMinute;
  }

  async wait(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    if (this.timestamps.length >= this.perMinute) {
      const waitMs = this.windowMs - (now - this.timestamps[0]!);
      await sleep(Math.max(0, waitMs));
    }
    this.timestamps.push(Date.now());
  }
}

// ────────────────────────────────────────────────────────────────────────
// Voyage
// ────────────────────────────────────────────────────────────────────────

class VoyageEmbedder implements Embedder {
  readonly config: EmbedProviderConfig;
  private client: VoyageAIClient | null = null;
  private readonly limiter: RateLimiter;

  constructor(config: EmbedProviderConfig) {
    this.config = config;
    this.limiter = new RateLimiter(config.rateLimitPerMinute ?? 1000);
  }

  private getClient(): VoyageAIClient {
    if (!this.client) {
      const apiKey = process.env.VOYAGE_API_KEY;
      if (!apiKey) throw new MissingApiKey("VOYAGE_API_KEY");
      this.client = new VoyageAIClient({ apiKey });
    }
    return this.client;
  }

  async embed(texts: string[], options: EmbedOptions): Promise<EmbedResult> {
    if (texts.length === 0) return { vectors: [], provider: "voyage" };

    const client = this.getClient();
    const batchSize = this.config.batchSize ?? 128;
    const out: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      await this.limiter.wait();
      const batch = texts.slice(i, i + batchSize);
      const resp = await withRetry(() =>
        client.embed({
          input: batch,
          model: this.config.model,
          inputType: options.inputType,
          outputDimension: this.config.dimension,
        }),
      );
      if (!resp.data) throw new Error("Voyage: response missing data");
      for (const item of resp.data) {
        if (!item.embedding) throw new Error("Voyage: embedding missing");
        out.push(normalizeL2(toFloat32Array(item.embedding)));
      }
    }
    return { vectors: out, provider: "voyage" };
  }

  async healthCheck(): Promise<void> {
    const result = await this.embed(["ping"], { inputType: "query" });
    if (result.vectors.length !== 1 || result.vectors[0]!.length !== this.config.dimension) {
      throw new DimensionSizeMismatch(result.vectors[0]?.length ?? 0, this.config.dimension);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// OpenAI
// ────────────────────────────────────────────────────────────────────────

class OpenAIEmbedder implements Embedder {
  readonly config: EmbedProviderConfig;
  private client: OpenAI | null = null;
  private readonly limiter: RateLimiter;

  constructor(config: EmbedProviderConfig) {
    this.config = config;
    this.limiter = new RateLimiter(config.rateLimitPerMinute ?? 3000);
  }

  private getClient(): OpenAI {
    if (!this.client) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new MissingApiKey("OPENAI_API_KEY");
      this.client = new OpenAI({ apiKey });
    }
    return this.client;
  }

  async embed(texts: string[], _options: EmbedOptions): Promise<EmbedResult> {
    if (texts.length === 0) return { vectors: [], provider: "openai" };
    const client = this.getClient();
    const batchSize = this.config.batchSize ?? 128;
    const out: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      await this.limiter.wait();
      const batch = texts.slice(i, i + batchSize);
      const resp = await withRetry(() =>
        client.embeddings.create({
          model: this.config.model,
          input: batch,
          dimensions: this.config.dimension,
        }),
      );
      for (const item of resp.data) out.push(normalizeL2(toFloat32Array(item.embedding)));
    }
    return { vectors: out, provider: "openai" };
  }

  async healthCheck(): Promise<void> {
    const result = await this.embed(["ping"], { inputType: "query" });
    if (result.vectors[0]?.length !== this.config.dimension) {
      throw new DimensionSizeMismatch(result.vectors[0]?.length ?? 0, this.config.dimension);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Ollama (local)
// ────────────────────────────────────────────────────────────────────────

class OllamaEmbedder implements Embedder {
  readonly config: EmbedProviderConfig;
  private readonly baseUrl: string;
  private readonly limiter: RateLimiter;

  constructor(config: EmbedProviderConfig) {
    this.config = config;
    this.baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
    // Ollama is local — rate limits aren't about API cost but about saturation.
    this.limiter = new RateLimiter(config.rateLimitPerMinute ?? 600);
  }

  async embed(texts: string[], _options: EmbedOptions): Promise<EmbedResult> {
    if (texts.length === 0) return { vectors: [], provider: "ollama" };
    const out: Float32Array[] = [];
    for (const text of texts) {
      await this.limiter.wait();
      const resp = await withRetry(async () => {
        const r = await fetch(`${this.baseUrl}/api/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.config.model, prompt: text }),
        });
        if (!r.ok) {
          throw new Error(`Ollama embeddings ${r.status}: ${await r.text()}`);
        }
        return (await r.json()) as { embedding: number[] };
      });
      if (!resp.embedding) throw new Error("Ollama: embedding missing");
      out.push(normalizeL2(toFloat32Array(resp.embedding)));
    }
    return { vectors: out, provider: "ollama" };
  }

  async healthCheck(): Promise<void> {
    const result = await this.embed(["ping"], { inputType: "query" });
    if (result.vectors[0]?.length !== this.config.dimension) {
      throw new DimensionSizeMismatch(result.vectors[0]?.length ?? 0, this.config.dimension);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────────────

export class MissingApiKey extends Error {
  constructor(varName: string) {
    super(`Missing environment variable: ${varName}`);
    this.name = "MissingApiKey";
  }
}

export class DimensionSizeMismatch extends Error {
  constructor(actual: number, expected: number) {
    super(`Embedding dimension from provider (${actual}) != config.dimension (${expected}).`);
    this.name = "DimensionSizeMismatch";
  }
}

export class PrivacyModeViolation extends Error {
  constructor(provider: EmbedProvider) {
    super(`privacyMode is enabled but provider is '${provider}'. Only 'ollama' is allowed.`);
    this.name = "PrivacyModeViolation";
  }
}
