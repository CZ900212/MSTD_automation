import { describe, it, expect } from "vitest";
import { canonicalJson, stableHash, canonicalizeActions } from "../server/safety/action-dsl.mjs";
import { createEventBus } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";

const items = [
  { owner_name: "张三", task: "写周报", due: "2026-07-15", suggested_open_id: "ou_a", confidence: "high" },
  { owner_name: "小李", task: "订会议室", due: null, suggested_open_id: null, confidence: "low" },
];

describe("canonicalJson / stableHash", () => {
  it("orders keys deterministically", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });
  it("stableHash is deterministic and change-sensitive", () => {
    const h1 = stableHash({ a: 1, b: 2 });
    expect(h1).toBe(stableHash({ b: 2, a: 1 }));
    expect(h1).not.toBe(stableHash({ a: 1, b: 3 }));
  });
  it("throws on undefined (not valid JSON)", () => {
    expect(() => canonicalJson(undefined)).toThrow();
  });
});

describe("canonicalizeActions", () => {
  it("produces one create_task per item, no send_dm by default", () => {
    const actions = canonicalizeActions({ jobId: "job1", items });
    expect(actions).toHaveLength(2);
    expect(actions.every((a) => a.kind === "create_task")).toBe(true);
    expect(actions[0].payload).toEqual({
      title: "写周报", description: "", due_date: "2026-07-15", assignee_open_id: "ou_a",
    });
  });

  it("assigns ordinal reflecting canonical array order", () => {
    const actions = canonicalizeActions({ jobId: "job1", items });
    expect(actions[0].ordinal).toBe(0);
    expect(actions[1].ordinal).toBe(1);
  });

  it("sets target_open_id = assignee_open_id (F11)", () => {
    const actions = canonicalizeActions({ jobId: "job1", items });
    expect(actions[0].target_open_id).toBe("ou_a");
    expect(actions[1].target_open_id).toBe(null);
  });

  it("flags requires_open_id when assignee is null", () => {
    const actions = canonicalizeActions({ jobId: "job1", items });
    expect(actions[0].requires_open_id).toBe(false);
    expect(actions[1].requires_open_id).toBe(true);
  });

  it("low-confidence item requires_open_id even with a valid ou_ open_id", () => {
    const actions = canonicalizeActions({
      jobId: "job1",
      items: [{ task: "低置信度", due: null, suggested_open_id: "ou_valid", confidence: "low" }],
    });
    expect(actions[0].requires_open_id).toBe(true);
  });

  it("empty-string / non-ou_ open_id requires_open_id (high confidence)", () => {
    const [empty] = canonicalizeActions({
      jobId: "job1",
      items: [{ task: "空串", due: null, suggested_open_id: "", confidence: "high" }],
    });
    const [bad] = canonicalizeActions({
      jobId: "job1",
      items: [{ task: "非法", due: null, suggested_open_id: "abc123", confidence: "high" }],
    });
    expect(empty.requires_open_id).toBe(true);
    expect(bad.requires_open_id).toBe(true);
  });

  it("two identical items produce different action_keys (F4, ordinal-scoped)", () => {
    const dupItem = { task: "写周报", due: "2026-07-15", suggested_open_id: "ou_a", confidence: "high" };
    const actions = canonicalizeActions({ jobId: "job1", items: [dupItem, dupItem] });
    expect(actions).toHaveLength(2);
    expect(actions[0].action_key).not.toBe(actions[1].action_key);
  });

  it("same input -> same action_key/hash; edit -> different", () => {
    const a1 = canonicalizeActions({ jobId: "job1", items })[0];
    const a2 = canonicalizeActions({ jobId: "job1", items })[0];
    expect(a1.action_key).toBe(a2.action_key);
    const edited = canonicalizeActions({
      jobId: "job1",
      items: [{ ...items[0], task: "写月报" }],
    })[0];
    expect(edited.action_key).not.toBe(a1.action_key);
  });

  it("action_key is job-scoped", () => {
    const a = canonicalizeActions({ jobId: "jobA", items })[0];
    const b = canonicalizeActions({ jobId: "jobB", items })[0];
    expect(a.action_key).not.toBe(b.action_key);
  });

  it("appends send_dm only when enableNotify", () => {
    const actions = canonicalizeActions({ jobId: "job1", items, enableNotify: true });
    const dm = actions.find((a) => a.kind === "send_dm");
    expect(dm).toBeTruthy();
    expect(dm.target_open_id).toBe(actions.find((a) => a.kind === "create_task").payload.assignee_open_id);
  });
});

