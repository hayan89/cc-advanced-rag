import { describe, test, expect } from "bun:test";
import { toKebab, tokenize } from "./case-normalize.ts";

describe("tokenize", () => {
  const cases: Array<[string, string[]]> = [
    ["", []],
    ["receipt", ["receipt"]],
    ["receipt_upload", ["receipt", "upload"]],
    ["receipt-upload", ["receipt", "upload"]],
    ["receiptUpload", ["receipt", "upload"]],
    ["ReceiptUpload", ["receipt", "upload"]],
    ["RECEIPT_UPLOAD", ["receipt", "upload"]],
    ["HTTPReceiptUpload", ["http", "receipt", "upload"]],
    ["XMLParser", ["xml", "parser"]],
    ["receipt__upload", ["receipt", "upload"]],
    ["receipt.upload", ["receipt", "upload"]],
    ["receipt upload", ["receipt", "upload"]],
    ["receipt/upload", ["receipt", "upload"]],
    ["v2Token", ["v2", "token"]], // digit→Upper boundary splits
    ["2FactorAuth", ["2", "factor", "auth"]], // digit→Upper boundary splits
    ["ocr3Pipeline", ["ocr3", "pipeline"]], // digit→Upper boundary splits
    ["receiptUpload.svelte", ["receipt", "upload", "svelte"]],
    ["+page.svelte", ["page", "svelte"]], // leading + is non-alphanum, stripped
    ["___", []], // only separators
    ["ABC", ["abc"]],
    ["abcDEF", ["abc", "def"]],
  ];

  for (const [input, expected] of cases) {
    test(`tokenize(${JSON.stringify(input)}) → ${JSON.stringify(expected)}`, () => {
      expect(tokenize(input)).toEqual(expected);
    });
  }
});

describe("toKebab", () => {
  const cases: Array<[string, string]> = [
    ["", ""],
    ["receipt", "receipt"],
    ["receipt_upload", "receipt-upload"],
    ["receipt-upload", "receipt-upload"],
    ["receiptUpload", "receipt-upload"],
    ["ReceiptUpload", "receipt-upload"],
    ["RECEIPT_UPLOAD", "receipt-upload"],
    ["HTTPReceiptUpload", "http-receipt-upload"],
    ["ReceiptUploadHandler", "receipt-upload-handler"],
    ["user_profile_page", "user-profile-page"],
  ];

  for (const [input, expected] of cases) {
    test(`toKebab(${JSON.stringify(input)}) → ${JSON.stringify(expected)}`, () => {
      expect(toKebab(input)).toBe(expected);
    });
  }
});
