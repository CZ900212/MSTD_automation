import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

export function openDb(path = ":memory:") {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL"); // 双进程并发写防护（:memory: 下自动为 memory 模式，无副作用）
  return db;
}

export function applyMigration(db, { name, sql, beforeRecord = null }) {
  if (!name?.trim()) throw new Error("migration name 必填");
  if (typeof sql !== "string") throw new Error("migration sql 必须是字符串");
  const apply = db.transaction(() => {
    if (db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(name)) return;
    db.exec(sql);
    beforeRecord?.({ name });
    db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(name, Date.now());
  });
  apply.immediate();
}

export function migrate(db) {
  // 迁移追踪：非幂等语句（如 ALTER TABLE ADD COLUMN）只执行一次
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)");
  const applied = new Set(db.prepare("SELECT name FROM schema_migrations").all().map((r) => r.name));
  const dir = join(HERE, "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    if (applied.has(f)) continue;
    applyMigration(db, { name: f, sql: readFileSync(join(dir, f), "utf8") });
  }
}