// ---- D1: agent 意图通用规范化（create_event / send_group_msg / create_task / send_dm）----
import { buildAgentAction } from "../server/safety/action-dsl.mjs";

describe("buildAgentAction（D1 扩类）", () => {
  it("create_event 正常规范化；attendee 排序保证同意图同 hash", () => {
    const a = buildAgentAction({
      jobId: "j1", kind: "create_event", ordinal: 0,
      payload: { summary: "评审会", start_time: "2026-07-10T14:00:00+08:00", end_time: "2026-07-10T15:00:00+08:00", attendee_open_ids: ["ou_b", "ou_a"] },
    });
    const b = buildAgentAction({
      jobId: "j1", kind: "create_event", ordinal: 0,
      payload: { summary: "评审会", start_time: "2026-07-10T14:00:00+08:00", end_time: "2026-07-10T15:00:00+08:00", attendee_open_ids: ["ou_a", "ou_b"] },
    });
    expect(a.payload_hash).toBe(b.payload_hash);
    expect(a.payload.attendee_open_ids).toEqual(["ou_a", "ou_b"]);
    // 改一字变 hash
    const c = buildAgentAction({ jobId: "j1", kind: "create_event", ordinal: 0, payload: { ...a.payload, summary: "评审会2" } });
    expect(c.payload_hash).not.toBe(a.payload_hash);
  });

  it("create_event 非法时间/open_id fail-closed", () => {
    expect(() => buildAgentAction({ jobId: "j", kind: "create_event", payload: { summary: "x", start_time: "明天", end_time: "2026-07-10T15:00:00Z", attendee_open_ids: [] } })).toThrow();
    expect(() => buildAgentAction({ jobId: "j", kind: "create_event", payload: { summary: "x", start_time: "2026-07-10T14:00:00Z", end_time: "2026-07-10T15:00:00Z", attendee_open_ids: ["not_ou"] } })).toThrow();
  });

  it("send_group_msg 校验 oc_ 前缀", () => {
    const a = buildAgentAction({ jobId: "j", kind: "send_group_msg", payload: { chat_id: "oc_123", card_ref: "j:c" } });
    expect(a.kind).toBe("send_group_msg");
    expect(() => buildAgentAction({ jobId: "j", kind: "send_group_msg", payload: { chat_id: "evil;rm", card_ref: "c" } })).toThrow();
  });

  it("create_task 缺 assignee → requires_open_id=true（卡片补选人）", () => {
    const a = buildAgentAction({ jobId: "j", kind: "create_task", payload: { title: "交周报", description: "", due_date: null, assignee_open_id: null } });
    expect(a.requires_open_id).toBe(true);
    const b = buildAgentAction({ jobId: "j", kind: "create_task", payload: { title: "交周报", description: "", due_date: null, assignee_open_id: "ou_x" } });
    expect(b.requires_open_id).toBe(false);
  });

  it("未知 kind 拒绝（类型封闭）", () => {
    expect(() => buildAgentAction({ jobId: "j", kind: "drop_table", payload: {} })).toThrow(/未知|unknown/);
  });
});

