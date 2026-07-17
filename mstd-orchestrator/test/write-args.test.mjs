import { describe, it, expect } from "vitest";
import { buildWriteArgs } from "../server/safety/write-args.mjs";

const createTask = {
  kind: "create_task",
  payload: { title: "写周报", description: "", due_date: "2026-07-15", assignee_open_id: "ou_a" },
};

describe("buildWriteArgs", () => {
  it("create_task uses explicit flags + idempotency-key", () => {
    const argv = buildWriteArgs(createTask, "job1:k1");
    expect(argv).toEqual([
      "task", "+create", "--as", "user",
      "--summary", "写周报",
      "--description", "",
      "--due", "2026-07-15",
      "--assignee", "ou_a",
      "--idempotency-key", "job1:k1",
    ]);
  });

  it("omits --due when due_date is null", () => {
    const noDue = { kind: "create_task", payload: { title: "t", description: "", due_date: null, assignee_open_id: "ou_a" } };
    expect(buildWriteArgs(noDue, "k").includes("--due")).toBe(false);
  });

  it("always carries the idempotency key", () => {
    expect(buildWriteArgs(createTask, "job1:k1")).toContain("--idempotency-key");
    expect(buildWriteArgs(createTask, "job1:k1")).toContain("job1:k1");
  });

  it("complete_task 使用精确 GUID 且不附加幂等参数", () => {
    expect(buildWriteArgs({ kind: "complete_task", payload: { task_guid: "guid-1" } }, "ignored")).toEqual([
      "task", "+complete", "--as", "user", "--task-id", "guid-1",
    ]);
    expect(() => buildWriteArgs({ kind: "complete_task", payload: { task_guid: "bad\nvalue" } }, "ignored")).toThrow(/task_guid/);
  });

  it("throws on unknown kind", () => {
    expect(() => buildWriteArgs({ kind: "drop_db", payload: {} }, "k")).toThrow(/unknown/i);
  });

  it("create_task throws (fail-closed) when assignee_open_id is null", () => {
    const bad = { kind: "create_task", payload: { title: "t", description: "", due_date: null, assignee_open_id: null } };
    expect(() => buildWriteArgs(bad, "k")).toThrow(/assignee_open_id/i);
  });

  it("create_task throws (fail-closed) when assignee_open_id is empty string", () => {
    const bad = { kind: "create_task", payload: { title: "t", description: "", due_date: null, assignee_open_id: "" } };
    expect(() => buildWriteArgs(bad, "k")).toThrow(/assignee_open_id/i);
  });

  it("create_task throws (fail-closed) when assignee_open_id lacks ou_ prefix", () => {
    const bad = { kind: "create_task", payload: { title: "t", description: "", due_date: null, assignee_open_id: "xyz" } };
    expect(() => buildWriteArgs(bad, "k")).toThrow(/assignee_open_id/i);
  });

  it("send_dm throws (fail-closed) when to_open_id is null", () => {
    const bad = { kind: "send_dm", payload: { card_ref: "c1", to_open_id: null } };
    expect(() => buildWriteArgs(bad, "k")).toThrow(/to_open_id/i);
  });

  it("send_dm builds expected argv for a valid ou_ open id", () => {
    const dm = { kind: "send_dm", payload: { card_ref: "c1", to_open_id: "ou_a" } };
    expect(buildWriteArgs(dm, "job1:k1")).toEqual([
      "im", "+messages-send", "--as", "bot",
      "--user-id", "ou_a",
      "--msg-type", "interactive",
      "--content", JSON.stringify({ ref: "c1" }),
      "--idempotency-key", "job1:k1",
    ]);
  });

  it("notify_task_assignee sends a fixed task card with its own idempotency key", () => {
    const action = {
      kind: "notify_task_assignee",
      payload: {
        source_task_action_key: "task-key", to_open_id: "ou_a", title: "完成询价",
        description: "", due_date: "2026-07-15", template_version: 1,
      },
    };
    const argv = buildWriteArgs(action, "notice-key");
    expect(argv.slice(0, 8)).toEqual(["im", "+messages-send", "--as", "bot", "--user-id", "ou_a", "--msg-type", "interactive"]);
    const content = JSON.parse(argv[argv.indexOf("--content") + 1]);
    expect(content.header.title.content).toBe("任务通知");
    expect(JSON.stringify(content)).toContain("完成询价");
    expect(argv).toContain("notice-key");
  });
});

