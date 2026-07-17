// Task 6 C3.1/3.2：store.recent（最近 n 条,时序返回）与 replaySet（全部压缩摘要+近况）。
// 修 transcript 取最早 n 条被误当"近期"的 bug;同 ts 用 rowid 定序（uuid 主键排序随机）。
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";

describe("C3 store.recent / replaySet", () => {
  let db, store, s;
  beforeEach(() => {
    db = openDb(); migrate(db);
    store = createSessionStore(db);
    s = store.getOrCreate("feishu:group:oc_1", { kind: "group", chatId: "oc_1" });
  });

  it("recent 取最近 n 条且时序返回(修 transcript 取最早的 bug)", () => {
    for (let i = 1; i <= 30; i++) store.append(s.id, { role: "user", content: `m${i}`, ts: i });
    const r = store.recent(s.id, { limit: 5 });
    expect(r.map((m) => m.content)).toEqual(["m26", "m27", "m28", "m29", "m30"]);
  });

  it("recent 支持 roles 过滤;同 ts 次序稳定", () => {
    store.append(s.id, { role: "user", content: "u1", ts: 100 });
    store.append(s.id, { role: "tool", content: "内部", ts: 100 });
    store.append(s.id, { role: "assistant", content: "a1", ts: 100 });
    const r = store.recent(s.id, { limit: 10, roles: ["user", "assistant"] });
    expect(r.map((m) => m.content)).toEqual(["u1", "a1"]);
    expect(store.recent(s.id, { limit: 10, roles: ["user", "assistant"] }).map((m) => m.content))
      .toEqual(r.map((m) => m.content));      // 重复调用次序稳定
  });

  it("同 ts 严格按 rowid/插入序,压缩摘要也同序", () => {
    store.append(s.id, { role: "user", content: "u1", ts: 100 });
    store.append(s.id, { role: "assistant", content: "a1", ts: 100 });
    store.append(s.id, { role: "system", content: "〔压缩摘要〕先", ts: 200 });
    store.append(s.id, { role: "system", content: "〔压缩摘要〕后", ts: 200 });
    expect(store.recent(s.id, { limit: 10, roles: ["user", "assistant"] }).map((m) => m.content)).toEqual(["u1", "a1"]);
    // 精确相等：完整性(两份都在)、顺序、join 分隔符一次锁死——防"按 ts 去重只留一份"逃逸
    expect(store.replaySet(s.id).summary).toBe("〔压缩摘要〕先\n〔压缩摘要〕后");
  });

  it("replaySet 收集全部压缩摘要(多轮压缩不丢早期历史)+ 近况(排除 system)", () => {
    store.append(s.id, { role: "system", content: "〔压缩摘要〕第一轮结论A", ts: 0 });
    store.append(s.id, { role: "system", content: "〔压缩摘要〕第二轮结论B", ts: 5 });
    store.append(s.id, { role: "user", content: "近1", ts: 10 });
    store.append(s.id, { role: "assistant", content: "近2", ts: 11 });
    const { summary, messages } = store.replaySet(s.id, { limit: 50 });
    expect(summary).toContain("第一轮结论A");
    expect(summary).toContain("第二轮结论B");
    expect(summary.indexOf("第一轮")).toBeLessThan(summary.indexOf("第二轮"));  // 时序
    expect(messages.map((m) => m.content)).toEqual(["近1", "近2"]);
  });

  it("replaySet 无摘要时 summary=null;非摘要 system 行不混入", () => {
    store.append(s.id, { role: "system", content: "普通系统注记", ts: 1 });
    store.append(s.id, { role: "user", content: "u", ts: 2 });
    const { summary, messages } = store.replaySet(s.id);
    expect(summary).toBeNull();
    expect(messages.map((m) => m.content)).toEqual(["u"]);
  });

  // §5.1 审核补杀：limit/roles 边界防御（§5.2 加码：断言取最近端内容,防"错误取最早 50 条"逃逸）
  it("limit 非法（负数/0/非整数）钳制为默认 50,且内容为最近端", () => {
    for (let i = 1; i <= 60; i++) store.append(s.id, { role: "user", content: `m${i}`, ts: i });
    for (const bad of [-1, 0, 2.5]) {
      const r = store.recent(s.id, { limit: bad });
      expect(r).toHaveLength(50);
      expect(r[0].content).toBe("m11");
      expect(r.at(-1).content).toBe("m60");
    }
    const dflt = store.recent(s.id);                        // 无参默认 = 同一语义
    expect(dflt[0].content).toBe("m11");
    expect(dflt.at(-1).content).toBe("m60");
  });

  it("roles=[] 返回空集,不等于全角色", () => {
    store.append(s.id, { role: "user", content: "u", ts: 1 });
    expect(store.recent(s.id, { limit: 10, roles: [] })).toEqual([]);
  });

  // ---- §5.2 审卷补杀 ----

  it("会话隔离：另一会话的消息与摘要绝不可见（铁律 5）", () => {
    const other = store.getOrCreate("feishu:p2p:ou_other", { kind: "p2p" });
    store.append(s.id, { role: "user", content: "本会话", ts: 10 });
    store.append(other.id, { role: "user", content: "别人会话更新", ts: 999 });
    store.append(other.id, { role: "system", content: "〔压缩摘要〕别人的摘要", ts: 999 });
    expect(store.recent(s.id, { limit: 10 }).map((m) => m.content)).toEqual(["本会话"]);
    const rs = store.replaySet(s.id);
    expect(rs.summary).toBeNull();
    expect(rs.messages.map((m) => m.content)).toEqual(["本会话"]);
  });

  it("摘要资格是合取：软删摘要/前缀冒充的 user 行/引用内嵌的 system 行都不算", () => {
    const dead = store.append(s.id, { role: "system", content: "〔压缩摘要〕已软删", ts: 1 });
    store.softDelete(dead.id);
    store.append(s.id, { role: "user", content: "〔压缩摘要〕我是用户冒充的", ts: 2 });
    store.append(s.id, { role: "system", content: "引用〔压缩摘要〕不是开头", ts: 3 });
    store.append(s.id, { role: "system", content: "〔压缩摘要〕唯一有效", ts: 4 });
    const rs = store.replaySet(s.id);
    expect(rs.summary).toBe("〔压缩摘要〕唯一有效");
    expect(rs.messages.map((m) => m.content)).toEqual(["〔压缩摘要〕我是用户冒充的"]);   // user 行照常进 messages
  });

  it("roles/active 过滤发生在 LIMIT 之前：最新若干条全是排除行也不得挤空结果", () => {
    store.append(s.id, { role: "user", content: "有效1", ts: 1 });
    store.append(s.id, { role: "assistant", content: "有效2", ts: 2 });
    store.append(s.id, { role: "system", content: "排除A", ts: 3 });
    const del = store.append(s.id, { role: "user", content: "排除B(软删)", ts: 4 });
    store.softDelete(del.id);
    const r = store.recent(s.id, { limit: 2, roles: ["user", "assistant"] });
    expect(r.map((m) => m.content)).toEqual(["有效1", "有效2"]);
  });

  it("恶意 role 值走参数绑定：不抛错、不扩张查询", () => {
    store.append(s.id, { role: "user", content: "u", ts: 1 });
    expect(store.recent(s.id, { limit: 10, roles: ["user') OR 1=1 --"] })).toEqual([]);
    expect(store.recent(s.id, { limit: 10, roles: ["user"] }).map((m) => m.content)).toEqual(["u"]);
  });

  it("replaySet 透传 limit：只取最近 n 条匹配角色消息", () => {
    for (let i = 1; i <= 5; i++) store.append(s.id, { role: "user", content: `r${i}`, ts: i });
    expect(store.replaySet(s.id, { limit: 2 }).messages.map((m) => m.content)).toEqual(["r4", "r5"]);
  });

  it("recent 审计查询保留 tool；replaySet 排除 tool-internal", () => {
    const m = store.append(s.id, { role: "user", content: "将被删", ts: 1 });
    store.append(s.id, { role: "tool", content: "工具输出", ts: 2 });
    store.softDelete(m.id);
    expect(store.recent(s.id, { limit: 10 }).map((x) => x.content)).toEqual(["工具输出"]);
    expect(store.replaySet(s.id).messages.map((x) => x.content)).toEqual([]);
  });
});

