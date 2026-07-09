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
});
