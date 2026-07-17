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
      mkdirSync(dirname(lockPath), { recursive: true });
      const payload = JSON.stringify({ pid, runId, at: Date.now() });
      // "wx" 独占创建：存在性判断与写入是同一原子系统调用，避免两个并发调用者
      // 都读到"不存在"后各自写入、后者覆盖前者持有的锁。
      try {
        writeFileSync(lockPath, payload, { flag: "wx" });
        return { ok: true };
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
      let existing;
      try {
        existing = JSON.parse(readFileSync(lockPath, "utf8"));
      } catch {
        existing = null; // 损坏内容视为可回收
      }
      if (existing && existing.pid && isAlive(existing.pid)) {
        return { ok: false, reason: "lock_held", existing };
      }
      // stale/corrupt → 回收；重新走独占创建，若又与另一个回收者撞上则老实报"已被占用"
      unlinkSync(lockPath);
      try {
        writeFileSync(lockPath, payload, { flag: "wx" });
        return { ok: true };
      } catch (e) {
        if (e.code === "EEXIST") return { ok: false, reason: "lock_held", existing };
        throw e;
      }
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
