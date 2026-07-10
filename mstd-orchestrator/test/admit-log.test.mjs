import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { openDb, migrate } from "../server/db/index.mjs";
import { wireGateway } from "../server/gateway/wire.mjs";

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = vi.fn();
  return c;
}

const flat = (over = {}) => JSON.stringify({
  type: "im.message.receive_v1", event_id: over.eventId ?? "ve1",
  chat_id: "oc_1", chat_type: over.chatType ?? "group", message_type: "text",
  sender_id: over.sender ?? "ou_a", content: over.text ?? "闲聊", create_time: "1000",
  mentions: over.mentions ?? [],
}) + "\n";

describe("admit 判定落库（可观测）", () => {
  it("各 reason/mode 落到 inbox_events.verdict", async () => {
    vi.useFakeTimers();
    const db = openDb();
    migrate(db);
    const children = [];
    const wired = wireGateway({
      db,
      config: { botOpenId: "ou_bot", larkCliPath: "/fake" },
      spawnFn: vi.fn(() => { const c = fakeChild(); children.push(c); return c; }),
      handleTurn: () => {},
      actors: { enqueue: vi.fn((_, callback) => callback()) },
    });
    // 群未@ → bot_not_mentioned_observe
    children[0].stdout.emit("data", Buffer.from(flat({ eventId: "v-observe" })));
    // 群@ → addressed
    children[0].stdout.emit("data", Buffer.from(flat({ eventId: "v-addr", mentions: ["ou_bot"], text: "@bot 在吗" })));
    // p2p → addressed
    children[0].stdout.emit("data", Buffer.from(flat({ eventId: "v-p2p", chatType: "p2p", text: "私聊" })));
    await vi.advanceTimersByTimeAsync(4000);

    const verdicts = Object.fromEntries(
      db.prepare("SELECT event_id, verdict FROM inbox_events").all().map((r) => [r.event_id, JSON.parse(r.verdict ?? "null")])
    );
    expect(verdicts["v-observe"]).toMatchObject({ ok: false, reason: "bot_not_mentioned_observe" });
    expect(verdicts["v-addr"]).toMatchObject({ ok: true, mode: "addressed" });
    expect(verdicts["v-p2p"]).toMatchObject({ ok: true, mode: "addressed" });
    wired.consumer.stop();
    vi.useRealTimers();
  });
});
