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
