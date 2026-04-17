import { describe, test, expect } from "bun:test";
import { goParser } from "./go.ts";
import {
  typescriptParser,
  tsxParser,
  javascriptParser,
  jsxParser,
  parseTypeScriptSource,
} from "./typescript.ts";
import { pythonParser } from "./python.ts";
import { rustParser } from "./rust.ts";
import { javaParser } from "./java.ts";
import { cppParser } from "./cpp.ts";
import { csharpParser } from "./csharp.ts";
import { svelteParser } from "./svelte.ts";
import { detectLanguage, parseFile, preWarmParsers, resetRegistry } from "./registry.ts";

describe("go parser", () => {
  test("extracts package, function, method, struct, interface", async () => {
    const src = `package handlers

import (
  "fmt"
  "github.com/foo/bar"
)

// Greet prints hello.
func Greet(name string) string {
  return fmt.Sprintf("hi %s", name)
}

type Receipt struct {
  ID int
  Name string
}

type Repo interface {
  Get(id int) (*Receipt, error)
}

func (r *Repo) Save(x *Receipt) error { return nil }
`;
    const result = await goParser.parse("backend/handlers/receipt.go", src);
    expect(result.metadata.language).toBe("go");
    const kinds = result.chunks.map((c) => c.chunkType).sort();
    expect(kinds).toContain("function");
    expect(kinds).toContain("struct");
    expect(kinds).toContain("interface");
    expect(kinds).toContain("method");
    const greet = result.chunks.find((c) => c.symbolName === "Greet");
    expect(greet?.docComment).toContain("Greet prints hello.");
    expect(result.metadata.imports).toContain("github.com/foo/bar");
  });
});

describe("typescript parser", () => {
  test("extracts functions, classes, interfaces, types, arrow const", async () => {
    const src = `import { z } from "zod";

/** Primary schema */
export interface User {
  id: number;
  name: string;
}

export type Role = "admin" | "user";

export class UserService {
  getUser(id: number): User | null { return null; }
}

export function makeUser(name: string): User {
  return { id: 0, name };
}

export const login = async (email: string): Promise<boolean> => true;
`;
    const result = await typescriptParser.parse("src/user.ts", src);
    const names = result.chunks.map((c) => c.symbolName).sort();
    expect(names).toContain("User");
    expect(names).toContain("Role");
    expect(names).toContain("UserService");
    expect(names).toContain("makeUser");
    expect(names).toContain("login");
    expect(result.metadata.imports).toContain("zod");
    const userDoc = result.chunks.find((c) => c.symbolName === "User");
    expect(userDoc?.docComment).toContain("Primary schema");
  });

  test("tsx variant parses JSX", async () => {
    const src = `export const App = () => <div>hi</div>;`;
    const result = await tsxParser.parse("src/App.tsx", src);
    expect(result.chunks.find((c) => c.symbolName === "App")).toBeDefined();
    expect(result.metadata.language).toBe("tsx");
  });

  test("javascript+jsx parsers load", async () => {
    const js = await javascriptParser.parse(
      "src/util.js",
      `export function add(a, b) { return a + b; }`,
    );
    expect(js.chunks.find((c) => c.symbolName === "add")).toBeDefined();
    const jsx = await jsxParser.parse(
      "src/Btn.jsx",
      `export const Btn = () => <button />;`,
    );
    expect(jsx.chunks.find((c) => c.symbolName === "Btn")).toBeDefined();
  });

  test("signature_hash is stable across comment/whitespace-only diffs", async () => {
    const a = `export function doWork(n: number): number { return n * 2; }`;
    const b = `// added comment\n\nexport function doWork(  n: number  ): number {\n  return n * 2;\n}`;
    const ra = await parseTypeScriptSource("x.ts", a, "typescript", 0, "typescript");
    const rb = await parseTypeScriptSource("x.ts", b, "typescript", 0, "typescript");
    expect(ra.signatureHash).toBe(rb.signatureHash);
  });
});

describe("python parser", () => {
  test("extracts class, method, function, docstring", async () => {
    const src = `import os
from typing import Optional

def greet(name: str) -> str:
    """Return greeting."""
    return f"hi {name}"

class Receipt:
    """A receipt."""
    def __init__(self, id: int):
        self.id = id

    def save(self) -> None:
        pass
`;
    const result = await pythonParser.parse("services/receipt.py", src);
    const names = result.chunks.map((c) => c.symbolName);
    expect(names).toContain("greet");
    expect(names).toContain("Receipt");
    expect(names).toContain("__init__");
    expect(names).toContain("save");
    const greet = result.chunks.find((c) => c.symbolName === "greet");
    expect(greet?.docComment).toContain("Return greeting");
    expect(result.metadata.imports.some((i) => i.includes("os") || i.includes("typing"))).toBe(true);
  });
});

describe("rust parser", () => {
  test("extracts fn, struct, enum, trait, impl method", async () => {
    const src = `use std::collections::HashMap;

/// greet someone
pub fn greet(name: &str) -> String {
    format!("hi {}", name)
}

pub struct User { pub id: u32 }

pub enum Role { Admin, User }

pub trait Repo {
    fn get(&self, id: u32) -> Option<User>;
}

impl Repo for User {
    fn get(&self, id: u32) -> Option<User> { None }
}
`;
    const result = await rustParser.parse("src/lib.rs", src);
    const kinds = new Set(result.chunks.map((c) => c.chunkType));
    expect(kinds.has("function")).toBe(true);
    expect(kinds.has("struct")).toBe(true);
    expect(kinds.has("enum")).toBe(true);
    expect(kinds.has("interface")).toBe(true);
    expect(kinds.has("method")).toBe(true);
    expect(result.metadata.imports).toContain("std::collections::HashMap");
  });
});