// ---- Task 4B: schedule_reminder（跨会话提醒进入四道锁确认写路径）----
describe("buildAgentAction schedule_reminder（Task 4B）", () => {
  const base = { deliver_to: "feishu:p2p:ou_target", due_iso: "2026-07-12T09:00:00+08:00", text: "交周报" };
  const build = (payload, ordinal = 0) =>
    buildAgentAction({ jobId: "j1", kind: "schedule_reminder", payload, ordinal });

  it("合法 p2p/group 规范化稳定；due 统一成 UTC toISOString", () => {
    const a = build(base);
    expect(a.payload).toEqual({
      deliver_to: "feishu:p2p:ou_target",
      due_iso: "2026-07-12T01:00:00.000Z",
      text: "交周报",
    });
    expect(a.requires_open_id).toBe(false);
    expect(a.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    const g = build({ ...base, deliver_to: "feishu:group:oc_room" });
    expect(g.payload.deliver_to).toBe("feishu:group:oc_room");
    // 带 topic 的四段 group 是合法 canonical（round-trip 成立），不得被收窄成仅三段
    const t = build({ ...base, deliver_to: "feishu:group:oc_room:omt_9" });
    expect(t.payload.deliver_to).toBe("feishu:group:oc_room:omt_9");
    expect(t.payload_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("等价 offset 时间统一到同一 UTC，同意图同 hash", () => {
    const a = build(base);
    const b = build({ ...base, due_iso: "2026-07-12T02:00:00+01:00" });
    const c = build({ ...base, due_iso: "2026-07-12T01:00:00Z" });
    expect(b.payload.due_iso).toBe(a.payload.due_iso);
    expect(b.payload_hash).toBe(a.payload_hash);
    expect(c.payload_hash).toBe(a.payload_hash);
  });

  it("改任一字段 hash 即变化", () => {
    const a = build(base);
    expect(build({ ...base, text: "交月报" }).payload_hash).not.toBe(a.payload_hash);
    expect(build({ ...base, due_iso: "2026-07-12T09:00:01+08:00" }).payload_hash).not.toBe(a.payload_hash);
    expect(build({ ...base, deliver_to: "feishu:p2p:ou_other" }).payload_hash).not.toBe(a.payload_hash);
  });

  it.each([
    ["cron 会话", "cron:job-1"],
    ["debug 会话", "debug:d1"],
    ["raw open_id", "ou_target"],
    ["raw chat_id", "oc_room"],
    ["缺 id", "feishu:p2p:"],
    ["group 缺 id", "feishu:group:"],
    ["p2p 多余段", "feishu:p2p:ou_x:extra"],
    ["group 多余段", "feishu:group:oc_x:topic:extra"],
    ["空串", ""],
    ["非字符串", 42],
  ])("deliver_to 拒绝 %s", (_label, deliverTo) => {
    expect(() => build({ ...base, deliver_to: deliverTo })).toThrow(/deliver_to/);
  });

  it.each([
    ["缺时区", "2026-07-12T09:00:00"],
    ["真实不存在日期", "2026-02-30T09:00:00Z"],
    ["非 ISO", "明天九点"],
    ["纯日期", "2026-07-12"],
    ["非字符串", 1234567890],
    ["offset 超限 +14:01", "2026-07-12T09:00:00+14:01"],
    ["offset 超限 -14:01", "2026-07-12T09:00:00-14:01"],
  ])("due_iso 拒绝 %s（不许 Date.parse 宽松归一化）", (_label, due) => {
    expect(() => build({ ...base, due_iso: due })).toThrow(/due_iso/);
  });

  it("offset 极限 +14:00 合法（LINT 时区），不得随上限校验一起被删", () => {
    const a = build({ ...base, due_iso: "2026-07-12T14:00:00+14:00" });
    expect(a.payload.due_iso).toBe("2026-07-12T00:00:00.000Z");
  });

  it("空文案 / 纯空白 / NUL / 超长文案拒绝", () => {
    expect(() => build({ ...base, text: "" })).toThrow(/text/);
    expect(() => build({ ...base, text: "   " })).toThrow(/text/);
    expect(() => build({ ...base, text: "a\u0000b" })).toThrow(/text/);
    expect(() => build({ ...base, text: "长".repeat(4001) })).toThrow(/text/);
    expect(build({ ...base, text: "长".repeat(4000) }).payload.text).toBe("长".repeat(4000));   // 恰 4000 接受
  });

  it("未知字段拒绝（payload 闭合）", () => {
    expect(() => build({ ...base, cron: "* * * * *" })).toThrow(/未知字段/);
    expect(() => build({ ...base, owner_session_key: "feishu:p2p:ou_evil" })).toThrow(/未知字段/);
  });
});

describe("propose_actions schema（TypeBox union 含 schedule_reminder）", () => {
  it("union 含 schedule_reminder，描述明确 {due_iso,text,deliver_to} 形状", async () => {
    const mod = await import("../pi-ext/propose-actions.ts");
    const tools = [];
    mod.default({ registerTool: (t) => tools.push(t), events: createEventBus() });
    const spec = tools.find((t) => t.name === "propose_actions");
    expect(spec).toBeTruthy();
    const s = JSON.stringify(spec.parameters);
    expect(s).toContain('"schedule_reminder"');
    expect(s).toMatch(/schedule_reminder:\{due_iso[^}]*text[^}]*deliver_to/);
    // kind union 的 const 集合必须精确闭合（防用宽松 Type.String 冒充 literal）
    const kindSchema = spec.parameters.properties.intents.items.properties.kind;
    const consts = (kindSchema.anyOf ?? []).map((x) => x.const).sort();
    expect(consts).toEqual(["create_event", "create_task", "schedule_reminder", "send_dm", "send_group_msg"]);
  });
});