// ---- D1: create_event / send_group_msg argv 构造 ----
describe("buildWriteArgs D1 扩类", () => {
  it("create_event argv 白名单", () => {
    const argv = buildWriteArgs({
      kind: "create_event",
      payload: { summary: "评审会", start_time: "2026-07-10T14:00:00+08:00", end_time: "2026-07-10T15:00:00+08:00", attendee_open_ids: ["ou_a", "ou_b"] },
    }, "job1:e1");
    expect(argv).toEqual([
      "calendar", "+create", "--as", "user",
      "--summary", "评审会",
      "--start", "2026-07-10T14:00:00+08:00", "--end", "2026-07-10T15:00:00+08:00",
      "--attendee-ids", "ou_a,ou_b", "--json",
    ]);
  });
  it("create_event 非法时间 fail-closed", () => {
    expect(() => buildWriteArgs({ kind: "create_event", payload: { summary: "x", start_time: "后天", end_time: "2026-07-10T15:00:00Z", attendee_open_ids: [] } }, "k")).toThrow();
  });
  it("create_event 拒绝无时区/纯日期时间串（会随执行环境时区漂移）", () => {
    expect(() => buildWriteArgs({ kind: "create_event", payload: { summary: "x", start_time: "2026-07-10T14:00:00", end_time: "2026-07-10T15:00:00Z", attendee_open_ids: [] } }, "k")).toThrow();
    expect(() => buildWriteArgs({ kind: "create_event", payload: { summary: "x", start_time: "2026-07-10T14:00:00Z", end_time: "2026-07-10", attendee_open_ids: [] } }, "k")).toThrow();
  });
  it("send_group_msg argv 白名单（含幂等 key）", () => {
    const argv = buildWriteArgs({ kind: "send_group_msg", payload: { chat_id: "oc_9", card_ref: "j:c" } }, "job1:g1");
    expect(argv).toEqual([
      "im", "+messages-send", "--as", "bot", "--chat-id", "oc_9",
      "--msg-type", "interactive", "--content", JSON.stringify({ ref: "j:c" }),
      "--idempotency-key", "job1:g1",
    ]);
  });
  it("send_group_msg 非法 chat_id fail-closed", () => {
    expect(() => buildWriteArgs({ kind: "send_group_msg", payload: { chat_id: "ou_x", card_ref: "c" } }, "k")).toThrow();
  });

  it("update_document 构造带 revision 的受控 str_replace argv", () => {
    const argv = buildWriteArgs({ kind: "update_document", payload: {
      doc_token: "docxToken_123", command: "str_replace", content: "新版本", revision_id: 7,
      pattern: "旧版本", block_id: null, doc_format: "markdown",
    } }, "ignored");
    expect(argv).toEqual([
      "docs", "+update", "--as", "user", "--doc", "docxToken_123", "--command", "str_replace",
      "--doc-format", "markdown", "--revision-id", "7", "--pattern", "旧版本", "--content", "新版本", "--json",
    ]);
    expect(argv).not.toContain("--yes");
  });

  it("update_document 拒绝破坏性命令和非法 token", () => {
    const base = { doc_token: "docxToken_123", content: "x", revision_id: 1, doc_format: "markdown" };
    expect(() => buildWriteArgs({ kind: "update_document", payload: { ...base, command: "overwrite" } }, "k")).toThrow(/不支持/);
    expect(() => buildWriteArgs({ kind: "update_document", payload: { ...base, command: "append", doc_token: "https:\/\/evil" } }, "k")).toThrow(/doc_token/);
  });
});
