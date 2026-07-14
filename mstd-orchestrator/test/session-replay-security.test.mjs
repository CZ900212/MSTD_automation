import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createCompactor } from "../server/memory/compact.mjs";
import { createMemoryFiles } from "../server/memory/files.mjs";
import { createDreaming } from "../server/ticker/dreaming.mjs";
import { createTriage } from "../server/models/triage.mjs";
import { createBrain } from "../server/models/brain.mjs";
import { createReplyPipeline } from "../server/gateway/reply-pipeline.mjs";
import { createTurnHandler } from "../server/gateway/turn-handler.mjs";

describe("model-input eligibility", () => {
  it("model-input consumers fail fast without the safe store interfaces", () => {
    const unsafeStore = { recent: () => [], transcript: () => [] };
    expect(() => createTriage({ caller: {}, store: unsafeStore })).toThrow(/promptRecent/);
    expect(() => createReplyPipeline({ store: unsafeStore })).toThrow(/promptRecent/);
    expect(() => createTurnHandler({ store: unsafeStore })).toThrow(/promptRecent/);
    expect(() => createCompactor({ caller: {}, store: unsafeStore })).toThrow(/memoryTranscript/);
    expect(() => createBrain({ startPi: () => ({}), store: unsafeStore })).toThrow(/replaySet/);
  });

  it("keeps ordinary history compatible while excluding non-replay and tool-internal rows", () => {
    const db = openDb(); migrate(db);
    const store = createSessionStore(db);
    const session = store.getOrCreate("feishu:p2p:ou_safe", { kind: "p2p" });
    store.append(session.id, { role: "user", content: "普通需求", ts: 1 });
    store.append(session.id, { role: "assistant", content: "普通答复", ts: 2 });
    store.append(session.id, {
      role: "tool", content: "MSTD_TURN_CONTEXT_V1 hidden finalText", ts: 3,
      policy: { replayable: false, promptEligible: false, memoryEligible: false, securityLabel: "internal", provenance: "tool_internal" },
    });
    store.append(session.id, {
      role: "user", content: "attack payload", ts: 4,
      policy: { replayable: false, promptEligible: false, memoryEligible: false, securityLabel: "quarantined", provenance: "security_tombstone" },
    });

    const replay = JSON.stringify(store.replaySet(session.id));
    const prompt = JSON.stringify(store.promptRecent(session.id));
    const memory = JSON.stringify(store.memoryTranscript(session.id));
    for (const surface of [replay, prompt, memory]) {
      expect(surface).toContain("普通需求");
      expect(surface).toContain("普通答复");
      expect(surface).not.toContain("MSTD_TURN_CONTEXT_V1");
      expect(surface).not.toContain("attack payload");
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_messages_fts WHERE content LIKE '%MSTD_TURN_CONTEXT_V1%'").get().n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_messages_fts WHERE content LIKE '%attack payload%'").get().n).toBe(0);
  });

  it("compaction sends zero ineligible bytes to reason", async () => {
    const db = openDb(); migrate(db);
    const store = createSessionStore(db);
    const session = store.getOrCreate("feishu:p2p:ou_compact_safe", { kind: "p2p" });
    for (let i = 0; i < 25; i++) store.append(session.id, { role: "user", content: `safe-${i}`, ts: i + 1 });
    store.append(session.id, {
      role: "tool", content: "INTERNAL_SECRET_BYTES", ts: 0,
      policy: { replayable: false, promptEligible: false, memoryEligible: false, provenance: "tool_internal", securityLabel: "internal" },
    });
    const call = vi.fn(async () => ({ text: "safe summary", usage: null }));
    const compactor = createCompactor({ caller: { call }, store, thresholdTokens: 1, keepRecent: 20 });
    await compactor.maybeCompact({
      session, sessionKey: session.session_key,
      brain: { turn: vi.fn(async () => ({ finalText: "", events: [] })) },
    });
    expect(call).toHaveBeenCalled();
    expect(call.mock.calls[0][1].messages[0].content).not.toContain("INTERNAL_SECRET_BYTES");
  });

  it("dreaming sends zero memory-ineligible bytes to its models", async () => {
    const db = openDb(); migrate(db);
    const store = createSessionStore(db);
    const now = Date.UTC(2026, 6, 14, 12);
    const session = store.getOrCreate("feishu:p2p:ou_dream_safe", { kind: "p2p" });
    store.append(session.id, { role: "user", content: "eligible fact", ts: now - 1000 });
    store.append(session.id, {
      role: "user", content: "DREAMING_ATTACK_BYTES", ts: now - 500,
      policy: { replayable: false, promptEligible: false, memoryEligible: false, securityLabel: "quarantined", provenance: "security_tombstone" },
    });
    const caller = { call: vi.fn(async () => ({ text: "[]", usage: null })) };
    const files = createMemoryFiles({ rootDir: mkdtempSync(join(tmpdir(), "mstd-security-dream-")) });
    const dreaming = createDreaming({ db, files, caller, mode: "shadow", isTest: true, now: () => now });

    await dreaming.run(now);
    expect(caller.call).toHaveBeenCalled();
    for (const [, input] of caller.call.mock.calls) {
      expect(JSON.stringify(input)).toContain("eligible fact");
      expect(JSON.stringify(input)).not.toContain("DREAMING_ATTACK_BYTES");
    }
  });
});
