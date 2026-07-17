import { resolve, sep, relative, isAbsolute } from "node:path";
import { readdirSync, statSync, lstatSync, realpathSync, rmSync, existsSync, readFileSync } from "node:fs";

export const MAX_JOB_ARTIFACT_BYTES = 1_000_000;

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root + sep);
}

export function jobWorkdir(baseDir, jobId) {
  const root = resolve(baseDir);
  const workdir = resolve(root, String(jobId));
  if (!isInside(root, workdir) || workdir === root) {
    throw new Error(`非法 job workdir: ${jobId}`);
  }
  return workdir;
}

export function resolveInsideWorkdir(workdir, requestedPath) {
  const requested = String(requestedPath ?? "");
  if (!requested || isAbsolute(requested)) throw new Error(`路径越界（outside workdir）: ${requestedPath}`);
  const root = resolve(workdir);
  const abs = resolve(root, requested);
  if (!isInside(root, abs) || abs === root) {
    throw new Error(`路径越界（outside workdir）: ${requestedPath}`);
  }
  return abs;
}

// Job readers consume only artifacts explicitly emitted below ./out. Files must be
// regular, non-symlinked, and resolve beneath the real artifact directory.
export function readJobArtifactUtf8(workdir, requestedPath, maxBytes = MAX_JOB_ARTIFACT_BYTES) {
  const abs = resolveInsideWorkdir(workdir, requestedPath);
  const root = resolve(workdir);
  const artifactRoot = resolve(root, "out");
  const fromRoot = relative(root, abs);
  if (fromRoot === "out" || !fromRoot.startsWith(`out${sep}`)) {
    throw new Error(`仅允许读取 job artifact（out/）: ${requestedPath}`);
  }

  const linkStat = lstatSync(abs);
  if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
    throw new Error(`artifact 必须是普通文件: ${requestedPath}`);
  }
  if (linkStat.size > maxBytes) throw new Error(`artifact 超出大小上限 (${maxBytes} bytes): ${requestedPath}`);

  const realArtifactRoot = realpathSync(artifactRoot);
  const realFile = realpathSync(abs);
  if (!isInside(realArtifactRoot, realFile) || realFile === realArtifactRoot) {
    throw new Error(`artifact 实路径越界: ${requestedPath}`);
  }
  const finalStat = statSync(realFile);
  if (!finalStat.isFile()) throw new Error(`artifact 必须是普通文件: ${requestedPath}`);
  return readFileSync(realFile, "utf8");
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
