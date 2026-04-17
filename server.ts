#!/usr/bin/env bun
import path from "node:path";
import { existsSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { openClient } from "./src/db/client.ts";
import { loadConfig } from "./src/config/loader.ts";
import { defaultConfig, DEFAULT_CONFIG_PATH } from "./src/config/defaults.ts";
import { createEmbedder } from "./src/indexer/embedder.ts";
import type { ToolContext, ToolResult } from "./src/tools/context.ts";
import { errorResult } from "./src/tools/context.ts";
import { searchCodeToolDef, searchCodeHandler } from "./src/tools/search-code.ts";
import { lookupFileToolDef, lookupFileHandler } from "./src/tools/lookup-file.ts";
import { searchSymbolToolDef, searchSymbolHandler } from "./src/tools/search-symbol.ts";
import { getRelatedToolDef, getRelatedHandler } from "./src/tools/get-related.ts";
import { indexStatusToolDef, indexStatusHandler } from "./src/tools/index-status.ts";
import { rebuildIndexToolDef, rebuildIndexHandler } from "./src/tools/rebuild-index.ts";

export const VERSION = "0.1.0";

if (import.meta.main) {
  await main();
}

async function main(): Promise<void> {
  const projectRoot = path.resolve(process.env.CC_ADVANCED_RAG_ROOT ?? process.cwd());
  const configPath = process.env.CC_ADVANCED_RAG_CONFIG ??
    path.join(projectRoot, DEFAULT_CONFIG_PATH);

  const config = existsSync(configPath) ? loadConfig(configPath) : defaultConfig();
  const dbPath = path.isAbsolute(config.dbPath)
    ? config.dbPath
    : path.join(projectRoot, config.dbPath);

  const client = openClient({ dbPath, dimension: config.embedding.dimension });
  const embedder = createEmbedder(config.embedding);

  const ctx: ToolContext = { db: client.db, config, embedder, projectRoot };

  const server = new Server(
    { name: "cc-advanced-rag", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      searchCodeToolDef,
      lookupFileToolDef,
      searchSymbolToolDef,
      getRelatedToolDef,
      indexStatusToolDef,
      rebuildIndexToolDef,
    ],
  }));

  const dispatch = async (name: string, rawArgs: Record<string, unknown>): Promise<ToolResult> => {
    switch (name) {
      case "search_code":
        return searchCodeHandler(rawArgs as never, ctx);
      case "lookup_file":
        return lookupFileHandler(rawArgs as never, ctx);
      case "search_symbol":
        return searchSymbolHandler(rawArgs as never, ctx);
      case "get_related":
        return getRelatedHandler(rawArgs as never, ctx);
      case "index_status":
        return indexStatusHandler({} as Record<string, never>, ctx);
      case "rebuild_index":
        return rebuildIndexHandler(rawArgs as never, ctx);
      default:
        return errorResult(`Unknown tool: ${name}`);
    }
  };

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const rawArgs = (args ?? {}) as Record<string, unknown>;
    try {
      return (await dispatch(name, rawArgs)) as unknown as Parameters<
        typeof server.setRequestHandler
      >[1] extends never
        ? never
        : Awaited<ReturnType<Parameters<typeof server.setRequestHandler>[1]>>;
    } catch (err) {
      const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
      return errorResult(`Error: ${msg}`) as never;
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[cc-advanced-rag] ready");

  const shutdown = () => {
    try {
      client.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
