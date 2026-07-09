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
});
