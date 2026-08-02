import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

export interface RuntimeContext {
  runId: string;
  gitSha: string;
  sqlitePath: string;
}

let context: RuntimeContext | undefined;
let startupLogged = false;

export function getRuntimeContext(): RuntimeContext {
  if (!context) {
    context = {
      runId: process.env.RUN_ID ?? randomUUID(),
      gitSha: process.env.GIT_SHA ?? readGitSha(),
      sqlitePath: resolveSqlitePath(process.env.DATABASE_URL),
    };
  }
  return context;
}

export function logStartupContext(): void {
  if (startupLogged) return;
  startupLogged = true;
  const runtime = getRuntimeContext();
  console.log(`startup context: PID=${process.pid} RUN_ID=${runtime.runId} GIT_SHA=${runtime.gitSha} SQLITE=${runtime.sqlitePath}`);
}

function readGitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function resolveSqlitePath(databaseUrl: string | undefined): string {
  const rawUrl = databaseUrl?.startsWith("file:") ? databaseUrl.slice(5) : databaseUrl;
  const rawPath = decodeURIComponent((rawUrl ?? "./dev.db").split("?", 1)[0]);
  return path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(process.cwd(), "prisma", rawPath);
}
