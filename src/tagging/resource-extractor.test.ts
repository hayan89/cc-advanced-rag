import { describe, test, expect } from "bun:test";
import {
  defaultExtractorOpts,
  extractResourceTags,
  tagWeight,
} from "./resource-extractor.ts";

const opts = defaultExtractorOpts();

describe("extractResourceTags", () => {
  describe("path-only extraction", () => {
    test("Go handler under api/handlers → receipt-upload", () => {
      expect(
        extractResourceTags({ filePath: "api/handlers/receipt_upload.go" }, opts),
      ).toEqual(["resource:receipt-upload"]);
    });

    test("SvelteKit route with +page.svelte → receipt-upload", () => {
      expect(
        extractResourceTags(
          { filePath: "frontend/src/routes/receipt-upload/+page.svelte" },
          opts,
        ),
      ).toEqual(["resource:receipt-upload"]);
    });

    test("TypeScript API client → receipt-upload", () => {
      expect(
        extractResourceTags(
          { filePath: "frontend/src/lib/api/receiptUpload.ts" },
          opts,
        ),
      ).toEqual(["resource:receipt-upload"]);
    });

    test("generic filenames fall back to parent directory", () => {
      expect(
        extractResourceTags(
          { filePath: "frontend/src/routes/receipt-upload/+layout.svelte" },
          opts,
        ),
      ).toEqual(["resource:receipt-upload"]);
    });

    test("bare index.ts inside a bucket emits no resource tag", () => {
      // routes/index.ts: parent is the structural bucket `routes`, leaf is
      // generic. Nothing meaningful to tag.
      expect(extractResourceTags({ filePath: "src/routes/index.ts" }, opts)).toEqual(
        [],
      );
    });

    test("stopword-only leaf is dropped", () => {
      // auth.ts directly under src — only token is a stopword.
      expect(extractResourceTags({ filePath: "src/auth.ts" }, opts)).toEqual([]);
    });

    test("user-profile survives (2 meaningful tokens, one stopword)", () => {
      expect(
        extractResourceTags({ filePath: "api/handlers/user_profile.go" }, opts),
      ).toEqual(["resource:profile"]);
    });
  });

  describe("nested resources", () => {
    test("handlers/receipt/upload.go → both receipt and receipt-upload", () => {
      const tags = extractResourceTags(
        { filePath: "api/handlers/receipt/upload.go" },
        opts,
      );
      expect(tags).toContain("resource:receipt");
      expect(tags).toContain("resource:receipt-upload");
    });
  });

  describe("symbol-derived extraction", () => {
    test("ReceiptUploadHandler → receipt-upload", () => {
      expect(
        extractResourceTags(
          { filePath: "src/handlers.go", symbolName: "ReceiptUploadHandler" },
          opts,
        ),
      ).toContain("resource:receipt-upload");
    });

    test("strips Service suffix", () => {
      expect(
        extractResourceTags(
          { filePath: "src/svc.go", symbolName: "OcrPipelineService" },
          opts,
        ),
      ).toContain("resource:ocr-pipeline");
    });

    test("symbol alone yields no tag when filePath is empty", () => {
      expect(
        extractResourceTags({ filePath: "", symbolName: "ReceiptUpload" }, opts),
      ).toEqual([]);
    });
  });

  describe("queue / worker / job family", () => {
    test("OcrWorker + worker/ocr_worker.go → resource:ocr only", () => {
      const tags = extractResourceTags(
        { filePath: "worker/ocr_worker.go", symbolName: "OcrWorker" },
        opts,
      );
      expect(tags).toEqual(["resource:ocr"]);
    });

    test("UpstageOCRWorker (real tb-ocr) → file-level resource:ocr + symbol resource:upstage-ocr", () => {
      // Regression guard: camel + consecutive uppercase run (OCR) with a prefix
      // (Upstage) leaves `resource:upstage-ocr` at the symbol level. The shared
      // `resource:ocr` only arrives via the path-leaf route after the stopwords
      // expansion drops `worker` from the leaf.
      const tags = extractResourceTags(
        {
          filePath: "backend/internal/worker/ocr_worker.go",
          symbolName: "UpstageOCRWorker",
        },
        opts,
      );
      expect(tags).toContain("resource:ocr");
      expect(tags).toContain("resource:upstage-ocr");
    });

    test("PaymentConsumer + worker/payment_consumer.go → resource:payment", () => {
      const tags = extractResourceTags(
        { filePath: "worker/payment_consumer.go", symbolName: "PaymentConsumer" },
        opts,
      );
      expect(tags).toEqual(["resource:payment"]);
    });

    test("publishOcrJob symbol → resource:ocr via Job suffix strip + publish stopword", () => {
      const tags = extractResourceTags(
        { filePath: "src/publisher.go", symbolName: "publishOcrJob" },
        opts,
      );
      expect(tags).toContain("resource:ocr");
    });

    test("PublishOCRJob PascalCase variant → resource:ocr", () => {
      const tags = extractResourceTags(
        { filePath: "worker/ocr_worker.go", symbolName: "PublishOCRJob" },
        opts,
      );
      expect(tags).toContain("resource:ocr");
    });

    test("PublishOCRJobWithFallback: path propagation still surfaces resource:ocr", () => {
      // `Fallback` is not a symbol-suffix and is not a stopword, so the symbol
      // alone lands on `resource:ocr-with-fallback`. The file-level path tag
      // from `worker/ocr_worker.go` delivers the canonical `resource:ocr`.
      const tags = extractResourceTags(
        {
          filePath: "backend/internal/worker/ocr_worker.go",
          symbolName: "PublishOCRJobWithFallback",
        },
        opts,
      );
      expect(tags).toContain("resource:ocr");
    });

    test("OcrHandler regression: still yields resource:ocr", () => {
      const tags = extractResourceTags(
        { filePath: "handlers/ocr.go", symbolName: "OcrHandler" },
        opts,
      );
      expect(tags).toEqual(["resource:ocr"]);
    });

    test("handler ↔ worker pair share resource:ocr (Q3 fixture)", () => {
      const handler = extractResourceTags(
        {
          filePath: "backend/api/handlers/ocr.go",
          symbolName: "OCRHandler",
        },
        opts,
      );
      const worker = extractResourceTags(
        {
          filePath: "backend/internal/worker/ocr_worker.go",
          symbolName: "UpstageOCRWorker",
        },
        opts,
      );
      const shared = handler.filter((t) => worker.includes(t));
      expect(shared).toContain("resource:ocr");
    });
  });

  describe("test-file handling", () => {
    test("strips test token so test links to its subject", () => {
      expect(
        extractResourceTags(
          { filePath: "src/handlers/receipt_upload.test.ts" },
          opts,
        ),
      ).toEqual(["resource:receipt-upload"]);
    });
  });

  describe("includePaths / excludePaths filtering", () => {
    test("excludePaths drops everything", () => {
      const customOpts = defaultExtractorOpts({
        excludePaths: ["**/vendor/**", "**/generated/**"],
      });
      expect(
        extractResourceTags(
          { filePath: "vendor/github.com/foo/bar.go" },
          customOpts,
        ),
      ).toEqual([]);
      expect(
        extractResourceTags(
          { filePath: "src/generated/receipt.ts" },
          customOpts,
        ),
      ).toEqual([]);
    });

    test("includePaths gates extraction", () => {
      const customOpts = defaultExtractorOpts({
        includePaths: ["backend/**"],
      });
      // Not in include list → dropped.
      expect(
        extractResourceTags(
          { filePath: "frontend/src/routes/receipt-upload/+page.svelte" },
          customOpts,
        ),
      ).toEqual([]);
      // In include list → processed.
      expect(
        extractResourceTags(
          { filePath: "backend/handlers/receipt_upload.go" },
          customOpts,
        ),
      ).toEqual(["resource:receipt-upload"]);
    });
  });

  describe("edge cases", () => {
    test("empty filePath → []", () => {
      expect(extractResourceTags({ filePath: "" }, opts)).toEqual([]);
    });

    test("single-char result dropped by MIN_RESOURCE_LEN", () => {
      expect(
        extractResourceTags({ filePath: "src/handlers/a.go" }, opts),
      ).toEqual([]);
    });

    test("opt-out by disabling: caller controls via config.enabled", () => {
      // The extractor itself does not read `enabled`; callers gate the call.
      // This test documents that contract by showing default opts always emit.
      expect(
        extractResourceTags({ filePath: "api/handlers/receipt.go" }, opts),
      ).toEqual(["resource:receipt"]);
    });
  });
});

describe("tagWeight", () => {
  test("resource:* tags use resourceWeight", () => {
    expect(tagWeight("resource:receipt-upload", 3)).toBe(3);
  });
  test("non-resource tags use weight 1", () => {
    expect(tagWeight("handlers", 3)).toBe(1);
    expect(tagWeight("function", 3)).toBe(1);
  });
});
