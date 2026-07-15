// Task 8 C1：常驻 brain 扩展清单唯一来源——index 与 E2E 都消费它,不得各自手写。
import { describe, it, expect } from "vitest";
import { buildCapabilityProfile, buildResidentExtensions } from "../server/pi/resident-extensions.mjs";

describe("buildResidentExtensions(production source of truth)", () => {
  it("精确顺序:turn-context 先捕获 daemon 身份,persona 紧随;heartbeat/lark-read 在列;无 job-only 扩展(draft)", () => {
    const list = buildResidentExtensions("/r");
    expect(list).toEqual([
      "/r/pi-ext/turn-context.ts",
      "/r/pi-ext/persona.ts",
      "/r/pi-ext/providers.ts",
      "/r/pi-ext/reply.ts",
      "/r/pi-ext/memory.ts",
      "/r/pi-ext/session-search.ts",
      "/r/pi-ext/propose-actions.ts",
      "/r/pi-ext/background-job.ts",
      "/r/pi-ext/heartbeat.ts",
      "/r/pi-ext/lark-read.ts",
    ]);
  });

  it("binds each production role to its exact extension tool allowlist", () => {
    expect(buildCapabilityProfile("/r", "resident")).toMatchObject({
      role: "resident",
      tools: ["reply", "memory", "session_search", "propose_actions", "spawn_background_job", "heartbeat_update", "lark_read"],
    });
    expect(buildCapabilityProfile("/r", "readonly_job")).toMatchObject({
      role: "readonly_job",
      tools: ["lark_read", "draft_zh"],
    });
    expect(buildCapabilityProfile("/r", "background")).toMatchObject({
      role: "background",
      tools: ["lark_read"],
    });
  });
});
