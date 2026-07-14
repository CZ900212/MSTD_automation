import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";

describe("session store", () => {
  it("getOrCreate 幂等；append/transcript 按 ts 序；软删不出现在 transcript；版本自增", () => {
    const db = openDb();
    migrate(db);
    const store = createSessionStore(db);
    const s1 = store.getOrCreate("feishu:p2p:ou_a", { kind: "p2p", title: "张三" });
    const s2 = store.getOrCreate("feishu:p2p:ou_a");
    expect(s2.id).toBe(s1.id);

    const m1 = store.append(s1.id, { role: "user", senderOpenId: "ou_a", content: "第一句", ts: 1000 });
    store.append(s1.id, { role: "assistant", content: "回复", ts: 2000 });
    expect(store.transcript(s1.id).map((m) => m.content)).toEqual(["第一句", "回复"]);

    store.softDelete(m1.id);
    expect(store.transcript(s1.id).map((m) => m.content)).toEqual(["回复"]);

    expect(store.bumpVersion(s1.id)).toBe(1);
    expect(store.bumpVersion(s1.id)).toBe(2);
  });

  it("touch 只推进 updated_at，不被迟到时间回退", () => {
    const db = openDb();
    migrate(db);
    const store = createSessionStore(db);
    const session = store.getOrCreate("feishu:p2p:ou_touch", { kind: "p2p" }, 2000);

    store.touch(session.id, 1000);
    expect(db.prepare("SELECT updated_at FROM agent_sessions WHERE id = ?").get(session.id).updated_at).toBe(2000);

    store.touch(session.id, 3000);
    expect(db.prepare("SELECT updated_at FROM agent_sessions WHERE id = ?").get(session.id).updated_at).toBe(3000);
  });
});

// Task 7 C3.5：持久 nudge watermark——从 transcript 模数判断改为累计计数 + 事务 claim
describe("claimMemoryNudge 状态机（Task 7）", () => {
  let db, store, s;
  beforeEach(() => {
    db = openDb(); migrate(db);
    store = createSessionStore(db);
    s = store.getOrCreate("feishu:p2p:ou_n", { kind: "p2p" });
  });
  const addUsers = (n, from = 0) => { for (let i = 0; i < n; i++) store.append(s.id, { role: "user", content: `u${from + i}`, ts: from + i + 1 }); };

  it("9 条 false;跨到 11 时 true 恰一次;重复 false;到 20 再 true", () => {
    addUsers(9);
    expect(store.claimMemoryNudge(s.id)).toBe(false);
    addUsers(2, 9);                                            // 一次批量跨过 10
    expect(store.claimMemoryNudge(s.id)).toBe(true);
    expect(store.claimMemoryNudge(s.id)).toBe(false);          // 已 claim
    addUsers(9, 11);                                           // 到 20
    expect(store.claimMemoryNudge(s.id)).toBe(true);
    expect(store.claimMemoryNudge(s.id)).toBe(false);
  });

  it("watermark 持久化:重建 store(模拟重启)后不重复提醒", () => {
    addUsers(11);
    expect(store.claimMemoryNudge(s.id)).toBe(true);
    const store2 = createSessionStore(db);                                      // 同一 db,新 store 实例
    expect(store2.claimMemoryNudge(s.id)).toBe(false);
  });

  // §5.2 审卷补杀:文件库关连接重开(真重启形态)——杀"水位存内存/挂 db 对象"变异
  it("watermark 持久于文件库:关连接重开后不重复提醒", () => {
    const path = join(tmpdir(), `nudge-test-${process.pid}-${Math.floor(Math.random() * 1e9)}.db`);
    try {
      const db1 = openDb(path); migrate(db1);
      const st1 = createSessionStore(db1);
      const sf = st1.getOrCreate("feishu:p2p:ou_f", { kind: "p2p" });
      for (let i = 0; i < 11; i++) st1.append(sf.id, { role: "user", content: `u${i}`, ts: i + 1 });
      expect(st1.claimMemoryNudge(sf.id)).toBe(true);
      db1.close();
      const db2 = openDb(path); migrate(db2);
      expect(createSessionStore(db2).claimMemoryNudge(sf.id)).toBe(false);
      db2.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    }
  });

  // §5.2 审卷补杀:过滤条件逐项判别——删任一过滤(observed/assistant/tool)都必须能红
  it("9 有效 + observed/assistant/tool 各一条仍 false;补 1 有效才 true", () => {
    addUsers(9);
    store.append(s.id, { role: "user", content: "旁听", observed: true, ts: 50 });
    store.append(s.id, { role: "assistant", content: "a", ts: 51 });
    store.append(s.id, { role: "tool", content: "t", ts: 52 });
    expect(store.claimMemoryNudge(s.id)).toBe(false);
    addUsers(1, 60);
    expect(store.claimMemoryNudge(s.id)).toBe(true);
  });

  it("累计到 1000+ 不封顶:1000 处 claim 后加 10 再 true,watermark=1010", () => {
    addUsers(1000);
    expect(store.claimMemoryNudge(s.id)).toBe(true);
    addUsers(10, 1000);
    expect(store.claimMemoryNudge(s.id)).toBe(true);
    expect(db.prepare("SELECT memory_nudge_watermark w FROM agent_sessions WHERE id = ?").get(s.id).w).toBe(1010);
  });

  it("会话隔离:A 的消息不触发 B,watermark 各自独立（铁律 5）", () => {
    const b = store.getOrCreate("feishu:p2p:ou_b2", { kind: "p2p" });
    addUsers(11);
    expect(store.claimMemoryNudge(b.id)).toBe(false);
    expect(store.claimMemoryNudge(s.id)).toBe(true);
    expect(db.prepare("SELECT memory_nudge_watermark w FROM agent_sessions WHERE id = ?").get(b.id).w).toBe(0);
  });

  it("watermark 只进不退:预置高水位时 claim/peek 皆 false 且水位不变", () => {
    addUsers(11);
    db.prepare("UPDATE agent_sessions SET memory_nudge_watermark = 100 WHERE id = ?").run(s.id);
    expect(store.claimMemoryNudge(s.id)).toBe(false);
    expect(store.peekMemoryNudge(s.id)).toBe(false);
    expect(db.prepare("SELECT memory_nudge_watermark w FROM agent_sessions WHERE id = ?").get(s.id).w).toBe(100);
  });

  it("累计计数不受 softDelete/observed/窗口影响", () => {
    addUsers(10);
    const first = store.recent(s.id, { limit: 1 })[0] ?? null;
    // softDelete 早期消息不减少累计
    const rows = db.prepare("SELECT id FROM agent_messages WHERE session_id = ? ORDER BY ts LIMIT 3").all(s.id);
    for (const r of rows) store.softDelete(r.id);
    // observed 消息不计入
    for (let i = 0; i < 5; i++) store.append(s.id, { role: "user", content: `ob${i}`, observed: true, ts: 100 + i });
    // assistant/tool 不计入
    store.append(s.id, { role: "assistant", content: "a", ts: 200 });
    store.append(s.id, { role: "tool", content: "t", ts: 201 });
    expect(store.claimMemoryNudge(s.id)).toBe(true);           // 非 observed user 累计恰 10
    expect(store.claimMemoryNudge(s.id)).toBe(false);
    void first;
  });
});