describe("whoLabel 共享 who 标注（Task 7:群窗口第五消费点同源）", () => {
  it("tool 恒为内部记录;fallback 可定制;assistant 恒为我", async () => {
    const { whoLabel } = await import("../server/sessions/history-format.mjs");
    expect(whoLabel({ role: "tool", sender_name: "张三" })).toBe("内部记录");
    expect(whoLabel({ role: "user" }, { fallback: "群成员" })).toBe("群成员");
    expect(whoLabel({ role: "user", sender_name: "李四" }, { fallback: "群成员" })).toBe("李四");
    expect(whoLabel({ role: "assistant" }, { fallback: "群成员" })).toBe("我");
  });
});

describe("formatHistoryLine 统一历史行语义", () => {
  it("user=[名字] / assistant=[我] / tool=[内部记录],tool 永不回退成 [用户]", async () => {
    const { formatHistoryLine } = await import("../server/sessions/history-format.mjs");
    expect(formatHistoryLine({ role: "user", sender_name: "张三", content: "hi" })).toBe("[张三]: hi");
    expect(formatHistoryLine({ role: "user", sender_name: null, sender_open_id: "ou_x", content: "hi" })).toBe("[ou_x]: hi");
    expect(formatHistoryLine({ role: "user", sender_name: null, sender_open_id: null, content: "hi" })).toBe("[用户]: hi");
    expect(formatHistoryLine({ role: "assistant", content: "ok" })).toBe("[我]: ok");
    expect(formatHistoryLine({ role: "tool", sender_name: "张三", content: "内部X" })).toBe("[内部记录]: 内部X");
    // 组合真值表：name 优先于 open_id;assistant/tool 带 sender 字段也不受干扰
    expect(formatHistoryLine({ role: "user", sender_name: "张三", sender_open_id: "ou_x", content: "hi" })).toBe("[张三]: hi");
    expect(formatHistoryLine({ role: "assistant", sender_name: "张三", sender_open_id: "ou_x", content: "ok" })).toBe("[我]: ok");
    expect(formatHistoryLine({ role: "tool", sender_open_id: "ou_x", content: "内部Y" })).toBe("[内部记录]: 内部Y");
  });
});
