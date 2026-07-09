import { resolve, sep } from "node:path";
import { readdirSync, statSync, rmSync, existsSync } from "node:fs";

export function jobWorkdir(baseDir, jobId) {
  return resolve(baseDir, String(jobId));
}

export function resolveInsideWorkdir(workdir, requestedPath) {
  const abs = resolve(workdir, String(requestedPath));
  const root = resolve(workdir);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`路径越界（outside workdir）: ${requestedPath}`);
  }
  return abs;
}

export function sweepExpiredExports(baseDir, ttlMs, now = Date.now()) {
  const root = resolve(baseDir);
  if (!existsSync(root)) return [];
  const removed = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = resolve(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (now - st.mtimeMs > ttlMs) { rmSync(p, { force: true }); removed.push(p); }
    }
  };
  walk(root);
  return removed;
}
