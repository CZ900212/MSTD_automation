import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createGatewayConsumer } from "../server/gateway/consumer.mjs";
import { openDb, migrate } from "../server/db/index.mjs";
import { wireGateway } from "../server/gateway/wire.mjs";

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = vi.fn();
  return c;
}

describe("gateway consumer", () => {
  it("NDJSON 逐行回调；坏行显式上报；退出后重启", () => {
    vi.useFakeTimers();
    const children = [];
    const spawnFn = vi.fn(() => { const c = fakeChild(); children.push(c); return c; });
    const events = [];
    const consumer = createGatewayConsumer({
      spawnFn, larkCliPath: "/fake/lark-cli",
      events: ["im.message.receive_v1", "card.action.trigger"],
      onEvent: (e) => events.push(e), restartDelayMs: 5000,
    });
    consumer.start();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    children[0].stdout.emit("data", Buffer.from('{"header":{"event_id":"e1"}}\n不是json\n'));
    expect(events[0]).toEqual({ header: { event_id: "e1" } });
    expect(events[1]).toHaveProperty("__parse_error");
    children[0].emit("exit", 1);
    vi.advanceTimersByTime(5000);
    expect(spawnFn).toHaveBeenCalledTimes(2);
    consumer.stop();
    vi.useRealTimers();
  });
});

describe("wireGateway 管道装配", () => {
  const rawMsg = (over = {}) => ({
    header: { event_id: over.eventId ?? "we1", event_type: "im.message.receive_v1" },
    event: {
      sender: { sender_id: { open_id: over.sender ?? "ou_a" } },
      message: {
        chat_id: over.chatId ?? "oc_1", chat_type: over.chatType ?? "p2p", message_type: "text",
        content: JSON.stringify({ text: over.text ?? "你好" }),
        mentions: over.mentions ?? [],
        create_time: "1720000000000",
      },
    },
  });

  function setup({ handleTurn }) {
    vi.useFakeTimers();
    const db = openDb();
    migrate(db);
    const children = [];
    const spawnFn = vi.fn(() => { const c = fakeChild(); children.push(c); return c; });
    const wired = wireGateway({
      db,
      config: { botOpenId: "ou_bot", larkCliPath: "/fake/lark-cli" },
      spawnFn,
      handleTurn,
    });
    return { db, children, wired };
  }

  it("私聊消息走 去重→admit→合批→actor→handleTurn 全链", async () => {
    const turns = [];
    const { children, wired } = setup({ handleTurn: (t) => { turns.push(t); } });
    children[0].stdout.emit("data", Buffer.from(JSON.stringify(rawMsg()) + "\n"));
    children[0].stdout.emit("data", Buffer.from(JSON.stringify(rawMsg()) + "\n")); // 同 event_id 去重
    await vi.advanceTimersByTimeAsync(3000);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ kind: "message", sessionKey: "feishu:p2p:ou_a", mode: "addressed" });
    expect(turns[0].items).toHaveLength(1);
    wired.consumer.stop();
    vi.useRealTimers();
  });

  it("群聊未@ 落 observed 不唤醒", async () => {
    const turns = [];
    const { db, children, wired } = setup({ handleTurn: (t) => { turns.push(t); } });
    children[0].stdout.emit("data", Buffer.from(JSON.stringify(rawMsg({ chatType: "group", text: "闲聊" })) + "\n"));
    await vi.advanceTimersByTimeAsync(4000);
    expect(turns).toHaveLength(0);
    const observed = db.prepare("SELECT * FROM agent_messages WHERE observed = 1").all();
    expect(observed).toHaveLength(1);
    expect(observed[0].content).toBe("闲聊");
    wired.consumer.stop();
    vi.useRealTimers();
  });
});
