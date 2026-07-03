import { spawn, ChildProcess } from "child_process";

// Shared child-process termination helper. Used by the SD process manager and
// the Claude bridge. On Windows the child may spawn its own tree (cmd.exe shim,
// SD subprocesses), so we taskkill the whole tree; elsewhere a SIGTERM suffices.
export function killProc(proc: ChildProcess): void {
  try {
    proc.stdin?.end();
  } catch {}
  try {
    if (process.platform === "win32" && proc.pid) {
      const tk = spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"]);
      tk.on("error", () => {}); // taskkill is always present on Windows; swallow for safety
    } else {
      proc.kill("SIGTERM");
    }
  } catch {}
}
