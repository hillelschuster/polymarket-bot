import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireProcessLock(name = "hermes-polymarket-bot"): () => void {
  const lockPath = process.env.BOT_LOCK_FILE ?? path.join(os.tmpdir(), `${name}.lock`);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, `${process.pid}\n`, "utf8");
      closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try { unlinkSync(lockPath); } catch { /* already released */ }
      };
      process.once("exit", release);
      return release;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(readFileSync(lockPath, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0 && processIsAlive(pid)) {
        throw new Error(`another ${name} process is already running (PID ${pid})`);
      }
      unlinkSync(lockPath);
    }
  }

  throw new Error(`could not acquire ${name} process lock`);
}
