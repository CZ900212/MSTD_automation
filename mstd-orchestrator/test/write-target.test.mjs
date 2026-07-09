import { describe, it, expect } from "vitest";
import { assertTestTarget } from "../server/execute/write-target.mjs";

const allow = { allowOpenIds: new Set(["ou_test1", "ou_test2"]), allowTasklist: "tl_test" };

describe("assertTestTarget", () => {
  it("passes create_task to an allowed test open_id", () => {
    expect(() => assertTestTarget({ kind: "create_task", payload: { assignee_open_id: "ou_test1" } }, allow)).not.toThrow();
  });
  it("rejects create_task to a non-test open_id (fail-closed)", () => {
    expect(() => assertTestTarget({ kind: "create_task", payload: { assignee_open_id: "ou_prod" } }, allow)).toThrow(/非测试目标/);
  });
  it("rejects send_dm to a non-test recipient", () => {
    expect(() => assertTestTarget({ kind: "send_dm", payload: { to_open_id: "ou_prod" } }, allow)).toThrow(/非测试目标/);
  });
});

// ---- D1/D4: 新 kind 的测试目标白名单 ----
describe("assertTestTarget 新 kind", () => {
  it("send_group_msg 只允许测试群；create_event 全员须在白名单", () => {
    const tt = { allowOpenIds: new Set(["ou_a"]), allowChatIds: new Set(["oc_test"]) };
    expect(() => assertTestTarget({ kind: "send_group_msg", payload: { chat_id: "oc_test" } }, tt)).not.toThrow();
    expect(() => assertTestTarget({ kind: "send_group_msg", payload: { chat_id: "oc_prod" } }, tt)).toThrow(/非测试群/);
    expect(() => assertTestTarget({ kind: "create_event", payload: { attendee_open_ids: ["ou_a"] } }, tt)).not.toThrow();
    expect(() => assertTestTarget({ kind: "create_event", payload: { attendee_open_ids: ["ou_a", "ou_prod"] } }, tt)).toThrow(/非测试参会人/);
    expect(() => assertTestTarget({ kind: "create_event", payload: { attendee_open_ids: [] } }, {})).toThrow();  // 未配置 fail-closed
  });
});
