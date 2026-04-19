#!/usr/bin/env bun
// Thin orchestration wrapper invoked by the rag-bootstrap skill.
// The skill calls this script after the user answers the privacy question,
// passing `--provider=<voyage|ollama|openai>` and optionally `--privacy`.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ensureGitignoreEntries } from "../../../src/bootstrap/gitignore-append.ts";
import { installPostCommitHook } from "../../../src/bootstrap/install-git-hook.ts";
import { mergeSettings, MalformedSettingsError } from "../../../src/bootstrap/settings-merge.ts";

interface Args {
  provider: "voyage" | "ollama" | "openai";
  privacy: boolean;
  projectRoot: string;
  pluginRoot: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    provider: "voyage",
    privacy: false,
    projectRoot: process.cwd(),
    pluginRoot: resolve(import.meta.dir, "../../.."),
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--provider=")) {
      const v = arg.slice("--provider=".length);
      if (v === "voyage" || v === "ollama" || v === "openai") out.provider = v;
    } else if (arg === "--privacy") {
      out.privacy = true;
    } else if (arg.startsWith("--root=")) {
      out.projectRoot = resolve(arg.slice("--root=".length));
    }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv);
  const root = args.projectRoot;
  const configPath = join(root, ".claude/code-rag.config.json");

  // 1) Render config from template.
  if (!existsSync(configPath)) {
    const templatePath = join(args.pluginRoot, "templates/code-rag.config.json");
    const template = JSON.parse(readFileSync(templatePath, "utf-8")) as Record<string, unknown>;
    const embedding = (template.embedding ?? {}) as Record<string, unknown>;
    embedding.provider = args.provider;
    embedding.privacyMode = args.privacy;
    if (args.provider === "ollama") {
      embedding.model = "nomic-embed-text";
      embedding.dimension = 768;
    } else if (args.provider === "openai") {
      embedding.model = "text-embedding-3-small";
      embedding.dimension = 1536;
    }
    template.embedding = embedding;
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(template, null, 2) + "\n", "utf-8");
    console.log(`[rag-bootstrap] config written: ${configPath}`);
  } else {
    console.log(`[rag-bootstrap] config already exists: ${configPath}`);
  }

  // 2) Non-destructive .gitignore append.
  const ga = ensureGitignoreEntries(root);
  console.log(`[rag-bootstrap] .gitignore ${ga.action}: ${ga.path}`);

  // 3) Install post-commit hook (chain-call, idempotent).
  const hr = installPostCommitHook(root, args.pluginRoot);
  console.log(`[rag-bootstrap] post-commit hook ${hr.action}${hr.path ? `: ${hr.path}` : ""}`);

  // 4) Merge MCP tool auto-allow into <project>/.claude/settings.local.json.
  try {
    const sm = mergeSettings(root);
    console.log(`[rag-bootstrap] settings.local.json ${sm.action}: ${sm.path} (added=${sm.added.length})`);
  } catch (err) {
    if (err instanceof MalformedSettingsError) {
      console.error(`[rag-bootstrap] ${err.message}`);
    } else {
      console.error(
        `[rag-bootstrap] settings merge failed: ${err instanceof Error ? err.message : String(err)}. Run /rag-doctor.`,
      );
    }
  }

  console.log(
    `[rag-bootstrap] done. Next: run \`bun ${args.pluginRoot}/scripts/setup.sh\` then \`bun ${args.pluginRoot}/scripts/index.ts --full\`.`,
  );
}

if (import.meta.main) {
  main();
}
