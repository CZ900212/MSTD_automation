import { describe, it, expect, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createSessionSearch } from "../server/sessions/search.mjs";

describe("session_search（FTS + 权限过滤）", () => {
  let db, store, search;
  beforeEach(() => {
    db = openDb();
    migrate(db);
    store = createSessionStore(db);
    search = createSessionSearch(db);
    const gA = store.getOrCreate("feishu:group:oc_A", { kind: "group" });
    const gB = store.getOrCreate("feishu:group:oc_B", { kind: "group" });
    const p = store.getOrCreate("feishu:p2p:ou_a", { kind: "p2p" });
    store.append(gA.id, { role: "user", content: "武汉项目下周三交付方案", ts: 1000 });
    store.append(gB.id, { role: "user", content: "武汉项目预算翻倍了", ts: 2000 });
    store.append(p.id, { role: "user", content: "我私下说武汉项目有风险", ts: 3000 });
  });

  it("群会话只搜本群；中文 trigram 命中", () => {
    const r = search.run({ query: "武汉项目" }, { sessionKey: "feishu:group:oc_A" });
    expect(r.ok).toBe(true);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].content).toContain("交付方案");
    expect(r.hits[0].sessionKey).toBe("feishu:group:oc_A");
  });

  it("私聊只搜本人；越权检索被过滤", () => {
    const r = search.run({ query: "武汉项目" }, { sessionKey: "feishu:p2p:ou_a" });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].content).toContain("私下说");
    const other = search.run({ query: "武汉项目" }, { sessionKey: "feishu:p2p:ou_stranger" });
    expect(other.hits).toHaveLength(0);
  });

  it("debug 会话只搜自会话，不再有无限范围；cron/未知一律拒绝", () => {
    const d = store.getOrCreate("debug:d1", { kind: "debug" });
    store.append(d.id, { role: "user", content: "武汉项目调试台备注", ts: 5000 });
    const own = search.run({ query: "武汉项目" }, { sessionKey: "debug:d1" });
    expect(own.hits).toHaveLength(1);
    expect(own.hits[0].sessionKey).toBe("debug:d1");
    const cron = search.run({ query: "武汉项目" }, { sessionKey: "cron:tick" });
    expect(cron.ok).toBe(false);
  });

  it("短查询走 LIKE 也能命中，且同样只在本会话域内", () => {
    const short = search.run({ query: "预算" }, { sessionKey: "feishu:group:oc_B" });   // 2 字 → LIKE
    expect(short.hits).toHaveLength(1);
    expect(short.hits[0].sessionKey).toBe("feishu:group:oc_B");
  });

  it("软删消息不出现在结果", () => {
    const gA = store.getOrCreate("feishu:group:oc_A");
    const m = store.append(gA.id, { role: "user", content: "武汉项目撤回的话", ts: 4000 });
    store.softDelete(m.id);
    const r = search.run({ query: "武汉项目" }, { sessionKey: "feishu:group:oc_A" });
    expect(r.hits.map((h) => h.content).join("")).not.toContain("撤回的话");
  });
});
