import { describe, it, expect, vi } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { probeBotVisibility } from "../simulator/probe-bot-visibility.mjs";

function seedInbox(db, { eventId, rawContent, senderAppId = null, platformMessageId = null, verdict = null }) {
  db.prepare(
    `INSERT INTO inbox_events (event_id, chat_id, content_md5, raw_content, raw_sha256, ts, platform_message_id, sender_app_id, source)
     VALUES (?, 'oc_test', 'md5', ?, NULL, ?, ?, ?, 'feishu')`
  ).run(eventId, rawContent, Date.now(), platformMessageId, senderAppId);
  if (verdict) {
    db.prepare("UPDATE inbox_events SET verdict = ? WHERE event_id = ?")
      .run(JSON.stringify(verdict), eventId);
  }
}

describe("probeBotVisibility", () => {
  it("received + stable app_id makes native mode eligible", async () => {
    const db = openDb();
    migrate(db);
    // Migration 018 may not yet add columns in older trees; seed only if columns exist
    const cols = db.prepare("PRAGMA table_info(inbox_events)").all().map((c) => c.name);
    if (!cols.includes("sender_app_id")) {
      // Pre-migration probe: store app id in raw JSON-like content scan via synthetic helper path
    }
    const marker = "MSTD_SIM_PROBE_testuuid";
    let polled = 0;
    const deps = {
      db,
      chatId: "oc_test",
      timeoutMs: 5_000,
      pollMs: 1,
      now: () => 1_000 + polled,
      sleep: async () => { polled += 1; },
      runActorLark: vi.fn(async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ data: { message_id: "om_probe_1" } }),
        stderr: "",
      })),
      runXiaodaLark: vi.fn(async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ data: { items: [] } }),
        stderr: "",
      })),
      spawnConsumer: vi.fn(),
      markerOverride: marker,
      findInboxHit: () => {
        if (polled < 2) return null;
        return {
          eventId: "ev_probe",
          platformMessageId: "om_probe_1",
          senderAppId: "cli_sim_product",
          rawContent: marker,
          verdict: { ok: false, reason: "self_echo" },
        };
      },
    };
    const out = await probeBotVisibility(deps);
    expect(out).toMatchObject({
      deliveredToInbox: true,
      stableSenderAppId: "cli_sim_product",
      nativeEligible: true,
      messageId: "om_probe_1",
      eventId: "ev_probe",
    });
    expect(deps.spawnConsumer).not.toHaveBeenCalled();
  });

  it("received without stable app identity remains ineligible", async () => {
    const depsWithoutAppId = {
      db: openDb(),
      chatId: "oc_test",
      timeoutMs: 100,
      pollMs: 1,
      now: () => Date.now(),
      sleep: async () => {},
      runActorLark: vi.fn(async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ data: { message_id: "om_x" } }),
        stderr: "",
      })),
      runXiaodaLark: vi.fn(async () => ({ exitCode: 0, stdout: "{}", stderr: "" })),
      spawnConsumer: vi.fn(),
      markerOverride: "MSTD_SIM_PROBE_noapp",
      findInboxHit: () => ({
        eventId: "ev2",
        platformMessageId: "om_x",
        senderAppId: null,
        rawContent: "MSTD_SIM_PROBE_noapp",
        verdict: null,
      }),
    };
    const out = await probeBotVisibility(depsWithoutAppId);
    expect(out.nativeEligible).toBe(false);
    expect(out.deliveredToInbox).toBe(true);
    expect(out.reasons).toContain("sender_app_id_missing");
  });

  it("timeout reports event_not_delivered without starting a consumer", async () => {
    const spawnConsumer = vi.fn();
    let t = 0;
    const timeoutDeps = {
      db: openDb(),
      chatId: "oc_test",
      timeoutMs: 10,
      pollMs: 1,
      now: () => (t += 5),
      sleep: async () => {},
      runActorLark: vi.fn(async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ data: { message_id: "om_t" } }),
        stderr: "",
      })),
      runXiaodaLark: vi.fn(async () => ({ exitCode: 0, stdout: "{}", stderr: "" })),
      spawnConsumer,
      markerOverride: "MSTD_SIM_PROBE_timeout",
      findInboxHit: () => null,
    };
    const out = await probeBotVisibility(timeoutDeps);
    expect(out.reasons).toContain("event_not_delivered");
    expect(out.nativeEligible).toBe(false);
    expect(spawnConsumer).not.toHaveBeenCalled();
  });
});
