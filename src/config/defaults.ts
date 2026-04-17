import { ConfigSchema, type Config } from "./schema.ts";

/** A complete Config object populated with schema defaults. */
export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}

export const DEFAULT_CONFIG_PATH = ".claude/code-rag.config.json";
