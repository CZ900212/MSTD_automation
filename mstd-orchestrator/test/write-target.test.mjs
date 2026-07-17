import { describe, it, expect } from "vitest";
import { assertTestTarget, testTargetFromEnv } from "../server/execute/write-target.mjs";

const allow = { allowOpenIds: new Set(["ou_test1", "ou_test2"]), allowTaskGuids: new Set(["guid-test"]) };

describe("assertTestTarget", () => {
  it("passes create_task to an allowed test open_id", () => {
    expect(() => assertTestTarget({ kind: "create_task", payload: { assignee_open_id: "ou_test1" } }, allow)).not.toThrow();
  });
  it("rejects create_task to a non-test open_id (fail-closed)", () => {
    expect(() => assertTestTarget({ kind: "create_task", payload: { assignee_open_id: "ou_prod" } }, allow)).toThrow(/非测试目标/);
  });
  it("complete_task 只认精确 MSTD_TEST_TASK_GUIDS", () => {
    expect(() => assertTestTarget({ kind: "complete_task", payload: { task_guid: "guid-test" } }, allow)).not.toThrow();
    expect(() => assertTestTarget({ kind: "complete_task", payload: { task_guid: "guid-prod" } }, allow)).toThrow(/MSTD_TEST_TASK_GUIDS/);
    const env = testTargetFromEnv({ MSTD_TEST_TASK_GUIDS: "guid-a, guid-b" });
    expect(env.allowTaskGuids).toEqual(new Set(["guid-a", "guid-b"]));
  });

  it("rejects send_dm to a non-test recipient", () => {
    expect(() => assertTestTarget({ kind: "send_dm", payload: { to_open_id: "ou_prod" } }, allow)).toThrow(/非测试目标/);
  });
  it("allows task notifications only for MSTD_TEST_OPEN_IDS recipients", () => {
    expect(() => assertTestTarget({ kind: "notify_task_assignee", payload: { to_open_id: "ou_test1" } }, allow)).not.toThrow();
    expect(() => assertTestTarget({ kind: "notify_task_assignee", payload: { to_open_id: "ou_prod" } }, allow)).toThrow(/非测试目标/);
    const chatOnly = { allowOpenIds: new Set(), allowChatIds: new Set(["ou_prod"]) };
    expect(() => assertTestTarget({ kind: "notify_task_assignee", payload: { to_open_id: "ou_prod" } }, chatOnly)).toThrow(/非测试目标/);
  });
});

// ---- D1/D4: 新 kind 的测试目标白名单 ----
describe("assertTestTarget 新 kind", () => {
  it("update_document 只允许精确文档 token 白名单", () => {
    const tt = testTargetFromEnv({ MSTD_TEST_DOC_TOKENS: "docxAllowed_123, docxOther_456" });
    expect(tt.allowDocTokens).toEqual(new Set(["docxAllowed_123", "docxOther_456"]));
    expect(() => assertTestTarget({ kind: "update_document", payload: { doc_token: "docxAllowed_123" } }, tt)).not.toThrow();
    expect(() => assertTestTarget({ kind: "update_document", payload: { doc_token: "docxProd_999" } }, tt)).toThrow(/MSTD_TEST_DOC_TOKENS/);
    expect(() => assertTestTarget({ kind: "update_document", payload: { doc_token: "docxAllowed_123" } }, {})).toThrow();
  });

  it("send_group_msg 只允许测试群；create_event 全员须在白名单", () => {
    const tt = { allowOpenIds: new Set(["ou_a"]), allowChatIds: new Set(["oc_test"]) };
    expect(() => assertTestTarget({ kind: "send_group_msg", payload: { chat_id: "oc_test" } }, tt)).not.toThrow();
    expect(() => assertTestTarget({ kind: "send_group_msg", payload: { chat_id: "oc_prod" } }, tt)).toThrow(/非测试群/);
    expect(() => assertTestTarget({ kind: "create_event", payload: { attendee_open_ids: ["ou_a"] } }, tt)).not.toThrow();
    expect(() => assertTestTarget({ kind: "create_event", payload: { attendee_open_ids: ["ou_a", "ou_prod"] } }, tt)).toThrow(/非测试参会人/);
    expect(() => assertTestTarget({ kind: "create_event", payload: { attendee_open_ids: [] } }, {})).toThrow();  // 未配置 fail-closed
  });
});

// ---- Task 4B: schedule_reminder 目标白名单 ----
describe("assertTestTarget schedule_reminder（Task 4B）", () => {
  const tt = { allowOpenIds: new Set(["ou_test"]), allowChatIds: new Set(["oc_test"]) };
  it("p2p 目标查 open_id 白名单，group 目标查 chat_id 白名单", () => {
    expect(() => assertTestTarget({ kind: "schedule_reminder", payload: { deliver_to: "feishu:p2p:ou_test" } }, tt)).not.toThrow();
    expect(() => assertTestTarget({ kind: "schedule_reminder", payload: { deliver_to: "feishu:group:oc_test" } }, tt)).not.toThrow();
  });
  it.each([
    ["生产 open_id", "feishu:p2p:ou_prod"],
    ["生产群", "feishu:group:oc_prod"],
    ["cron 会话", "cron:job-1"],
    ["debug 会话", "debug:d1"],
    ["raw open_id", "ou_test"],
    ["raw chat_id", "oc_test"],
    ["空串", ""],
  ])("fail-closed 拒绝 %s", (_label, deliverTo) => {
    expect(() => assertTestTarget({ kind: "schedule_reminder", payload: { deliver_to: deliverTo } }, tt)).toThrow();
  });
  it("白名单未配置一律拒绝", () => {
    expect(() => assertTestTarget({ kind: "schedule_reminder", payload: { deliver_to: "feishu:p2p:ou_test" } }, {})).toThrow();
    expect(() => assertTestTarget({ kind: "schedule_reminder", payload: { deliver_to: "feishu:group:oc_test" } }, {})).toThrow();
  });

  it("环境变量映射：p2p 查 MSTD_TEST_OPEN_IDS、group 查 MSTD_TEST_CHAT_IDS，不得交换", () => {
    const tt = testTargetFromEnv({ MSTD_TEST_OPEN_IDS: "ou_env1, ou_env2", MSTD_TEST_CHAT_IDS: "oc_env1" });
    expect(() => assertTestTarget({ kind: "schedule_reminder", payload: { deliver_to: "feishu:p2p:ou_env2" } }, tt)).not.toThrow();
    expect(() => assertTestTarget({ kind: "schedule_reminder", payload: { deliver_to: "feishu:group:oc_env1" } }, tt)).not.toThrow();
    // 交叉：open_id 出现在 chat 名单里 / chat_id 出现在 open 名单里都必须拒绝
    expect(() => assertTestTarget({ kind: "schedule_reminder", payload: { deliver_to: "feishu:p2p:oc_env1" } }, tt)).toThrow();
    expect(() => assertTestTarget({ kind: "schedule_reminder", payload: { deliver_to: "feishu:group:ou_env1" } }, tt)).toThrow();
  });
});
