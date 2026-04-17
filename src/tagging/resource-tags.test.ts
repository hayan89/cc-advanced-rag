import { describe, test, expect } from "bun:test";
import { applyTagRules, compileTagRules, mergeTags, InvalidTagRegex } from "./resource-tags.ts";
import { parseConfig } from "../config/loader.ts";

describe("compileTagRules", () => {
  test("compiles valid regex patterns", () => {
    const cfg = parseConfig({
      tagging: {
        customTags: [
          { name: "receipt", regex: "\\b(receipt|ocr_job)\\b" },
          { name: "ocr", regex: "[Oo][Cc][Rr]" },
        ],
      },
    });
    const rules = compileTagRules(cfg);
    expect(rules).toHaveLength(2);
    expect(rules[0]?.tag).toBe("receipt");
  });

  test("throws InvalidTagRegex for malformed pattern", () => {
    const cfg = parseConfig({
      tagging: { customTags: [{ name: "bad", regex: "[" }] },
    });
    expect(() => compileTagRules(cfg)).toThrow(InvalidTagRegex);
  });

  test("empty customTags → empty rules", () => {
    const rules = compileTagRules(parseConfig({}));
    expect(rules).toEqual([]);
  });
});

describe("applyTagRules", () => {
  const cfg = parseConfig({
    tagging: {
      customTags: [
        { name: "receipt", regex: "[Rr]eceipt" },
        { name: "ocr", regex: "[Oo][Cc][Rr]" },
        { name: "admin", regex: "^admin/" },
      ],
    },
  });
  const rules = compileTagRules(cfg);

  test("matches tag when regex found in content", () => {
    const tags = applyTagRules(rules, {
      filePath: "src/user.ts",
      content: "function getReceipt() {}",
    });
    expect(tags).toContain("receipt");
  });

  test("matches tag when regex found in file path", () => {
    const tags = applyTagRules(rules, {
      filePath: "admin/receipts/list.ts",
      content: "",
    });
    expect(tags).toContain("admin");
    expect(tags).toContain("receipt");
  });

  test("case sensitivity respected", () => {
    const tags = applyTagRules(rules, {
      filePath: "src/x.ts",
      content: "OCR job triggered",
    });
    expect(tags).toContain("ocr");
  });

  test("empty rule list returns empty", () => {
    expect(applyTagRules([], { filePath: "x.ts", content: "receipt" })).toEqual([]);
  });
});

describe("mergeTags", () => {
  test("de-duplicates while preserving order", () => {
    expect(mergeTags(["a", "b", "c"], ["c", "d", "a"])).toEqual(["a", "b", "c", "d"]);
  });

  test("empty extras returns base as-is", () => {
    expect(mergeTags(["a"], [])).toEqual(["a"]);
  });
});
