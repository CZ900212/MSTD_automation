// 记忆文件层：五层读写 + 字符上限 + 外部漂移检测（.bak 备份）+ journal 追加。
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

export class DriftError extends Error {
  constructor(path) { super(`记忆文件被外部修改，拒绝覆盖（已 .bak 备份）: ${path}`); this.name = "DriftError"; }
}
export class LimitError extends Error {
  constructor(layer, limit) { super(`${layer} 层超过字符上限 ${limit}，请先合并淘汰`); this.name = "LimitError"; }
}

const LIMITS = { org: 4000, group: 2200, user: 1375 };   // soul/journal 不设限
export const USER_JOURNAL_MAX_CHARS = 4000;
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export function createMemoryFiles({ rootDir }) {
  function pathOf(layer, id) {
    switch (layer) {
      case "soul": return join(rootDir, "SOUL.md");
      case "org": return join(rootDir, "memory", "ORG.md");
      case "group":
      case "user": {
        if (!id || !SAFE_ID.test(id)) throw new Error(`非法记忆 id: ${id}`);
        return join(rootDir, "memory", layer === "group" ? "groups" : "users", `${id}.md`);
      }
      default:
        throw new Error(`未知记忆层: ${layer}`);
    }
  }

  function journalPath(now = Date.now()) {
    const d = new Date(now).toISOString().slice(0, 10);
    return join(rootDir, "memory", "journal", `${d}.md`);
  }

  function userJournalPath(openId) {
    if (!openId || !SAFE_ID.test(openId)) throw new Error(`非法记忆 id: ${openId}`);
    return join(rootDir, "memory", "user-journal", `${openId}.md`);
  }

  function readWithHash(p) {
    const content = existsSync(p) ? readFileSync(p, "utf8") : "";
    return { content, snapshotHash: sha256(content) };
  }

  function writeGuarded(p, content, { expectedHash } = {}) {
    if (expectedHash !== undefined) {
      const current = existsSync(p) ? readFileSync(p, "utf8") : "";
      if (sha256(current) !== expectedHash) {
        if (existsSync(p)) copyFileSync(p, `${p}.bak.${Date.now()}`);
        throw new DriftError(p);
      }
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, "utf8");
    return { snapshotHash: sha256(content) };
  }

  function readLayer(layer, id) {
    return readWithHash(pathOf(layer, id));
  }

  function writeLayer(layer, id, content, { expectedHash } = {}) {
    const limit = LIMITS[layer];
    if (limit && content.length > limit) throw new LimitError(layer, limit);
    return writeGuarded(pathOf(layer, id), content, { expectedHash });
  }

  function appendJournal(entryText, now = Date.now()) {
    const p = journalPath(now);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, entryText.endsWith("\n") ? entryText : entryText + "\n", "utf8");
  }

  function readJournal(now = Date.now()) {
    const p = journalPath(now);
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  }

  function readUserJournal(openId) {
    return readWithHash(userJournalPath(openId));
  }

  function writeUserJournal(openId, content, { expectedHash } = {}) {
    if (content.length > USER_JOURNAL_MAX_CHARS) {
      throw new LimitError("user-journal", USER_JOURNAL_MAX_CHARS);
    }
    return writeGuarded(userJournalPath(openId), content, { expectedHash });
  }

  return {
    readLayer,
    writeLayer,
    appendJournal,
    readJournal,
    readUserJournal,
    writeUserJournal,
    pathOf,
    rootDir,
  };
}