// §5.1 审核采纳:peek(不落水位)/claim(成功后消费) 分离
describe("peekMemoryNudge / claimMemoryNudge 分离（Task 7 审核修正）", () => {
  let db, store, s;
  beforeEach(() => {
    db = openDb(); migrate(db);
    store = createSessionStore(db);
    s = store.getOrCreate("feishu:p2p:ou_pk", { kind: "p2p" });
  });

  it("peek 为真但不推进水位;claim 后 peek 变假", () => {
    for (let i = 0; i < 11; i++) store.append(s.id, { role: "user", content: `u${i}`, ts: i + 1 });
    expect(store.peekMemoryNudge(s.id)).toBe(10);
    expect(store.peekMemoryNudge(s.id)).toBe(10);            // peek 幂等,不消费
    expect(store.claimMemoryNudge(s.id)).toBe(true);
    expect(store.peekMemoryNudge(s.id)).toBe(false);
    expect(store.claimMemoryNudge(s.id)).toBe(false);
  });

  it("captures an exact point so messages arriving during maintenance remain pending", () => {
    for (let i = 0; i < 10; i++) store.append(s.id, { role: "user", content: `u${i}`, ts: i + 1 });
    const point = store.peekMemoryNudge(s.id);
    expect(point).toBe(10);

    for (let i = 10; i < 20; i++) store.append(s.id, { role: "user", content: `u${i}`, ts: i + 1 });
    expect(store.claimMemoryNudge(s.id, { point })).toBe(true);
    expect(db.prepare("SELECT memory_nudge_watermark w FROM agent_sessions WHERE id = ?").get(s.id).w).toBe(10);
    expect(store.peekMemoryNudge(s.id)).toBe(20);
    expect(store.claimMemoryNudge(s.id, { point })).toBe(false);
    expect(store.claimMemoryNudge(s.id, { point: 20 })).toBe(true);
  });

  it("9 条 peek 为假", () => {
    for (let i = 0; i < 9; i++) store.append(s.id, { role: "user", content: `u${i}`, ts: i + 1 });
    expect(store.peekMemoryNudge(s.id)).toBe(false);
  });
});
