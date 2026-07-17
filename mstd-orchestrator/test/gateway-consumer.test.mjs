import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createGatewayConsumer } from "../server/gateway/consumer.mjs";
import { openDb, migrate } from "../server/db/index.mjs";
import { wireGateway } from "../server/gateway/wire.mjs";
import { createActorPool } from "../server/sessions/actor.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createSessionExpiry } from "../server/ticker/session-expiry.mjs";
import { loadServerConfig } from "../server/config.mjs";

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = vi.fn();
  return c;
}

describe("gateway consumer", () => {
  it("每个事件一个子进程（lark-cli 一次只接受一个 EventKey）；NDJSON 逐行回调；坏行显式上报；退出后重启", () => {
    vi.useFakeTimers();
    const children = [];
    const spawnFn = vi.fn((_bin, args) => { const c = fakeChild(); c.args = args; children.push(c); return c; });
    const events = [];
    const consumer = createGatewayConsumer({
      spawnFn, larkCliPath: "/fake/lark-cli",
      events: ["im.message.receive_v1", "card.action.trigger"],
      onEvent: (e) => events.push(e), restartDelayMs: 5000,
    });
    consumer.start();
    expect(spawnFn).toHaveBeenCalledTimes(2);                       // 每事件一进程
    expect(children[0].args).toContain("im.message.receive_v1");
    expect(children[0].args).not.toContain("card.action.trigger");  // 不混装
    expect(children[1].args).toContain("card.action.trigger");
    children[0].stdout.emit("data", Buffer.from('{"header":{"event_id":"e1"}}\n不是json\n'));
    expect(events[0]).toEqual({ header: { event_id: "e1" } });
    expect(events[1]).toHaveProperty("__parse_error");
    children[0].emit("exit", 1);
    vi.advanceTimersByTime(5000);
    expect(spawnFn).toHaveBeenCalledTimes(3);                       // 只重启挂掉的那个
    consumer.stop();
    vi.useRealTimers();
  });

  it("spawn 失败只发 error 不发 exit（ENOENT/EMFILE 真机行为）也必须重启；error+exit 双触发只重启一次", () => {
    vi.useFakeTimers();
    const children = [];
    const spawnFn = vi.fn(() => { const c = fakeChild(); children.push(c); return c; });
    const consumer = createGatewayConsumer({
      spawnFn, larkCliPath: "/fake/lark-cli",
      events: ["im.message.receive_v1"],
      onEvent: vi.fn(), restartDelayMs: 5000, log: vi.fn(),
    });
    consumer.start();
    expect(spawnFn).toHaveBeenCalledTimes(1);

    // 场景 1：只发 error（spawn ENOENT），无 exit —— 修复前该消费者永久死亡
    const err = new Error("spawn ENOENT"); err.code = "ENOENT";
    children[0].emit("error", err);
    vi.advanceTimersByTime(5000);
    expect(spawnFn).toHaveBeenCalledTimes(2);

    // 场景 2：error 后又发 exit（运行期错误），一次性标志防重复 spawn
    children[1].emit("error", new Error("boom"));
    children[1].emit("exit", 1);
    vi.advanceTimersByTime(5000);
    expect(spawnFn).toHaveBeenCalledTimes(3);
    consumer.stop();
    vi.useRealTimers();
  });
});

