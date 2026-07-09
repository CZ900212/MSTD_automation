import { describe, it, expect } from "vitest";
import { buildInsertIgnore, buildUpsert } from "../server/db/dialect.mjs";

describe("buildInsertIgnore", () => {
  it("sqlite -> INSERT OR IGNORE", () => {
    const sql = buildInsertIgnore({ dialect: "sqlite", table: "job_actions", columns: ["job_id", "action_key"] });
    expect(sql).toBe("INSERT OR IGNORE INTO job_actions (job_id, action_key) VALUES (?, ?)");
  });
  it("postgres -> ON CONFLICT DO NOTHING", () => {
    const sql = buildInsertIgnore({ dialect: "postgres", table: "job_actions", columns: ["job_id", "action_key"], conflictColumns: ["job_id", "action_key"] });
    expect(sql).toBe("INSERT INTO job_actions (job_id, action_key) VALUES (?, ?) ON CONFLICT (job_id, action_key) DO NOTHING");
  });
  it("unknown dialect throws", () => {
    expect(() => buildInsertIgnore({ dialect: "mysql", table: "t", columns: ["a"] })).toThrow(/dialect/i);
  });
});

describe("buildUpsert", () => {
  it("emits excluded-based DO UPDATE", () => {
    const sql = buildUpsert({ dialect: "sqlite", table: "users", columns: ["id", "feishu_open_id", "name"], conflictColumns: ["feishu_open_id"], updateColumns: ["name"] });
    expect(sql).toBe("INSERT INTO users (id, feishu_open_id, name) VALUES (?, ?, ?) ON CONFLICT (feishu_open_id) DO UPDATE SET name = excluded.name");
  });
});
