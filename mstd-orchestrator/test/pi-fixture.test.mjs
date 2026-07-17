import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "pi-events.jsonl");

describe("pi-events fixture", () => {
  it("has one intentionally-malformed line and covers key event types", () => {
    const lines = readFileSync(FIXTURE, "utf8").split("\n").filter((l) => l.trim());
    let malformed = 0;
    const types = new Set();
    const amTypes = new Set();
    for (const l of lines) {
      let m;
      try { m = JSON.parse(l); } catch { malformed++; continue; }
      types.add(m.type);
      if (m.type === "message_update") amTypes.add(m.assistantMessageEvent.type);
    }
    expect(malformed).toBe(1);
    for (const t of ["agent_start", "message_start", "message_update", "tool_execution_start", "tool_execution_end", "agent_end", "some_future_event"]) {
      expect(types).toContain(t);
    }
    for (const t of ["text_delta", "thinking_delta", "toolcall_start"]) expect(amTypes).toContain(t);
  });
});
