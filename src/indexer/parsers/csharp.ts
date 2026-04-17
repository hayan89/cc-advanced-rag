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
  if (!parserPromise) parserPromise = loadParser("tree-sitter-c_sharp.wasm");
  return parserPromise;
}

function extractImports(tree: Tree): string[] {
  const imports: string[] = [];
  const cursor = tree.walk();
  function walk() {
    const n = cursor.currentNode;
    if (n.type === "using_directive") {
      const t = n.text.replace(/^using\s+/, "").replace(/;$/, "").trim();
      imports.push(t);
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

async function parse(filePath: string, source: string): Promise<ParseResult> {
  const parser = await getParser();
  const tree = parser.parse(source);
  if (!tree) throw new Error(`tree-sitter parse failed for ${filePath}`);

  const imports = extractImports(tree);
  const chunks: CodeChunk[] = [];
  const symbols: FileMetadata["symbols"] = [];
  const signatureParts: string[] = [];
  let currentNamespace: string | null = null;

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
      packageName: currentNamespace,
      language: "csharp",
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
      case "namespace_declaration":
      case "file_scoped_namespace_declaration": {
        const nameNode = node.childForFieldName("name");
        const prev = currentNamespace;
        currentNamespace = nameNode?.text ?? currentNamespace;
        const body = node.childForFieldName("body") ?? node;
        for (let i = 0; i < body.namedChildCount; i++) {
          const c = body.namedChild(i);
          if (c) walk(c);
        }
        currentNamespace = prev;
        return;
      }
      case "class_declaration": {
        const nameNode = node.childForFieldName("name");
        addChunk(node, "class", nameNode?.text ?? null, `class ${nameNode?.text ?? ""}`);
        return;
      }
      case "interface_declaration": {
        const nameNode = node.childForFieldName("name");
        addChunk(node, "interface", nameNode?.text ?? null, `interface ${nameNode?.text ?? ""}`);
        return;
      }
      case "struct_declaration": {
        const nameNode = node.childForFieldName("name");
        addChunk(node, "struct", nameNode?.text ?? null, `struct ${nameNode?.text ?? ""}`);
        return;
      }
      case "enum_declaration": {
        const nameNode = node.childForFieldName("name");
        addChunk(node, "enum", nameNode?.text ?? null, `enum ${nameNode?.text ?? ""}`);
        return;
      }
      case "record_declaration": {
        const nameNode = node.childForFieldName("name");
        addChunk(node, "class", nameNode?.text ?? null, `record ${nameNode?.text ?? ""}`);
        return;
      }
      case "compilation_unit": {
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
      language: "csharp",
      lineCount: source.split("\n").length,
      chunkCount: chunks.length,
      imports,
      symbols,
    },
    signatureHash: computeSignatureHash(signatureParts),
  };
}

export const csharpParser: LanguageParser = { language: "csharp", parse };
