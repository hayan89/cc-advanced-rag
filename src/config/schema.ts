import { z } from "zod";

export const SUPPORTED_LANGUAGES = [
  "go",
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "python",
  "rust",
  "java",
  "cpp",
  "csharp",
  "svelte",
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const EmbedProviderSchema = z.enum(["voyage", "ollama", "openai"]);

export const EmbeddingConfigSchema = z
  .object({
    provider: EmbedProviderSchema.default("voyage"),
    model: z.string().min(1).default("voyage-code-3"),
    dimension: z.number().int().positive().max(65536).default(1024),
    batchSize: z.number().int().positive().default(128),
    rateLimitPerMinute: z.number().int().positive().default(1000),
    privacyMode: z.boolean().default(false),
  })
  .strict();

export const IndexingConfigSchema = z
  .object({
    maxFileSizeBytes: z.number().int().positive().default(1_048_576),
    followSymlinks: z.boolean().default(false),
    binaryDetect: z.boolean().default(true),
  })
  .strict();

export const CustomTagSchema = z
  .object({
    name: z.string().min(1),
    regex: z.string().min(1),
  })
  .strict();

export const TaggingConfigSchema = z
  .object({
    customTags: z.array(CustomTagSchema).default([]),
  })
  .strict();

export const CacheConfigSchema = z
  .object({
    l1TtlHours: z.number().int().positive().default(24),
    l2Enabled: z.boolean().default(true),
    l2SimilarityThreshold: z.number().min(0.85).max(0.99).default(0.95),
    l2TtlHours: z.number().int().positive().default(24),
    l2MaxEntries: z.number().int().positive().default(1000),
  })
  .strict();

export const ConfigSchema = z
  .object({
    $schema: z.string().optional(),
    dbPath: z.string().default(".claude/code-rag.db"),
    logPath: z.string().default(".claude/code-rag.log"),
    lockPath: z.string().default(".claude/code-rag.lock"),
    embedding: EmbeddingConfigSchema.default({}),
    languages: z.array(z.enum(SUPPORTED_LANGUAGES)).default(["typescript", "tsx", "javascript", "jsx"]),
    /** Optional glob patterns to limit indexing to a subset of the project. null = full project. */
    scope: z.array(z.string()).nullable().default(null),
    gitignoreRespect: z.boolean().default(true),
    exclude: z.array(z.string()).default(["node_modules/**", "vendor/**", ".git/**", "dist/**", "build/**"]),
    indexing: IndexingConfigSchema.default({}),
    tagging: TaggingConfigSchema.default({ customTags: [] }),
    cache: CacheConfigSchema.default({
      l1TtlHours: 24,
      l2Enabled: true,
      l2SimilarityThreshold: 0.95,
      l2TtlHours: 24,
      l2MaxEntries: 1000,
    }),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;
export type IndexingConfig = z.infer<typeof IndexingConfigSchema>;
