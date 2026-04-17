import type { CodeChunk, FileMetadata, LanguageParser, ParseResult } from "./types.ts";
import { loadParser, type Node, type TSParser, type Tree } from "./tree-sitter-base.ts";
import {
  computeSignatureHash,
  deriveBaseTags,
  extractDocCommentCStyle,
  hashSource,
  splitLongChunk,
} from "./common.ts";

let parserPromise: Promise<TSParser> | null = null;
function getParser(): Promise<TSParser> {
  if (!parserPromise) parserPromise = loadParser("tree-sitter-cpp.wasm");
  return parserPromise;
}

function extractImports(tree: Tree): string[] {
  const imports: string[] = [];
  const cursor = tree.walk();
  function walk() {
    const n = cursor.currentNode;
    if (n.type === "preproc_include") {
      const pathNode = n.childForFieldName("path");
      if (pathNode) imports.push(pathNode.text.replace(/^["<]|[">]$/g, ""));
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

function functionName(declNode: Node | null): string | null {
  if (!declNode) return null;
  if (declNode.type === "function_declarator") {
    const d = declNode.childForFieldName("declarator");
    if (d) return functionName(d) ?? d.text;
  }
  if (declNode.type === "identifier" || declNode.type === "field_identifier") {
    return declNode.text;
  }
  if (declNode.type === "qualified_identifier") {
    return declNode.text;
  }
  // Recurse through pointer/reference declarators
  const inner = declNode.childForFieldName("declarator");
  if (inner) return functionName(inner);
  return null;
}

async function parse(filePath: string, source: string): Promise<ParseResult> {
  const parser = await getParser();
  const tree = parser.parse(source);
  if (!tree) throw new Error(`tree-sitter parse failed for ${filePath}`);

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
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    const docComment = extractDocCommentCStyle(source, startLine);
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
      language: "cpp",
      startLine,
      endLine,
      content: node.text,
      docComment,
      imports,
      tags: deriveBaseTags(filePath, chunkType),
    };
    chunks.push(...splitLongChunk(chunk));
  }

  function walk(node: Node) {
    switch (node.type) {
      case "function_definition": {
        const decl = node.childForFieldName("declarator");
        const name = functionName(decl);
        const type = node.childForFieldName("type");
        const sig = `${type?.text ?? ""} ${decl?.text ?? ""}`.trim();
        addChunk(node, "function", name, sig);
        return;
      }
      case "class_specifier": {
        const nameNode = node.childForFieldName("name");
        addChunk(node, "class", nameNode?.text ?? null, `class ${nameNode?.text ?? ""}`);
        return;
      }
      case "struct_specifier": {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          addChunk(node, "struct", nameNode.text, `struct ${nameNode.text}`);
        }
        return;
      }
      case "enum_specifier": {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          addChunk(node, "enum", nameNode.text, `enum ${nameNode.text}`);
        }
        return;
      }
      case "namespace_definition": {
        const nameNode = node.childForFieldName("name");
        addChunk(node, "module", nameNode?.text ?? null, `namespace ${nameNode?.text ?? ""}`);
        // recurse into body to also index nested classes/functions
        const body = node.childForFieldName("body");
        if (body) {
          for (let i = 0; i < body.namedChildCount; i++) {
            const c = body.namedChild(i);
            if (c) walk(c);
          }
        }
        return;
      }
      case "translation_unit": {
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c) walk(c);
        }
        return;
      }
    }
  }

  walk(tree.rootNode);

  return {
    chunks,
    metadata: {
      filePath,
      fileHash: hashSource(source),
      language: "cpp",
      lineCount: source.split("\n").length,
      chunkCount: chunks.length,
      imports,
      symbols,
    },
    signatureHash: computeSignatureHash(signatureParts),
  };
}

export const cppParser: LanguageParser = { language: "cpp", parse };
