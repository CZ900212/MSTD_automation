import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

export function openDb(path = ":memory:") {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  return db;
}

export function migrate(db) {
  const dir = join(HERE, "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(dir, f), "utf8"));
  }
}
