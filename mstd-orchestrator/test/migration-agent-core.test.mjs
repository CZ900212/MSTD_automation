import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";

describe("003_agent_core migration", () => {
  it("建齐五张表且 FTS trigram 可检中文", () => {
    const db = openDb();
    migrate(db);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
    ).all().map((r) => r.name);
    for (const t of ["agent_sessions", "agent_messages", "group_policies", "inbox_events", "agent_messages_fts"])
      expect(tables).toContain(t);
    db.prepare("INSERT INTO agent_messages_fts (message_id, session_id, content) VALUES (?,?,?)")
      .run("m1", "s1", "下周三交付武汉项目方案");
    // trigram MATCH 需 ≥3 字符；短查询走 LIKE（trigram 索引同样加速）
    const hit3 = db.prepare(
      "SELECT message_id FROM agent_messages_fts WHERE agent_messages_fts MATCH ?"
    ).all("武汉项目");
    expect(hit3.map((r) => r.message_id)).toContain("m1");
    const hit2 = db.prepare(
      "SELECT message_id FROM agent_messages_fts WHERE content LIKE ?"
    ).all("%武汉%");
    expect(hit2.map((r) => r.message_id)).toContain("m1");
  });
});
