import type { SupportedLanguage } from "../../config/schema.ts";
import type { LanguageParser, ParseResult } from "./types.ts";

type Loader = () => Promise<LanguageParser>;

const LOADERS: Record<SupportedLanguage, Loader> = {
  go: async () => (await import("./go.ts")).goParser,
  typescript: async () => (await import("./typescript.ts")).typescriptParser,
  tsx: async () => (await import("./typescript.ts")).tsxParser,
  javascript: async () => (await import("./typescript.ts")).javascriptParser,
  jsx: async () => (await import("./typescript.ts")).jsxParser,
  python: async () => (await import("./python.ts")).pythonParser,
  rust: async () => (await import("./rust.ts")).rustParser,
  java: async () => (await import("./java.ts")).javaParser,
  cpp: async () => (await import("./cpp.ts")).cppParser,
  csharp: async () => (await import("./csharp.ts")).csharpParser,
  svelte: async () => (await import("./svelte.ts")).svelteParser,
  sql: async () => (await import("./sql.ts")).sqlParser,
};

const loaded = new Map<SupportedLanguage, LanguageParser>();
const disabled = new Set<SupportedLanguage>();

export function isDisabled(lang: SupportedLanguage): boolean {
  return disabled.has(lang);
}

export function disableLanguage(lang: SupportedLanguage): void {
  disabled.add(lang);
}

export function resetRegistry(): void {
  loaded.clear();
  disabled.clear();
}

export async function getParser(lang: SupportedLanguage): Promise<LanguageParser | null> {
  if (disabled.has(lang)) return null;
  const cached = loaded.get(lang);
  if (cached) return cached;
  try {
    const parser = await LOADERS[lang]();
    loaded.set(lang, parser);
    return parser;
  } catch {
    disabled.add(lang);
    return null;
  }
}

export interface PreWarmLogger {
  warn(msg: string, meta?: unknown): void;
  info?(msg: string, meta?: unknown): void;
}

/**
 * config `languages`에 포함된 파서만 순차 pre-warm.
 * RSS 피크를 제한하기 위해 병렬이 아닌 순차 로드.
 * WASM 로드·초기 parse 실패 시 해당 언어만 disabled 처리.
 */
export async function preWarmParsers(
  languages: SupportedLanguage[],
  logger: PreWarmLogger = { warn: () => {} },
): Promise<{ loaded: SupportedLanguage[]; failed: SupportedLanguage[] }> {
  const ok: SupportedLanguage[] = [];
  const failed: SupportedLanguage[] = [];
  for (const lang of languages) {
    const parser = await getParser(lang);
    if (!parser) {
      failed.push(lang);
      logger.warn(`parser unavailable for ${lang}`);
      continue;
    }
    try {
      // 작은 소스로 1회 파싱해 WASM 실제 로드를 강제
      await parser.parse(`__preWarm__.${lang}`, "");
      ok.push(lang);
    } catch (err) {
      disabled.add(lang);
      loaded.delete(lang);
      failed.push(lang);
      logger.warn(`parser pre-warm failed for ${lang}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { loaded: ok, failed };
}

const EXT_MAP: Record<string, SupportedLanguage> = {
  ".go": "go",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "jsx",
  ".py": "python",
  ".pyi": "python",
  ".rs": "rust",
  ".java": "java",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".c": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".h": "cpp",
  ".cs": "csharp",
  ".svelte": "svelte",
  ".sql": "sql",
  ".pgsql": "sql",
  ".plpgsql": "sql",
  ".mysql": "sql",
};

export function detectLanguage(filePath: string): SupportedLanguage | null {
  const lower = filePath.toLowerCase();
  const idx = lower.lastIndexOf(".");
  if (idx < 0) return null;
  return EXT_MAP[lower.slice(idx)] ?? null;
}

/**
 * 파일 경로 확장자 기반으로 파서를 찾아 파싱한다.
 * config `languages`에 없으면 null 반환, WASM 로드 실패면 null.
 */
export async function parseFile(
  filePath: string,
  source: string,
  enabledLanguages: SupportedLanguage[],
): Promise<ParseResult | null> {
  const lang = detectLanguage(filePath);
  if (!lang) return null;
  if (!enabledLanguages.includes(lang)) return null;
  const parser = await getParser(lang);
  if (!parser) return null;
  return parser.parse(filePath, source);
}
