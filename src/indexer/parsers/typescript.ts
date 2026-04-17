import type { SupportedLanguage } from "../../config/schema.ts";
import type { CodeChunk, FileMetadata, LanguageParser, ParseResult } from "./types.ts";
import { loadParser, type Node, type TSParser, type Tree } from "./tree-sitter-base.ts";
import {
  computeSignatureHash,
  deriveBaseTags,
  extractDocCommentCStyle,
  hashSource,
  splitLongChunk,
} from "./common.ts";

type TsVariant = "typescript" | "tsx" | "javascript" | "jsx";

const WASM_BY_VARIANT: Record<TsVariant, string> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  jsx: "tree-sitter-javascript.wasm",
};

const parserCache = new Map<TsVariant, Promise<TSParser>>();

function getParser(variant: TsVariant): Promise<TSParser> {
  const cached = parserCache.get(variant);
  if (cached) return cached;
  const promise = loadParser(WASM_BY_VARIANT[variant]);
  parserCache.set(variant, promise);
  return promise;
}

function extractImports(tree: Tree): string[] {
  const imports: string[] = [];
  const cursor = tree.walk();
  function walk() {
    const node = cursor.currentNode;
    if (node.type === "import_statement") {
      const sourceNode = node.childForFieldName("source") ?? findStringChild(node);
      if (sourceNode) {
        imports.push(sourceNode.text.replace(/^['"`]|['"`]$/g, ""));
      }
    }
    if (cursor.gotoFirstChild()) {
      do {
        walk();
      } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  }
  walk();
  return imports;
}

function findStringChild(node: Node): Node | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && (c.type === "string" || c.type === "string_literal")) return c;
  }
  return null;
}

export async function parseTypeScriptSource(
  filePath: string,
  source: string,
  variant: TsVariant = "typescript",
  lineOffset = 0,
  outputLanguage: SupportedLanguage | null = null,
): Promise<ParseResult> {
  const parser = await getParser(variant);
  const tree = parser.parse(source);
  if (!tree) throw new Error(`tree-sitter parse failed for ${filePath}`);
  const language: SupportedLanguage = outputLanguage ?? variant;

  const imports = extractImports(tree);
  const chunks: CodeChunk[] = [];
  const symbols: FileMetadata["symbols"] = [];
  const signatureParts: string[] = [];

  function addChunk(
    node: Node,
    chunkType: CodeChunk["chunkType"],
    symbolName: string | null,
    signature: string | null,
  ) {
    const startLine = node.startPosition.row + 1 + lineOffset;
    const endLine = node.endPosition.row + 1 + lineOffset;
    const docComment = extractDocCommentCStyle(source, node.startPosition.row + 1);
    const content = node.text;
    if (symbolName) {
      symbols.push({ name: symbolName, kind: chunkType, line: startLine });
      signatureParts.push(`${chunkType}:${symbolName}:${signature ?? ""}`);
    }
    const chunk: CodeChunk = {
      filePath,
      chunkType,
      symbolName,
      receiverType: null,
      signature,
      packageName: null,
      language,
      startLine,
      endLine,
      content,
      docComment,
      imports,
      tags: deriveBaseTags(filePath, chunkType),
    };
    chunks.push(...splitLongChunk(chunk));
  }

  function handleLexical(decl: Node) {
    for (let i = 0; i < decl.childCount; i++) {
      const declarator = decl.child(i);
      if (declarator?.type !== "variable_declarator") continue;
      const nameNode = declarator.childForFieldName("name");
      const valueNode = declarator.childForFieldName("value");
      if (!nameNode || !valueNode) continue;
      const name = nameNode.text;
      if (
        valueNode.type === "arrow_function" ||
        valueNode.type === "function_expression" ||
        valueNode.type === "function"
      ) {
        const paramsNode =
          valueNode.childForFieldName("parameters") ?? valueNode.childForFieldName("parameter");
        const returnNode = valueNode.childForFieldName("return_type");
        const sig = `const ${name} = ${paramsNode?.text ?? "()"}${
          returnNode ? " " + returnNode.text : ""
        } => ...`;
        addChunk(decl, "function", name, sig);
      }
    }
  }

  function visit(node: Node) {
    switch (node.type) {
      case "function_declaration":
      case "generator_function_declaration": {
        const nameNode = node.childForFieldName("name");
        const paramsNode = node.childForFieldName("parameters");
        const returnNode = node.childForFieldName("return_type");
        const sig = `function ${nameNode?.text ?? ""}${paramsNode?.text ?? "()"}${
          returnNode ? " " + returnNode.text : ""
        }`;
        addChunk(node, "function", nameNode?.text ?? null, sig);
        return;
      }
      case "class_declaration":
      case "abstract_class_declaration": {
        const nameNode = node.childForFieldName("name");
        addChunk(node, "class", nameNode?.text ?? null, `class ${nameNode?.text ?? ""}`);
        return;
      }
      case "interface_declaration": {
        const nameNode = node.childForFieldName("name");
        addChunk(node, "interface", nameNode?.text ?? null, `interface ${nameNode?.text ?? ""}`);
        return;
      }
      case "type_alias_declaration": {
        const nameNode = node.childForFieldName("name");
        addChunk(node, "type", nameNode?.text ?? null, `type ${nameNode?.text ?? ""}`);
        return;
      }
      case "enum_declaration": {
        const nameNode = node.childForFieldName("name");
        addChunk(node, "enum", nameNode?.text ?? null, `enum ${nameNode?.text ?? ""}`);
        return;
      }
      case "lexical_declaration":
      case "variable_declaration": {
        handleLexical(node);
        return;
      }
      case "export_statement": {
        const declNode =
          node.childForFieldName("declaration") ??
          (node.namedChildCount > 0 ? node.namedChild(0) : null);
        if (declNode) visit(declNode);
        return;
      }
    }
  }

  const root = tree.rootNode;
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i);
    if (child) visit(child);
  }

  const lineCount = source.split("\n").length + lineOffset;
  return {
    chunks,
    metadata: {
      filePath,
      fileHash: hashSource(source),
      language,
      lineCount,
      chunkCount: chunks.length,
      imports,
      symbols,
    },
    signatureHash: computeSignatureHash(signatureParts),
  };
}

function detectVariant(filePath: string): TsVariant {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".jsx")) return "jsx";
  if (lower.endsWith(".ts")) return "typescript";
  return "javascript";
}

function makeParser(variant: TsVariant, language: SupportedLanguage): LanguageParser {
  return {
    language,
    parse: (filePath, source) =>
      parseTypeScriptSource(filePath, source, variant, 0, language),
  };
}

export const typescriptParser: LanguageParser = {
  language: "typescript",
  parse: (filePath, source) => {
    const variant = filePath.toLowerCase().endsWith(".tsx") ? "tsx" : "typescript";
    return parseTypeScriptSource(filePath, source, variant, 0, "typescript");
  },
};
export const tsxParser: LanguageParser = makeParser("tsx", "tsx");
export const javascriptParser: LanguageParser = {
  language: "javascript",
  parse: (filePath, source) =>
    parseTypeScriptSource(filePath, source, detectVariant(filePath), 0, "javascript"),
};
export const jsxParser: LanguageParser = makeParser("jsx", "jsx");
