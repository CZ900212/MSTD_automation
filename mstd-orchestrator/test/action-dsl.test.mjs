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

  it("flags requires_open_id when assignee is null", () => {
    const actions = canonicalizeActions({ jobId: "job1", items });
    expect(actions[0].requires_open_id).toBe(false);
    expect(actions[1].requires_open_id).toBe(true);
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
    expect(actions.some((a) => a.kind === "send_dm")).toBe(true);
  });
});