describe("wireGateway 管道装配", () => {
  const rawMsg = (over = {}) => ({
    header: { event_id: over.eventId ?? "we1", event_type: "im.message.receive_v1" },
    event: {
      sender: {
        sender_type: over.senderType ?? "user",
        sender_id: over.sender === null ? {} : { open_id: over.sender ?? "ou_a" },
      },
      message: {
        chat_id: over.chatId ?? "oc_1", chat_type: over.chatType ?? "p2p", message_type: "text",
        content: JSON.stringify({ text: over.text ?? "你好" }),
        mentions: over.mentions ?? [],
        create_time: String(over.createTime ?? 1720000000000),
      },
    },
  });

  function setup({
    handleTurn,
    actors = { enqueue: vi.fn((_, callback) => callback()) },
    log = vi.fn(),
  }) {
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
      actors,
      log,
    });
    return { db, children, wired, actors, log };
  }

  it("真实私聊 NDJSON 经 debounce 后按会话 key 入队，handleTurn 只在 actor 回调内触发", async () => {
    const turns = [];
    let actorCallback;
    const actors = {
      enqueue: vi.fn((_, callback) => {
        actorCallback = callback;
      }),
    };
    const { children, wired } = setup({ handleTurn: (t) => { turns.push(t); }, actors });
    children[0].stdout.emit("data", Buffer.from(JSON.stringify(rawMsg()) + "\n"));
    children[0].stdout.emit("data", Buffer.from(JSON.stringify(rawMsg()) + "\n")); // 同 event_id 去重
    await vi.advanceTimersByTimeAsync(600);
    expect(actors.enqueue).toHaveBeenCalledWith("feishu:p2p:ou_a", expect.any(Function));
    expect(turns).toHaveLength(0);
    await actorCallback();
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ kind: "message", sessionKey: "feishu:p2p:ou_a", mode: "addressed" });
    expect(turns[0].items).toHaveLength(1);
    wired.consumer.stop();
    vi.useRealTimers();
  });

  it("actor/handleTurn rejection is caught and logged at the gateway async boundary", async () => {
    const handleTurn = vi.fn(async () => { throw new Error("turn failed"); });
    const log = vi.fn();
    const { children, wired } = setup({ handleTurn, log });
    try {
      children[0].stdout.emit("data", Buffer.from(JSON.stringify(rawMsg({ eventId: "reject-1" })) + "\n"));
      await vi.advanceTimersByTimeAsync(600);
      expect(handleTurn).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("turn failed"));
    } finally {
      wired.consumer.stop();
      vi.useRealTimers();
    }
  });

  it("same-sender debounce keeps addressed mode when a later ambient message joins the batch", async () => {
    const turns = [];
    const { db, children, wired } = setup({ handleTurn: (turn) => { turns.push(turn); } });
    try {
      db.prepare(
        "INSERT INTO group_policies (chat_id, policy, hourly_proactive_limit, updated_at) VALUES (?, 'ambient', 4, 0)"
      ).run("oc_1");
      children[0].stdout.emit("data", Buffer.from(JSON.stringify(rawMsg({
        eventId: "mode-addressed",
        chatType: "group",
        mentions: [{ id: { open_id: "ou_bot" } }],
        text: "@小达 帮我查",
      })) + "\n"));
      children[0].stdout.emit("data", Buffer.from(JSON.stringify(rawMsg({
        eventId: "mode-ambient",
        chatType: "group",
        text: "再补一句",
      })) + "\n"));

      await vi.advanceTimersByTimeAsync(1500);
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({ mode: "addressed" });
      expect(turns[0].items).toHaveLength(2);
    } finally {
      wired.consumer.stop();
      vi.useRealTimers();
    }
  });

  it("admitted 消息在 debounce 前刷新会话，阻止 expiry 抢先 flush 与归档", async () => {
    const now = Date.UTC(2026, 6, 10, 8, 0, 0);
    const staleAt = now - 48 * 3600_000;
    const turns = [];
    const actors = createActorPool();
    const { db, children, wired } = setup({ handleTurn: (turn) => { turns.push(turn); }, actors });
    vi.setSystemTime(now);
    try {
      const store = createSessionStore(db);
      const session = store.getOrCreate("feishu:p2p:ou_a", { kind: "p2p" }, staleAt);
      store.append(session.id, { role: "user", content: "旧会话内容", ts: staleAt });
      const brain = { turn: vi.fn(async () => ({ finalText: "", events: [] })) };
      const expiry = createSessionExpiry({ db, agentStore: store, actors, brain });

      children[0].stdout.emit("data", Buffer.from(JSON.stringify(rawMsg({ createTime: now })) + "\n"));
      const result = await expiry.sweep(now);

      expect(result.archived).toBe(0);
      expect(db.prepare("SELECT status FROM agent_sessions WHERE id = ?").get(session.id).status).toBe("active");
      expect(brain.turn).not.toHaveBeenCalled();
      expect(turns).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(600);
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({ sessionKey: "feishu:p2p:ou_a", mode: "addressed" });
    } finally {
      wired.consumer.stop();
      vi.useRealTimers();
    }
  });

  it("缺少 actors 时 fail-fast", () => {
    const db = openDb();
    migrate(db);
    expect(() => wireGateway({
      db,
      config: { botOpenId: "ou_bot", larkCliPath: "/fake/lark-cli" },
      spawnFn: vi.fn(() => fakeChild()),
      handleTurn: vi.fn(),
    })).toThrowError("wireGateway: actors 必填");
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

  it("未通过 admit 的 disabled 群消息不刷新会话生命周期", () => {
    const now = Date.UTC(2026, 6, 10, 8, 0, 0);
    const staleAt = now - 48 * 3600_000;
    const { db, children, wired } = setup({ handleTurn: vi.fn() });
    vi.setSystemTime(now);
    try {
      db.prepare(
        "INSERT INTO group_policies (chat_id, policy, hourly_proactive_limit, updated_at) VALUES (?, 'disabled', 4, ?)"
      ).run("oc_1", staleAt);
      const store = createSessionStore(db);
      const session = store.getOrCreate("feishu:group:oc_1", { kind: "group", chatId: "oc_1" }, staleAt);

      children[0].stdout.emit("data", Buffer.from(JSON.stringify(rawMsg({
        eventId: "disabled-current",
        chatType: "group",
        createTime: now,
      })) + "\n"));

      expect(db.prepare("SELECT updated_at FROM agent_sessions WHERE id = ?").get(session.id).updated_at).toBe(staleAt);
    } finally {
      wired.consumer.stop();
      vi.useRealTimers();
    }
  });

  it("disabled 群首条消息不物化 active session", () => {
    const { db, children, wired } = setup({ handleTurn: vi.fn() });
    try {
      db.prepare(
        "INSERT INTO group_policies (chat_id, policy, hourly_proactive_limit, updated_at) VALUES (?, 'disabled', 4, 0)"
      ).run("oc_disabled");

      children[0].stdout.emit("data", Buffer.from(JSON.stringify(rawMsg({
        eventId: "disabled-first",
        chatId: "oc_disabled",
        chatType: "group",
      })) + "\n"));

      expect(db.prepare("SELECT 1 FROM agent_sessions WHERE session_key = ?").get("feishu:group:oc_disabled")).toBeUndefined();
    } finally {
      wired.consumer.stop();
      vi.useRealTimers();
    }
  });

  it("真实 app self-echo 不物化 session、不触发回合且不误报 parse error", () => {
    const handleTurn = vi.fn();
    const log = vi.fn();
    const { db, children, wired } = setup({ handleTurn, log });
    try {
      children[0].stdout.emit("data", Buffer.from(JSON.stringify(rawMsg({
        eventId: "app-self-echo",
        sender: null,
        senderType: "app",
      })) + "\n"));

      expect(db.prepare("SELECT COUNT(*) AS count FROM agent_sessions").get().count).toBe(0);
      expect(handleTurn).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      wired.consumer.stop();
      vi.useRealTimers();
    }
  });

  // ---- Task 5 C2: 生产装配链（env aliases → loadServerConfig → wireGateway → 扁平事件）----
  it("C2 装配链：旧名 @ 经 config/wire 转发在群里 addressed 且 content 规范化；@小达人 只 observe", async () => {
    vi.useFakeTimers();
    const db = openDb();
    migrate(db);
    const config = loadServerConfig({
      MSTD_BOT_OPEN_ID: "ou_bot", MSTD_BOT_NAME: "小达", MSTD_BOT_ALIASES: "旧名字",
      MSTD_SESSION_SECRET: "test-secret",
    });
    expect(config.botNames).toEqual(["旧名字", "小达"]);
    const children = [];
    const spawnFn = vi.fn(() => { const c = fakeChild(); children.push(c); return c; });
    const turns = [];
    const wired = wireGateway({
      db, config: { ...config, larkCliPath: "/fake/lark-cli" }, spawnFn,
      handleTurn: (t) => { turns.push(t); },
      actors: { enqueue: vi.fn((_, cb) => cb()) },
      log: vi.fn(),
    });
    try {
      const flat = (eventId, content) => JSON.stringify({
        type: "im.message.receive_v1", event_id: eventId, chat_id: "oc_1", chat_type: "group",
        message_type: "text", sender_id: "ou_a", content, create_time: "1000",
      }) + "\n";
      children[0].stdout.emit("data", Buffer.from(flat("cfg1", "@旧名字 hi")));
      children[0].stdout.emit("data", Buffer.from(flat("cfg2", "@小达人 是谁")));
      await vi.advanceTimersByTimeAsync(4000);
      // 旧名 addressed 且内容已规范化——config.botNames→wire→inbox 任何一环断线即红
      expect(turns).toHaveLength(1);
      expect(turns[0].mode).toBe("addressed");
      expect(turns[0].items[0].content).toBe("[@我] hi");
      // @小达人 不 addressed：admit 只信 inbox 的同源 mentionsBot——admit 回加 substring 判定即红
      const v2 = JSON.parse(db.prepare("SELECT verdict FROM inbox_events WHERE event_id = 'cfg2'").get().verdict);
      expect(v2.ok).toBe(false);
      expect(v2.reason).toBe("bot_not_mentioned_observe");
    } finally {
      wired.consumer.stop();
      vi.useRealTimers();
    }
  });
});
