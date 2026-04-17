import type { CodeChunk, FileMetadata, LanguageParser, ParseResult } from "./types.ts";
import { loadParser, type Node, type TSParser, type Tree } from "./tree-sitter-base.ts";
import {
  computeSignatureHash,
  deriveBaseTags,
  extractDocCommentPython,
  hashSource,
  splitLongChunk,
} from "./common.ts";

let parserPromise: Promise<TSParser> | null = null;
function getParser(): Promise<TSParser> {
  if (!parserPromise) parserPromise = loadParser("tree-sitter-python.wasm");
  return parserPromise;
}

function extractImports(tree: Tree): string[] {
  const imports = new Set<string>();
  const cursor = tree.walk();
  function walk() {
    const n = cursor.currentNode;
    if (n.type === "import_statement" || n.type === "import_from_statement") {
      // import_from_statement의 경우 "module_name" 필드
      const modNode = n.childForFieldName("module_name");
      if (modNode) imports.add(modNode.text);
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i);
        if (!c) continue;
        if (c.type === "dotted_name" || c.type === "aliased_import") {
          imports.add(c.text.replace(/\s+as\s+\w+$/, ""));
        }
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
  return Array.from(imports);
}

function unwrapDecorated(node: Node): Node {
  if (node.type !== "decorated_definition") return node;
  const def = node.childForFieldName("definition");
  return def ?? node;
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
    receiverType: string | null,
    signature: string | null,
  ) {
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    const bodyNode = node.childForFieldName("body");
    const docComment = extractDocCommentPython(source, startLine, bodyNode?.text ?? null);
    if (symbolName) {
      symbols.push({ name: symbolName, kind: chunkType, line: startLine });
      signatureParts.push(`${chunkType}:${symbolName}:${signature ?? ""}`);
    }
    const chunk: CodeChunk = {
      filePath,
      chunkType,
      symbolName,
      receiverType,
      signature,
      packageName: null,
      language: "python",
      startLine,
      endLine,
      content: node.text,
      docComment,
      imports,
      tags: deriveBaseTags(filePath, chunkType),
    };
    chunks.push(...splitLongChunk(chunk));
  }

  function visit(node: Node, parentClass: string | null) {
    const actual = unwrapDecorated(node);
    switch (actual.type) {
      case "function_definition": {
        const nameNode = actual.childForFieldName("name");
        const paramsNode = actual.childForFieldName("parameters");
        const returnNode = actual.childForFieldName("return_type");
        const sig = `def ${nameNode?.text ?? ""}${paramsNode?.text ?? "()"}${
          returnNode ? " -> " + returnNode.text : ""
        }`;
        if (parentClass) {
          addChunk(actual, "method", nameNode?.text ?? null, parentClass, sig);
        } else {
          addChunk(actual, "function", nameNode?.text ?? null, null, sig);
        }
        return;
      }
      case "class_definition": {
        const nameNode = actual.childForFieldName("name");
        const name = nameNode?.text ?? null;
        addChunk(actual, "class", name, null, `class ${name ?? ""}`);
        const body = actual.childForFieldName("body");
        if (body) {
          for (let i = 0; i < body.namedChildCount; i++) {
            const c = body.namedChild(i);
            if (c) visit(c, name);
          }
        }
        return;
      }
    }
  }

  const root = tree.rootNode;
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i);
    if (child) visit(child, null);
  }

  return {
    chunks,
    metadata: {
      filePath,
      fileHash: hashSource(source),
      language: "python",
      lineCount: source.split("\n").length,
      chunkCount: chunks.length,
      imports,
      symbols,
    },
    signatureHash: computeSignatureHash(signatureParts),
  };
}

export const pythonParser: LanguageParser = { language: "python", parse };
