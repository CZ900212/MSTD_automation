import { describe, it, expect } from "vitest";
import { createRuntimeRegistry } from "../server/jobs/runtime.mjs";

describe("runtime registry", () => {
  it("registers, gets, removes handles", () => {
    const reg = createRuntimeRegistry();
    const handle = { client: {}, abort: () => {} };
    reg.register("job1", handle);
    expect(reg.has("job1")).toBe(true);
    expect(reg.get("job1")).toBe(handle);
    reg.remove("job1");
    expect(reg.has("job1")).toBe(false);
    expect(reg.get("job1")).toBeNull();
  });
});
