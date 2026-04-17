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
  if (!parserPromise) parserPromise = loadParser("tree-sitter-rust.wasm");
  return parserPromise;
}

function extractImports(tree: Tree): string[] {
  const imports = new Set<string>();
  const cursor = tree.walk();
  function walk() {
    const n = cursor.currentNode;
    if (n.type === "use_declaration") {
      const arg = n.childForFieldName("argument") ?? n.namedChild(0);
      if (arg) imports.add(arg.text);
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
    const docComment = extractDocCommentCStyle(source, startLine);
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
      language: "rust",
      startLine,
      endLine,
      content: node.text,
      docComment,
      imports,
      tags: deriveBaseTags(filePath, chunkType),
    };
    chunks.push(...splitLongChunk(chunk));
  }

  function visitImplBody(implNode: Node, typeText: string) {
    const body = implNode.childForFieldName("body");
    if (!body) return;
    for (let i = 0; i < body.namedChildCount; i++) {
      const item = body.namedChild(i);
      if (!item) continue;
      if (item.type === "function_item") {
        const nameNode = item.childForFieldName("name");
        const paramsNode = item.childForFieldName("parameters");
        const returnNode = item.childForFieldName("return_type");
        const sig = `fn ${nameNode?.text ?? ""}${paramsNode?.text ?? "()"}${
          returnNode ? " -> " + returnNode.text : ""
        }`;
        addChunk(item, "method", nameNode?.text ?? null, typeText, sig);
      }
    }
  }

  function visit(node: Node) {
    switch (node.type) {
      case "function_item": {
        const nameNode = node.childForFieldName("name");
        const paramsNode = node.childForFieldName("parameters");
        const returnNode = node.childForFieldName("return_type");
        const sig = `fn ${nameNode?.text ?? ""}${paramsNode?.text ?? "()"}${
          returnNode ? " -> " + returnNode.text : ""
        }`;
        addChunk(node, "function", nameNode?.text ?? null, null, sig);
        return;
      }
      case "struct_item": {
        const nameNode = node.childForFieldName("name");
        addChunk(node, "struct", nameNode?.text ?? null, null, `struct ${nameNode?.text ?? ""}`);
        return;
      }
      case "enum_item": {
        const nameNode = node.childForFieldName("name");
        addChunk(node, "enum", nameNode?.text ?? null, null, `enum ${nameNode?.text ?? ""}`);
        return;
      }
      case "trait_item": {
        const nameNode = node.childForFieldName("name");
        addChunk(node, "interface", nameNode?.text ?? null, null, `trait ${nameNode?.text ?? ""}`);
        return;
      }
      case "impl_item": {
        const typeNode = node.childForFieldName("type");
        const traitNode = node.childForFieldName("trait");
        const typeText = typeNode?.text ?? "?";
        const signature = traitNode
          ? `impl ${traitNode.text} for ${typeText}`
          : `impl ${typeText}`;
        addChunk(node, "class", typeText, null, signature);
        visitImplBody(node, typeText);
        return;
      }
      case "type_item": {
        const nameNode = node.childForFieldName("name");
        addChunk(node, "type", nameNode?.text ?? null, null, `type ${nameNode?.text ?? ""}`);
        return;
      }
      case "const_item":
      case "static_item": {
        const nameNode = node.childForFieldName("name");
        const chunkType = node.type === "const_item" ? "const" : "var";
        if (node.text.split("\n").length > 2) {
          addChunk(node, chunkType, nameNode?.text ?? null, null, null);
        }
        return;
      }
      case "mod_item": {
        const body = node.childForFieldName("body");
        if (body) {
          for (let i = 0; i < body.namedChildCount; i++) {
            const c = body.namedChild(i);
            if (c) visit(c);
          }
        }
        return;
      }
    }
  }

  const root = tree.rootNode;
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i);
    if (child) visit(child);
  }

  return {
    chunks,
    metadata: {
      filePath,
      fileHash: hashSource(source),
      language: "rust",
      lineCount: source.split("\n").length,
      chunkCount: chunks.length,
      imports,
      symbols,
    },
    signatureHash: computeSignatureHash(signatureParts),
  };
}

export const rustParser: LanguageParser = { language: "rust", parse };
