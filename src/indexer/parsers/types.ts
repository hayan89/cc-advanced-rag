import type { SupportedLanguage } from "../../config/schema.ts";

export type ChunkType =
  | "function"
  | "method"
  | "type"
  | "struct"
  | "interface"
  | "component"
  | "class"
  | "const"
  | "var"
  | "enum"
  | "module";

export interface CodeChunk {
  filePath: string;
  chunkType: ChunkType;
  symbolName: string | null;
  receiverType: string | null;
  signature: string | null;
  packageName: string | null;
  language: SupportedLanguage;
  startLine: number;
  endLine: number;
  content: string;
  docComment: string | null;
  imports: string[];
  tags: string[];
}

export interface FileMetadata {
  filePath: string;
  fileHash: string;
  language: SupportedLanguage;
  lineCount: number;
  chunkCount: number;
  imports: string[];
  symbols: Array<{ name: string; kind: string; line: number }>;
}

export interface ParseResult {
  chunks: CodeChunk[];
  metadata: FileMetadata;
  signatureHash: string;
}

export interface LanguageParser {
  language: SupportedLanguage;
  parse(filePath: string, source: string): Promise<ParseResult>;
}
