import fs from "fs";
import path from "path";
import { LOGS_DIR } from "./paths";

// ===========================================================================
// App logging helper
// ===========================================================================
export const LOG_PATH = path.join(LOGS_DIR, "app.log");
export const LOG_RING_SIZE = 500;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const logRing: string[] = [];

export function appendLog(line: string): void {
  const entry = `[${new Date().toISOString()}] ${line}`;
  logRing.push(entry);
  if (logRing.length > LOG_RING_SIZE) logRing.shift();
  try {
    fs.appendFileSync(LOG_PATH, entry + "\n", "utf-8");
    // Cap on-disk growth: a single rollover to app.log.1 once past the limit.
    if (fs.statSync(LOG_PATH).size > LOG_MAX_BYTES) {
      try { fs.rmSync(LOG_PATH + ".1", { force: true }); } catch {}
      try { fs.renameSync(LOG_PATH, LOG_PATH + ".1"); } catch {}
    }
  } catch {}
}

export function getRecentLogs(n = 100): string[] {
  return logRing.slice(-Math.min(n, LOG_RING_SIZE));
}

// Read only the tail of the on-disk log (never the whole file). The byte window
// is bounded so an accidentally-large file is never fully slurped into memory.
export function readLogTailLines(maxLines: number): string[] {
  let fd: number | null = null;
  try {
    const size = fs.statSync(LOG_PATH).size;
    const readBytes = Math.min(size, Math.max(64 * 1024, maxLines * 1024));
    const start = size - readBytes;
    const buf = Buffer.alloc(readBytes);
    fd = fs.openSync(LOG_PATH, "r");
    fs.readSync(fd, buf, 0, readBytes, start);
    let text = buf.toString("utf-8");
    // Drop a partial first line when the window started mid-file.
    if (start > 0) {
      const firstNl = text.indexOf("\n");
      if (firstNl !== -1) text = text.slice(firstNl + 1);
    }
    return text.trim().split("\n").filter(Boolean);
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}
