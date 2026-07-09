import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

export function openDb(path = ":memory:") {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  return db;
}

export function migrate(db) {
  const sql = readFileSync(join(HERE, "migrations", "001_init.sql"), "utf8");
  db.exec(sql);
}
