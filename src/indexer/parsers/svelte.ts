import type { CodeChunk, FileMetadata, LanguageParser, ParseResult } from "./types.ts";
import { computeSignatureHash, hashSource } from "./common.ts";
import { parseTypeScriptSource } from "./typescript.ts";

interface ScriptBlock {
  content: string;
  startLine: number;
  context: "default" | "module";
}

function extractScriptBlocks(source: string): {
  scripts: ScriptBlock[];
  templateRanges: Array<{ startLine: number; endLine: number }>;
} {
  const scripts: ScriptBlock[] = [];
  const consumed: Array<[number, number]> = [];

  const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = scriptRegex.exec(source)) !== null) {
    const [full, attrs, body] = m;
    if (!full) continue;
    const openEnd = m.index + full.indexOf(">") + 1;
    const startLine = source.slice(0, openEnd).split("\n").length - 1;
    const context = /context\s*=\s*["']module["']/i.test(attrs ?? "") ? "module" : "default";
    scripts.push({ content: body ?? "", startLine, context });
    consumed.push([m.index, m.index + full.length]);
  }

  const styleRegex = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
  while ((m = styleRegex.exec(source)) !== null) {
    const [full] = m;
    if (!full) continue;
    consumed.push([m.index, m.index + full.length]);
  }

  consumed.sort((a, b) => a[0] - b[0]);
  const templateRanges: Array<{ startLine: number; endLine: number }> = [];
  let cursor = 0;
  for (const [s, e] of consumed) {
    if (cursor < s) {
      const text = source.slice(cursor, s);
      if (text.trim().length > 0) {
        templateRanges.push({
          startLine: source.slice(0, cursor).split("\n").length,
          endLine: source.slice(0, s).split("\n").length,
        });
      }
    }
    cursor = Math.max(cursor, e);
  }
  if (cursor < source.length && source.slice(cursor).trim().length > 0) {
    templateRanges.push({
      startLine: source.slice(0, cursor).split("\n").length,
      endLine: source.split("\n").length,
    });
  }
  return { scripts, templateRanges };
}

async function parse(filePath: string, source: string): Promise<ParseResult> {
  const { scripts, templateRanges } = extractScriptBlocks(source);
  const chunks: CodeChunk[] = [];
  const symbols: FileMetadata["symbols"] = [];
  const importSet = new Set<string>();
  const signatureParts: string[] = [];

  for (const script of scripts) {
    if (script.content.trim().length === 0) continue;
    const sub = await parseTypeScriptSource(
      filePath,
      script.content,
      "typescript",
      script.startLine,
      "svelte",
    );
    for (const chunk of sub.chunks) {
      const tags = new Set(chunk.tags);
      tags.add("svelte");
      if (script.context === "module") tags.add("svelte-module");
      chunks.push({ ...chunk, tags: Array.from(tags), language: "svelte" });
    }
    for (const sym of sub.metadata.symbols) symbols.push(sym);
    for (const imp of sub.metadata.imports) importSet.add(imp);
    signatureParts.push(sub.signatureHash);
  }

  if (templateRanges.length > 0) {
    const startLine = templateRanges[0]!.startLine;
    const endLine = templateRanges[templateRanges.length - 1]!.endLine;
    const componentName = filePath.split("/").pop()?.replace(/\.svelte$/, "") ?? null;
    const pieces: string[] = [];
    for (const r of templateRanges) {
      const lines = source.split("\n");
      pieces.push(lines.slice(r.startLine - 1, r.endLine).join("\n"));
    }
    chunks.push({
      filePath,
      chunkType: "component",
      symbolName: componentName,
      receiverType: null,
      signature: `<svelte-component ${componentName ?? ""}>`,
      packageName: null,
      language: "svelte",
      startLine,
      endLine,
      content: pieces.join("\n\n<!-- ... -->\n\n"),
      docComment: null,
      imports: Array.from(importSet),
      tags: ["component", "svelte"],
    });
    if (componentName) {
      symbols.push({ name: componentName, kind: "component", line: startLine });
      signatureParts.push(`component:${componentName}`);
    }
  }

  return {
    chunks,
    metadata: {
      filePath,
      fileHash: hashSource(source),
      language: "svelte",
      lineCount: source.split("\n").length,
      chunkCount: chunks.length,
      imports: Array.from(importSet),
      symbols,
    },
    signatureHash: computeSignatureHash(signatureParts),
  };
}

export const svelteParser: LanguageParser = { language: "svelte", parse };
