import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

let logPath: string | null = null;

function file(): string {
  if (!logPath) {
    const dir = app.getPath("userData");
    mkdirSync(dir, { recursive: true });
    logPath = path.join(dir, "startup.log");
  }
  return logPath;
}

export function logStartup(message: string, err?: unknown): void {
  const line = `[${new Date().toISOString()}] ${message}${
    err !== undefined ? ` ${err instanceof Error ? err.stack ?? err.message : String(err)}` : ""
  }\n`;
  try {
    appendFileSync(file(), line, "utf8");
  } catch {
    /* ignore */
  }
  if (process.env.NODE_ENV === "development" || !app.isPackaged) {
    console.error(line.trim());
  }
}
