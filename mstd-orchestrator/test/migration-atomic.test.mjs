import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync } from "node:fs";
import { applyMigration, openDb } from "../server/db/index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "../server/db/migrations");

describe("migration transaction boundary", () => {
  it("rolls back an interrupted 017 upgrade from 016 and remains retryable", () => {
    const db = openDb();
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)");
    const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
    for (const name of files.filter((entry) => entry < "017_")) {
      applyMigration(db, { name, sql: readFileSync(join(MIGRATIONS, name), "utf8") });
    }
    expect(db.prepare("SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1").get().name)
      .toMatch(/^016_/);

    const name = files.find((entry) => entry.startsWith("017_"));
    const sql = readFileSync(join(MIGRATIONS, name), "utf8");
    expect(() => applyMigration(db, {
      name,
      sql,
      beforeRecord: () => { throw new Error("injected crash after SQL"); },
    })).toThrow(/injected crash/);

    expect(db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(name)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'security_quarantine'").get())
      .toBeUndefined();
    expect(db.prepare("PRAGMA table_info(agent_messages)").all().map((row) => row.name))
      .not.toContain("prompt_eligible");

    expect(() => applyMigration(db, { name, sql })).not.toThrow();
    expect(db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(name)).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'security_quarantine'").get())
      .toBeTruthy();
  });
});
