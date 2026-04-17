import Parser from "web-tree-sitter";
import path from "node:path";

export type Tree = Parser.Tree;
export type Node = Parser.SyntaxNode;
export type TSParser = Parser;

let initPromise: Promise<void> | null = null;

export async function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  await initPromise;
}

export function resolveWasmPath(wasmFile: string): string {
  return path.join(import.meta.dir, "../../../node_modules/tree-sitter-wasms/out", wasmFile);
}

export async function loadParser(wasmFile: string): Promise<Parser> {
  await ensureInit();
  const lang = await Parser.Language.load(resolveWasmPath(wasmFile));
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser;
}
