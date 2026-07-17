import { describe, it, expect, vi } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createActorPool } from "../server/sessions/actor.mjs";
import { createReinjector } from "../server/jobs/reinjector.mjs";

describe("background reinjection availability", () => {
  it("releases the session actor before the slow reasoner turn finishes", async () => {
    const db = openDb();
    migrate(db);
    const store = createSessionStore(db);
    const actors = createActorPool();
    const sessionKey = "feishu:p2p:ou_available";
    store.getOrCreate(sessionKey, { kind: "p2p" });
    const gate = Promise.withResolvers();
    const brain = {
      turn: vi.fn(async () => {
        await gate.promise;
        return { finalText: "", events: [] };
      }),
    };
    const reinjector = createReinjector({
      store,
      actors,
      brain,

    });

    const reinjection = reinjector.onJobComplete({
      jobId: "job-availability",
      sessionKey,
      sessionVersion: 0,
      ok: true,
      result: "后台结果",
    });
    await vi.waitFor(() => expect(brain.turn).toHaveBeenCalledTimes(1));

    let foregroundRan = false;
    const foreground = actors.enqueue(sessionKey, async () => {
      foregroundRan = true;
      return "foreground";
    });
    await vi.waitFor(() => expect(foregroundRan).toBe(true), { timeout: 200 });
    await expect(foreground).resolves.toBe("foreground");

    gate.resolve();
    await reinjection;
  });
});
