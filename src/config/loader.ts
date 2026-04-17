import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { ConfigSchema, type Config } from "./schema.ts";
import { DEFAULT_CONFIG_PATH } from "./defaults.ts";

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Load and validate a config file. Missing file = ConfigError (caller decides
 * whether to fall back to defaults).
 */
export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): Config {
  const abs = resolve(configPath);
  if (!existsSync(abs)) {
    throw new ConfigError(`Config not found: ${abs}`);
  }
  let raw: string;
  try {
    raw = readFileSync(abs, "utf-8");
  } catch (err) {
    throw new ConfigError(`Failed to read ${abs}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Invalid JSON in ${abs}: ${(err as Error).message}`);
  }

  return parseConfig(parsed, abs);
}

/**
 * Parse an already-read config object (e.g., for tests or programmatic use).
 */
export function parseConfig(obj: unknown, source = "<memory>"): Config {
  const result = ConfigSchema.safeParse(obj);
  if (!result.success) {
    throw new ConfigError(
      `Invalid config at ${source}: ${formatZodError(result.error)}`,
      result.error.format(),
    );
  }
  return result.data;
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((iss) => `[${iss.path.join(".") || "<root>"}] ${iss.message}`)
    .join("; ");
}
