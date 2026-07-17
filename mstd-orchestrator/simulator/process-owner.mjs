import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Chat lock + optional daemon ownership.
 * Never kills a daemon we did not start.
 */
export function createChatLock(lockPath) {
  return {
    path: lockPath,
    tryAcquire({ pid, runId }) {
      if (existsSync(lockPath)) {
        try {
          const existing = JSON.parse(readFileSync(lockPath, "utf8"));
          if (existing.pid && isAlive(existing.pid)) {
            return { ok: false, reason: "lock_held", existing };
          }
        } catch {
          // stale/corrupt → reclaim
        }
      }
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(lockPath, JSON.stringify({ pid, runId, at: Date.now() }));
      return { ok: true };
    },
    release({ pid }) {
      if (!existsSync(lockPath)) return;
      try {
        const existing = JSON.parse(readFileSync(lockPath, "utf8"));
        if (existing.pid === pid) unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    },
  };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
