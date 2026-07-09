import { describe, it, expect } from "vitest";
import { canonicalJson, stableHash, canonicalizeActions } from "../server/safety/action-dsl.mjs";

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