describe("java parser", () => {
  test("extracts class, interface, enum, record, package, imports", async () => {
    const src = `package com.example.app;

import java.util.List;
import java.util.Map;

/** Receipt DTO */
public class Receipt {
    private int id;
    public Receipt(int id) { this.id = id; }
    public int getId() { return id; }
}

public interface Repo {
    List<Receipt> findAll();
}

public enum Status { OPEN, CLOSED }

public record Point(int x, int y) {}
`;
    const result = await javaParser.parse("src/main/java/Receipt.java", src);
    const kinds = result.chunks.map((c) => c.chunkType);
    expect(kinds).toContain("class");
    expect(kinds).toContain("interface");
    expect(kinds).toContain("enum");
    const pkg = result.chunks[0]?.packageName;
    expect(pkg).toBe("com.example.app");
    expect(result.metadata.imports).toContain("java.util.List");
  });
});

describe("cpp parser", () => {
  test("extracts function, class, struct, namespace, includes", async () => {
    const src = `#include <vector>
#include "receipt.h"

namespace app {

class Receipt {
public:
    int id;
    Receipt(int id) : id(id) {}
};

struct Point { int x; int y; };

int add(int a, int b) {
    return a + b;
}

}  // namespace app
`;
    const result = await cppParser.parse("src/receipt.cpp", src);
    const kinds = result.chunks.map((c) => c.chunkType);
    expect(kinds).toContain("class");
    expect(kinds).toContain("struct");
    expect(kinds).toContain("function");
    expect(kinds).toContain("module");
    expect(result.metadata.imports).toContain("vector");
    expect(result.metadata.imports).toContain("receipt.h");
  });
});

describe("csharp parser", () => {
  test("extracts namespace, class, interface, record, using", async () => {
    const src = `using System;
using System.Collections.Generic;

namespace App.Domain {
    /// <summary>Receipt DTO.</summary>
    public class Receipt {
        public int Id { get; set; }
    }

    public interface IRepo {
        IEnumerable<Receipt> FindAll();
    }

    public record Point(int X, int Y);
}
`;
    const result = await csharpParser.parse("App/Receipt.cs", src);
    const byName = new Map(result.chunks.map((c) => [c.symbolName, c]));
    expect(byName.get("Receipt")?.chunkType).toBe("class");
    expect(byName.get("IRepo")?.chunkType).toBe("interface");
    expect(byName.get("Receipt")?.packageName).toBe("App.Domain");
    expect(result.metadata.imports).toContain("System");
  });
});

describe("svelte parser", () => {
  test("extracts script chunks + component template", async () => {
    const src = `<script lang="ts">
  import { onMount } from "svelte";
  export function handleClick(): void { console.log("x"); }
</script>

<div>
  <button on:click={handleClick}>Go</button>
</div>

<style>
  div { color: red; }
</style>
`;
    const result = await svelteParser.parse("src/Btn.svelte", src);
    const names = result.chunks.map((c) => c.symbolName);
    expect(names).toContain("handleClick");
    expect(names).toContain("Btn");
    const component = result.chunks.find((c) => c.chunkType === "component");
    expect(component?.content).toContain("<button");
    expect(result.metadata.imports).toContain("svelte");
  });
});

describe("registry", () => {
  test("detectLanguage maps common extensions", () => {
    expect(detectLanguage("a.go")).toBe("go");
    expect(detectLanguage("a.ts")).toBe("typescript");
    expect(detectLanguage("a.tsx")).toBe("tsx");
    expect(detectLanguage("a.mjs")).toBe("javascript");
    expect(detectLanguage("a.jsx")).toBe("jsx");
    expect(detectLanguage("a.py")).toBe("python");
    expect(detectLanguage("a.rs")).toBe("rust");
    expect(detectLanguage("a.java")).toBe("java");
    expect(detectLanguage("a.cpp")).toBe("cpp");
    expect(detectLanguage("a.h")).toBe("cpp");
    expect(detectLanguage("a.cs")).toBe("csharp");
    expect(detectLanguage("a.svelte")).toBe("svelte");
    expect(detectLanguage("README.md")).toBeNull();
  });

  test("parseFile skips languages not enabled by config", async () => {
    const result = await parseFile("main.go", "package main", ["python"]);
    expect(result).toBeNull();
  });

  test("parseFile parses allowed languages", async () => {
    const result = await parseFile(
      "main.go",
      "package main\nfunc Run() {}\n",
      ["go", "python"],
    );
    expect(result?.metadata.language).toBe("go");
    expect(result?.chunks.find((c) => c.symbolName === "Run")).toBeDefined();
  });

  test("preWarmParsers reports failed languages without throwing", async () => {
    resetRegistry();
    const warnings: string[] = [];
    const result = await preWarmParsers(["python", "go"], {
      warn: (msg) => warnings.push(msg),
    });
    expect(result.loaded.length + result.failed.length).toBe(2);
  });
});
