import type { CodeChunk, FileMetadata, LanguageParser, ParseResult } from "./types.ts";
import { loadParser, type Node, type TSParser, type Tree } from "./tree-sitter-base.ts";
import {
  computeSignatureHash,
  deriveBaseTags,
  extractLineComment,
  hashSource,
  splitLongChunk,
} from "./common.ts";

let parserPromise: Promise<TSParser> | null = null;
function getParser(): Promise<TSParser> {
  if (!parserPromise) parserPromise = loadParser("tree-sitter-go.wasm");
  return parserPromise;
}

function extractImports(tree: Tree): string[] {
  const imports: string[] = [];
  const cursor = tree.walk();
  function walk() {
    const node = cursor.currentNode;
    if (node.type === "import_spec") {
      const pathNode = node.childForFieldName("path");
      if (pathNode) imports.push(pathNode.text.replace(/^"|"$/g, ""));
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
    const child = root.child(i);
    if (child?.type === "package_clause") {
      const id = child.childForFieldName("name") ?? child.child(1);
      return id?.text ?? null;
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
    receiverType: string | null,
    signature: string | null,
  ) {
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    const docComment = extractLineComment(source, startLine, "//");
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
      packageName,
      language: "go",
      startLine,
      endLine,
      content: node.text,
      docComment,
      imports,
      tags: deriveBaseTags(filePath, chunkType),
    };
    chunks.push(...splitLongChunk(chunk));
  }

  const root = tree.rootNode;
  for (let i = 0; i < root.childCount; i++) {
    const node = root.child(i);
    if (!node) continue;
    switch (node.type) {
      case "function_declaration": {
        const nameNode = node.childForFieldName("name");
        const paramsNode = node.childForFieldName("parameters");
        const resultNode = node.childForFieldName("result");
        const sig = `func ${nameNode?.text ?? ""}${paramsNode?.text ?? "()"}${
          resultNode ? " " + resultNode.text : ""
        }`;
        addChunk(node, "function", nameNode?.text ?? null, null, sig);
        break;
      }
      case "method_declaration": {
        const nameNode = node.childForFieldName("name");
        const receiverNode = node.childForFieldName("receiver");
        const paramsNode = node.childForFieldName("parameters");
        const resultNode = node.childForFieldName("result");
        const sig = `func ${receiverNode?.text ?? ""} ${nameNode?.text ?? ""}${
          paramsNode?.text ?? "()"
        }${resultNode ? " " + resultNode.text : ""}`;
        addChunk(node, "method", nameNode?.text ?? null, receiverNode?.text ?? null, sig);
        break;
      }
      case "type_declaration": {
        for (let j = 0; j < node.childCount; j++) {
          const spec = node.child(j);
          if (spec?.type !== "type_spec") continue;
          const nameNode = spec.childForFieldName("name");
          const typeNode = spec.childForFieldName("type");
          const typeKind = typeNode?.type ?? "type";
          let chunkType: CodeChunk["chunkType"] = "type";
          if (typeKind === "struct_type") chunkType = "struct";
          else if (typeKind === "interface_type") chunkType = "interface";
          addChunk(
            spec,
            chunkType,
            nameNode?.text ?? null,
            null,
            `type ${nameNode?.text ?? ""} ${typeNode?.text ?? ""}`,
          );
        }
        break;
      }
      case "const_declaration":
      case "var_declaration": {
        const chunkType = node.type === "const_declaration" ? "const" : "var";
        if (node.text.split("\n").length > 3) {
          addChunk(node, chunkType, null, null, null);
        }
        break;
      }
    }
  }

  return {
    chunks,
    metadata: {
      filePath,
      fileHash: hashSource(source),
      language: "go",
      lineCount: source.split("\n").length,
      chunkCount: chunks.length,
      imports,
      symbols,
    },
    signatureHash: computeSignatureHash(signatureParts),
  };
}

export const goParser: LanguageParser = { language: "go", parse };
