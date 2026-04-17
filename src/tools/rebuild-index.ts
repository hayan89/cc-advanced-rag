import { existsSync, readFileSync } from "node:fs";
import { textResult, type ToolContext, type ToolResult } from "./context.ts";

export const rebuildIndexToolDef = {
  name: "rebuild_index",
  description:
    "인덱싱을 재실행합니다. 서버 프로세스에서는 동기 실행을 차단하고, " +
    "별도의 `bun run <plugin>/scripts/index.ts` 실행을 안내하거나, " +
    "진행 중인 작업이 있으면 그 jobId를 반환합니다. " +
    "인자: { scope?: string, since?: string (commit-ish), full?: boolean, async?: boolean }.",
  inputSchema: {
    type: "object",
    properties: {
      scope: { type: "string", description: "scope 필터 (선택)" },
      since: {
        type: "string",
        description: "증분 기준 git commit-ish (선택). 없으면 ledger 기반.",
      },
      full: { type: "boolean", description: "true면 전체 재인덱싱 (기본 false)" },
      async: {
        type: "boolean",
        description: "true면 jobId 반환 후 index_status로 폴링 (기본 true)",
      },
    },
  },
} as const;

export async function rebuildIndexHandler(
  args: { scope?: string; since?: string; full?: boolean; async?: boolean },
  ctx: ToolContext,
): Promise<ToolResult> {
  const lockPath = ctx.config.lockPath;

  if (lockPath && existsSync(lockPath)) {
    const holder = safeReadPid(lockPath);
    return textResult(
      `[lock held] 인덱싱 중인 프로세스가 있습니다. holder_pid=${holder ?? "?"}\n` +
        `해당 작업이 끝난 후 다시 시도하거나 'index_status'로 확인하세요.`,
    );
  }

  const mode = args.full ? "full" : args.since ? `since=${args.since}` : "incremental";
  const scope = args.scope ?? "(all)";
  const isAsync = args.async ?? true;

  // 서버 프로세스는 경량 MCP 응답 채널이고, 인덱서는 `bun scripts/index.ts`
  // 별도 프로세스로 실행해야 안전함(대용량 병렬 I/O·워치독 등). 여기서는 호출자에게
  // 실행 커맨드를 돌려준다.
  const cmd = [
    `bun`,
    `<plugin-root>/scripts/index.ts`,
    args.full ? `--full` : null,
    args.since ? `--since=${args.since}` : null,
    args.scope ? `--scope=${args.scope}` : null,
    isAsync ? `--background` : null,
  ]
    .filter((s): s is string => Boolean(s))
    .join(" ");

  return textResult(
    [
      `[rebuild_index requested]`,
      `- mode: ${mode}`,
      `- scope: ${scope}`,
      `- async: ${isAsync}`,
      ``,
      `서버는 인덱싱을 직접 구동하지 않습니다. 플러그인 루트에서 실행하세요:`,
      `  ${cmd}`,
      ``,
      `완료 후 'index_status'로 chunks/files 수를 확인할 수 있습니다.`,
    ].join("\n"),
  );
}

function safeReadPid(lockPath: string): number | null {
  try {
    const raw = readFileSync(lockPath, "utf-8").trim();
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
