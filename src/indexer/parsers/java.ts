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
  if (!parserPromise) parserPromise = loadParser("tree-sitter-java.wasm");
  return parserPromise;
}

function extractImports(tree: Tree): string[] {
  const imports: string[] = [];
  const cursor = tree.walk();
  function walk() {
    const n = cursor.currentNode;
    if (n.type === "import_declaration") {
      // import foo.bar.Baz;  — 자식 중 scoped_identifier/identifier
      const t = n.text.replace(/^import\s+/, "").replace(/;$/, "").trim();
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

function getPackageName(tree: Tree): string | null {
  const root = tree.rootNode;
  for (let i = 0; i < root.childCount; i++) {
    const c = root.child(i);
    if (c?.type === "package_declaration") {
      for (let j = 0; j < c.namedChildCount; j++) {
        const id = c.namedChild(j);
        if (id && (id.type === "scoped_identifier" || id.type === "identifier")) {
          return id.text;
        }
      }
    }
  }
  return null;
}

async function parse(filePath: string, source: string): Promise<ParseResult> {
  const parser = await getParser();
  const tree = parser.parse(source);
  if (!tree) throw new Error(`tree-sitter parse failed for ${filePath}`);

  const packageName = getPackageName(tree);
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
      packageName,
      language: "java",
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
      case "program": {
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
      language: "java",
      lineCount: source.split("\n").length,
      chunkCount: chunks.length,
      imports,
      symbols,
    },
    signatureHash: computeSignatureHash(signatureParts),
  };
}

export const javaParser: LanguageParser = { language: "java", parse };
