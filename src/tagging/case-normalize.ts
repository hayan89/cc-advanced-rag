/**
 * Case normalization utilities for cross-stack resource matching.
 *
 * A single "resource" (e.g. "receipt upload") can appear in a codebase under
 * many spellings: `receipt_upload.go`, `receipt-upload/+page.svelte`,
 * `receiptUpload.ts`, `ReceiptUploadHandler`. To link them we tokenize each
 * identifier and re-emit in a canonical `kebab-case` form.
 */

/**
 * Split an identifier into lowercase tokens.
 *
 * Handles:
 *   - snake_case (`receipt_upload` → `["receipt", "upload"]`)
 *   - kebab-case (`receipt-upload` → `["receipt", "upload"]`)
 *   - camelCase  (`receiptUpload` → `["receipt", "upload"]`)
 *   - PascalCase (`ReceiptUpload` → `["receipt", "upload"]`)
 *   - SCREAMING_SNAKE (`RECEIPT_UPLOAD` → `["receipt", "upload"]`)
 *   - Mixed (`HTTPReceiptUpload` → `["http", "receipt", "upload"]`)
 *   - Digits (`v2Receipt` → `["v2", "receipt"]`, `ocr3Pipeline` → `["ocr3", "pipeline"]`)
 *
 * Empty input or input with no letter/digit characters yields `[]`.
 */
export function tokenize(input: string): string[] {
  if (!input) return [];

  // Normalize separators to a single delimiter, then split on case boundaries.
  // Step 1: split on non-alphanumeric runs (underscore, dash, dot, space, etc.)
  const segments = input.split(/[^A-Za-z0-9]+/).filter((s) => s.length > 0);

  const tokens: string[] = [];
  for (const seg of segments) {
    // Step 2: split camel/Pascal boundaries inside each segment.
    //   - lower/digit→Upper: `receiptUpload` → `receipt | Upload`,
    //                        `v2Token` → `v2 | Token`
    //   - Upper→UpperLower : `HTTPReceipt` → `HTTP | Receipt`
    //
    // Leading digit runs stay glued to the letters that precede them, matching
    // how humans tokenize identifiers like `v2` or `ocr3`.
    const parts = seg
      .replace(/([a-z0-9])([A-Z])/g, "$1\u0000$2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1\u0000$2")
      .split("\u0000")
      .filter((p) => p.length > 0);

    for (const p of parts) {
      tokens.push(p.toLowerCase());
    }
  }
  return tokens;
}

/**
 * Convert any identifier spelling to kebab-case (e.g. `ReceiptUpload` →
 * `receipt-upload`). Empty input yields `""`.
 */
export function toKebab(input: string): string {
  return tokenize(input).join("-");
}
