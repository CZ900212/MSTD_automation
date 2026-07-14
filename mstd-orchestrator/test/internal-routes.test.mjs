import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createApp } from "../server/app.mjs";
import { createSessionTokenRegistry } from "../server/http/session-tokens.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";
import { createActiveTurnRegistry } from "../server/sessions/active-turn.mjs";
import { createTurnHandler } from "../server/gateway/turn-handler.mjs";

function makeApp(internal) {
  const db = openDb();
  migrate(db);
  return createApp({ db, config: { sessionSecret: "test-secret" }, internal });
}

describe("C0.3 内部通道会话绑定鉴权", () => {
  it("缺少 resolveBinding 的旧 token registry 在鉴权边界 fail-closed", async () => {
    const handleReply = vi.fn(async () => ({ ok: true }));
    const app = makeApp({
      tokens: { resolve: vi.fn(() => "feishu:p2p:ou_legacy") },
      handleReply,
    });

    const response = await request(app).post("/internal/reply")
      .set("Authorization", "Bearer legacy-token")
      .send({ brief: "x" });

    expect(response.status).toBe(403);
    expect(handleReply).not.toHaveBeenCalled();
  });

  it("token 反查会话:冒名 session_key 403 且落 model_log;正确调用以服务端解析值为准", async () => {
    const reg = createSessionTokenRegistry();
    const tok = reg.issue("feishu:p2p:ou_a");
    const rejects = [];
    const seen = [];
    const app = makeApp({
      tokens: reg,
      modelLog: { record: (e) => rejects.push(e) },
      handleReply: async (args) => { seen.push(args); return { ok: true }; },
    });

    const r1 = await request(app).post("/internal/reply")
      .set("Authorization", `Bearer ${tok}`)
      .send({ session_key: "feishu:p2p:ou_别人", kind: "message", brief: "x" });
    expect(r1.status).toBe(403);
    expect(seen).toHaveLength(0);
    expect(rejects[0]).toMatchObject({ type: "internal_auth_reject", sessionKey: "feishu:p2p:ou_a" });

    const r2 = await request(app).post("/internal/reply")
      .set("Authorization", `Bearer ${tok}`)
      .send({ session_key: "feishu:p2p:ou_a", kind: "message", brief: "x" });
    expect(r2.status).toBe(200);
    expect(seen[0]).toMatchObject({ sessionKey: "feishu:p2p:ou_a", kind: "message", brief: "x" });

    const r3 = await request(app).post("/internal/reply")
      .set("Authorization", "Bearer fake-token-never-issued")
      .send({ session_key: "feishu:p2p:ou_a", brief: "x" });
    expect(r3.status).toBe(403);
    // 未解析 token 同样留痕(sessionKey=null),但绝不记录 token 值本身
    const unresolved = rejects.find((e) => e.sessionKey === null);
    expect(unresolved).toMatchObject({ type: "internal_auth_reject", detail: "token 未解析" });
    expect(JSON.stringify(unresolved)).not.toContain("fake-token-never-issued");

    reg.revoke(tok);
    const r4 = await request(app).post("/internal/reply")
      .set("Authorization", `Bearer ${tok}`)
      .send({ kind: "message", brief: "x" });
    expect(r4.status).toBe(403);   // 已吊销 token 的在途请求 fail-closed 且留痕
  });

  it("reply resident epoch is read only from the server-issued token binding", async () => {
    const reg = createSessionTokenRegistry();
    const tok = reg.issue("feishu:p2p:ou_me", { residentEpoch: 7, provenanceHash: "server-hash" });
    const seen = [];
    const app = makeApp({ tokens: reg, handleReply: async (args) => { seen.push(args); return { ok: true }; } });
    const r = await request(app).post("/internal/reply")
      .set("Authorization", `Bearer ${tok}`)
      .send({ brief: "x", stage: "progress", residentEpoch: 999, provenanceHash: "forged", turn_id: "turn-1", turn_lease: "lease-1" });
    expect(r.status).toBe(200);
    expect(seen[0]).toMatchObject({
      sessionKey: "feishu:p2p:ou_me",
      residentEpoch: 7,
      turnId: "turn-1",
      turnLease: "lease-1",
      stage: "progress",
    });
    expect(seen[0]).not.toHaveProperty("provenanceHash");
  });

  it("reply admission rejection codes are mapped to 403 after handleReply owns admission", async () => {
    const reg = createSessionTokenRegistry();
    const tok = reg.issue("feishu:p2p:ou_me", { residentEpoch: 7 });
    const codes = ["no_active_turn", "maintenance_silent", "turn_closing", "stale_turn_context"];

    for (const code of codes) {
      const handleReply = vi.fn(async () => ({ ok: false, code, error: `reply 拒绝: ${code}` }));
      const app = makeApp({ tokens: reg, handleReply });
      const response = await request(app).post("/internal/reply")
        .set("Authorization", `Bearer ${tok}`)
        .send({ brief: code, turn_id: "wrong", turn_lease: "wrong" });

      expect(response.status, code).toBe(403);
      expect(handleReply, code).toHaveBeenCalledWith(expect.objectContaining({
        sessionKey: "feishu:p2p:ou_me",
        turnId: "wrong",
        turnLease: "wrong",
        residentEpoch: 7,
      }));
    }
  });

  it("集成：合法路由调用经真实 handleReply admission 到物理投递并终态化回执；坏 lease 403 零投递", async () => {
    const db = openDb();
    migrate(db);
    const store = createSessionStore(db);
    const sessionKey = "feishu:p2p:ou_int";
    store.getOrCreate(sessionKey, { kind: "p2p" });

    const registry = createActiveTurnRegistry({ issueId: () => "turn-1" });
    const outbound = {
      sendMessage: vi.fn(async () => ({ messageId: "om_final" })),
      sendCard: vi.fn(async () => ({ messageId: "om_card" })),
    };
    const handler = createTurnHandler({
      triage: { triage: vi.fn() },
      brain: { turn: vi.fn(), steer: vi.fn(), isBusy: () => false },
      renderReply: vi.fn(async () => ({ text: "正式答复", usage: null })),
      outbound,
      store,
      budget: { allow: () => ({ ok: true }), record: vi.fn() },
      activeTurns: registry.receipts,
      activeBrainTurns: registry.brainTurns,
      onEvent: () => {},
      log: () => {},
    });

    // daemon 侧真实开启 business 回合：receipt + brain lease + resident 绑定
    registry.receipts.begin({ sessionKey, purpose: "business", expectsReply: true });
    const lease = registry.brainTurns.activate({ sessionKey, turnId: "turn-1", purpose: "business" });
    registry.brainTurns.bindResident(sessionKey, lease, 7);

    const reg = createSessionTokenRegistry();
    const tok = reg.issue(sessionKey, { residentEpoch: 7 });
    const app = makeApp({ tokens: reg, handleReply: handler.handleReply });

    // 坏 lease：admission 在 handleReply 内被拒 → 403 机器可读 code，零物理投递
    const denied = await request(app).post("/internal/reply")
      .set("Authorization", `Bearer ${tok}`)
      .send({ kind: "message", brief: "答复", turn_id: "turn-1", turn_lease: "forged-lease" });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ ok: false, code: "stale_turn_context" });
    expect(outbound.sendMessage).not.toHaveBeenCalled();

    // 合法调用：路由不做 admit，handleReply 独占 admission → 渲染 → 投递 → 回执终态
    const allowed = await request(app).post("/internal/reply")
      .set("Authorization", `Bearer ${tok}`)
      .send({ kind: "message", stage: "final", brief: "给用户答复", turn_id: "turn-1", turn_lease: lease });
    expect(allowed.status).toBe(200);
    expect(allowed.body.ok).toBe(true);
    expect(outbound.sendMessage).toHaveBeenCalledTimes(1);
    expect(outbound.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "正式答复" }));
    expect(registry.receipts.resolve(sessionKey)).toMatchObject({
      turnId: "turn-1",
      state: "terminal",
      terminal: { outcome: "formal_reply_sent", messageId: "om_final" },
    });
  });

  it("blank reply brief is rejected before admission so finish cannot hang", async () => {
    const reg = createSessionTokenRegistry();
    const tok = reg.issue("feishu:p2p:ou_me", { residentEpoch: 7 });
    const activeBrainTurns = { admit: vi.fn() };
    const handleReply = vi.fn(async () => ({ ok: true }));
    const app = makeApp({ tokens: reg, activeBrainTurns, handleReply });
    const r = await request(app).post("/internal/reply")
      .set("Authorization", `Bearer ${tok}`)
      .send({ brief: "   ", turn_id: "turn-1", turn_lease: "lease-1" });
    expect(r.status).toBe(400);
    expect(activeBrainTurns.admit).not.toHaveBeenCalled();
    expect(handleReply).not.toHaveBeenCalled();
  });

  it("falsy session_key(空串)按未声明处理:回落绑定会话,不算冒名", async () => {
    const reg = createSessionTokenRegistry();
    const tok = reg.issue("feishu:p2p:ou_me");
    const seen = [];
    const app = makeApp({
      tokens: reg,
      handleReply: async (args) => { seen.push(args); return { ok: true }; },
    });
    const r = await request(app).post("/internal/reply")
      .set("Authorization", `Bearer ${tok}`)
      .send({ session_key: "", brief: "x" });
    expect(r.status).toBe(200);
    expect(seen[0]).toMatchObject({ sessionKey: "feishu:p2p:ou_me" });
  });

  it("body 不带 session_key 时,路由使用服务端绑定会话", async () => {
    const reg = createSessionTokenRegistry();
    const tok = reg.issue("feishu:group:oc_g");
    const seen = [];
    const app = makeApp({
      tokens: reg,
      handleReply: async (args) => { seen.push(args); return { ok: true }; },
    });
    const r = await request(app).post("/internal/reply")
      .set("Authorization", `Bearer ${tok}`)
      .send({ kind: "message", brief: "无声明" });
    expect(r.status).toBe(200);
    expect(seen[0]).toMatchObject({ sessionKey: "feishu:group:oc_g", brief: "无声明" });
  });

  it("header 边界表驱动:变形 Authorization 一律 403(含有效 token 嵌畸形头,锚定 strict 正则)", async () => {
    const reg = createSessionTokenRegistry();
    const tok = reg.issue("k1");
    const app = makeApp({ tokens: reg, handleReply: async () => ({ ok: true }) });
    const bads = [
      null,                     // 缺 header
      `Token ${tok}`,           // 错误 scheme
      `bearer ${tok}`,          // 小写 scheme
      `Bearer  ${tok}`,         // 双空格
      `Bearer ${tok} extra`,    // 尾随内容
      "Bearer",                 // 无 token
      "Bearer ",                // 空 token
      // 有效 token 藏在前缀伪装里:正则一旦放宽(去 ^ 锚)就会捕获出有效 token 放行
      // (前导空格 ` Bearer x` 不在表内:HTTP 层按 RFC 7230 先 trim OWS,到不了 guard)
      `X-Evil Bearer ${tok}`,
      `NotBearer ${tok}`,
    ];
    for (const auth of bads) {
      let req = request(app).post("/internal/reply");
      if (auth !== null) req = req.set("Authorization", auth);
      const r = await req.send({ brief: "x" });
      expect(r.status, `auth=${JSON.stringify(auth)}`).toBe(403);
    }
  });

  it("全部六条路由都过 guard:无 token 403(且先于 501 依赖检查)、冒名 403、合法调用注入绑定会话", async () => {
    const reg = createSessionTokenRegistry();
    const tok = reg.issue("feishu:p2p:ou_me");
    const calls = { reply: [], memory: [], propose: [], background: [], heartbeat: [], search: [] };
    const app = makeApp({
      tokens: reg,
      activeTurnInitiators: {
        resolveAuthorized: ({ sessionKey, turnId, lease, residentEpoch }) =>
          sessionKey === "feishu:p2p:ou_me"
            && turnId === "turn-1"
            && lease === "lease-1"
            && residentEpoch === null
            ? "ou_me"
            : null,
      },
      handleReply: async (a) => { calls.reply.push(a); return { ok: true }; },
      memoryTool: { run: (params, ctx) => { calls.memory.push({ params, ctx }); return { ok: true }; } },
      proposeActions: async (a) => { calls.propose.push(a); return { ok: true, jobId: 1, messageId: "m" }; },
      spawnBackground: (a) => { calls.background.push(a); return 7; },
      heartbeat: {
        addOwned: (a) => { calls.heartbeat.push(a); return { ok: true, itemId: "hb-1" }; },
        listOwned: () => [],
        removeOwned: () => ({ ok: true }),
      },
      searchTool: { run: (params, ctx) => { calls.search.push({ params, ctx }); return { ok: true } ; } },
    });
    const routes = [
      ["/internal/reply", { kind: "message", brief: "x" }],
      ["/internal/memory", { op: "read" }],
      ["/internal/propose-actions", { title: "t", intents: [], turn_id: "turn-1", turn_lease: "lease-1" }],
      ["/internal/background", { kind: "k", brief: "b" }],
      ["/internal/heartbeat", { action: "add", due_iso: "2026-07-12T00:00:00+08:00", text: "t" }],
      ["/internal/session-search", { q: "关键词" }],
    ];
    for (const [path, body] of routes) {
      // 无 token → 403,且必须先于依赖存在性检查(不得泄漏 501 信息)
      const r0 = await request(app).post(path).send(body);
      expect(r0.status, `${path} 无 token`).toBe(403);
      // 冒名其他会话 → 403
      const r1 = await request(app).post(path)
        .set("Authorization", `Bearer ${tok}`)
        .send({ ...body, session_key: "feishu:p2p:ou_victim" });
      expect(r1.status, `${path} 冒名`).toBe(403);
      // 合法调用 → 200
      const r2 = await request(app).post(path)
        .set("Authorization", `Bearer ${tok}`)
        .send(body);
      expect(r2.status, `${path} 合法`).toBe(200);
    }
    // 每条路由都只拿到服务端绑定会话
    expect(calls.reply[0]).toMatchObject({ sessionKey: "feishu:p2p:ou_me" });
    expect(calls.memory[0].ctx).toMatchObject({ sessionKey: "feishu:p2p:ou_me" });
    expect(calls.propose[0]).toMatchObject({ sessionKey: "feishu:p2p:ou_me" });
    expect(calls.background[0]).toMatchObject({ sessionKey: "feishu:p2p:ou_me" });
    expect(calls.heartbeat[0]).toMatchObject({ ownerSessionKey: "feishu:p2p:ou_me" });
    expect(calls.search[0].ctx).toMatchObject({ sessionKey: "feishu:p2p:ou_me" });
    // guard 对未启用依赖的路由也先行:无 token 时绝不返回 501
    const appBare = makeApp({ tokens: createSessionTokenRegistry(), handleReply: async () => ({ ok: true }) });
    for (const path of ["/internal/memory", "/internal/propose-actions", "/internal/background", "/internal/heartbeat", "/internal/session-search"]) {
      const r = await request(appBare).post(path).send({});
      expect(r.status, `${path} 无 token+未启用`).toBe(403);
    }
  });

  it("propose-actions 有效 token 但无 active initiator 时零副作用 403；body 伪造 initiator 无效", async () => {
    const reg = createSessionTokenRegistry();
    const tok = reg.issue("feishu:group:oc_g");
    const proposeActions = vi.fn(async () => ({ ok: true, jobId: "j", messageId: "m" }));
    const active = { resolveAuthorized: vi.fn(() => null) };
    const app = makeApp({ tokens: reg, activeTurnInitiators: active, proposeActions, handleReply: async () => ({ ok: true }) });
    const denied = await request(app).post("/internal/propose-actions")
      .set("Authorization", `Bearer ${tok}`)
      .send({ initiatorOpenId: "ou_forged", title: "x", intents: [], turn_id: "turn-1", turn_lease: "lease-1" });
    expect(denied.status).toBe(403);
    expect(proposeActions).not.toHaveBeenCalled();

    active.resolveAuthorized.mockReturnValue("ou_real");
    const allowed = await request(app).post("/internal/propose-actions")
      .set("Authorization", `Bearer ${tok}`)
      .send({ initiatorOpenId: "ou_forged", title: "x", intents: [], turn_id: "turn-1", turn_lease: "lease-1" });
    expect(allowed.status).toBe(200);
    expect(proposeActions).toHaveBeenCalledWith(expect.objectContaining({ sessionKey: "feishu:group:oc_g", initiatorOpenId: "ou_real" }));
  });

  it("精确 Bearer 且无 body 时不得 500,由具体路由返回 501/400", async () => {
    const reg = createSessionTokenRegistry();
    const tok = reg.issue("k1");
    const app = makeApp({ tokens: reg, handleReply: async () => ({ ok: true }) });

    // memory 未启用 → 501(而非 500/400)
    const r1 = await request(app).post("/internal/memory")
      .set("Authorization", `Bearer ${tok}`);
    expect(r1.status).toBe(501);

    // heartbeat 未启用 → 501
    const r2 = await request(app).post("/internal/heartbeat")
      .set("Authorization", `Bearer ${tok}`);
    expect(r2.status).toBe(501);
  });

  it("数组/标量 body 400;heartbeat add 缺参 400 且 owner 恒为绑定会话", async () => {
    const reg = createSessionTokenRegistry();
    const tok = reg.issue("feishu:p2p:ou_me");
    const added = [];
    const heartbeat = {
      addOwned: vi.fn((x) => { added.push(x); return { ok: true, itemId: "hb-1" }; }),
      listOwned: vi.fn(() => []),
      removeOwned: vi.fn(() => ({ ok: true })),
    };
    const app = makeApp({ tokens: reg, handleReply: async () => ({ ok: true }), heartbeat });

    const rArr = await request(app).post("/internal/reply")
      .set("Authorization", `Bearer ${tok}`)
      .set("Content-Type", "application/json")
      .send(JSON.stringify([1, 2]));
    expect(rArr.status).toBe(400);

    const rScalar = await request(app).post("/internal/reply")
      .set("Authorization", `Bearer ${tok}`)
      .set("Content-Type", "application/json")
      .send(JSON.stringify("裸字符串"));
    expect(rScalar.status).toBe(400);

    const rMissing = await request(app).post("/internal/heartbeat")
      .set("Authorization", `Bearer ${tok}`)
      .send({ action: "add" });
    expect(rMissing.status).toBe(400);

    const rAdd = await request(app).post("/internal/heartbeat")
      .set("Authorization", `Bearer ${tok}`)
      .send({ action: "add", due_iso: "2026-07-12T00:00:00+08:00", text: "提醒" });
    expect(rAdd.status).toBe(200);
    expect(added[0]).toMatchObject({ ownerSessionKey: "feishu:p2p:ou_me" });
  });

  it("C0.4 heartbeat 绑定会话：deliver_to 越权 403 提示 propose_actions;add 回 item_id;list 只列 owner;remove 走 id+owner", async () => {
    const reg = createSessionTokenRegistry();
    const tok = reg.issue("feishu:p2p:ou_a");
    const calls = { add: [], list: [], remove: [] };
    const heartbeat = {
      addOwned: (a) => { calls.add.push(a); return { ok: true, itemId: "hb-1" }; },
      listOwned: (owner) => { calls.list.push(owner); return [{ id: "hb-1", due_at: 1, text: "喝水", status: "pending" }]; },
      removeOwned: (a) => { calls.remove.push(a); return a.itemId === "hb-1" ? { ok: true } : { ok: false, error: "未命中" }; },
    };
    const app = makeApp({ tokens: reg, handleReply: async () => ({ ok: true }), heartbeat });
    const post = (body) => request(app).post("/internal/heartbeat").set("Authorization", `Bearer ${tok}`).send(body);

    // 跨会话 deliver_to → 403 且提示走 propose_actions,零 store 调用
    const r1 = await post({ action: "add", due_iso: "2026-07-12T00:00:00+08:00", text: "t", deliver_to: "feishu:p2p:ou_b" });
    expect(r1.status).toBe(403);
    expect(r1.body.error).toContain("propose_actions");
    expect(calls.add).toHaveLength(0);

    // deliver_to === 绑定会话:等价省略,放行
    const r2 = await post({ action: "add", due_iso: "2026-07-12T00:00:00+08:00", text: "t", deliver_to: "feishu:p2p:ou_a" });
    expect(r2.status).toBe(200);

    // 省略 deliver_to → 成功并返回 item_id,owner 是服务端绑定值
    const r3 = await post({ action: "add", due_iso: "2026-07-12T00:00:00+08:00", text: "喝水" });
    expect(r3.status).toBe(200);
    expect(r3.body).toMatchObject({ ok: true, item_id: "hb-1" });
    expect(calls.add.at(-1)).toMatchObject({ ownerSessionKey: "feishu:p2p:ou_a", text: "喝水" });

    // list 只带绑定 owner（不泄露他人）
    const r4 = await post({ action: "list" });
    expect(r4.status).toBe(200);
    expect(r4.body.items).toHaveLength(1);
    expect(calls.list).toEqual(["feishu:p2p:ou_a"]);

    // remove 只收 item_id;老的 match 子串协议不再接受
    const r5 = await post({ action: "remove", match: "喝水" });
    expect(r5.status).toBe(400);
    expect(calls.remove).toHaveLength(0);
    const r6 = await post({ action: "remove", item_id: "hb-1" });
    expect(r6.status).toBe(200);
    expect(r6.body.ok).toBe(true);
    expect(calls.remove[0]).toMatchObject({ ownerSessionKey: "feishu:p2p:ou_a", itemId: "hb-1" });
    // 他 owner 的 id → store 层未命中,不成功
    const r7 = await post({ action: "remove", item_id: "hb-of-owner-b" });
    expect(r7.body.ok).toBe(false);

    // store 校验失败（如坏 ISO）→ 400 透传错误
    const app2 = makeApp({
      tokens: reg,
      handleReply: async () => ({ ok: true }),
      heartbeat: { addOwned: () => ({ ok: false, error: "due_iso 非法" }), listOwned: () => [], removeOwned: () => ({ ok: true }) },
    });
    const tok2 = reg.issue("feishu:p2p:ou_a");
    const rBad = await request(app2).post("/internal/heartbeat").set("Authorization", `Bearer ${tok2}`)
      .send({ action: "add", due_iso: "明天", text: "x" });
    expect(rBad.status).toBe(400);
    expect(rBad.body.error).toContain("due_iso");
  });

  it("未配置 tokens 注册表时内部通道整体 403(fail-closed)", async () => {
    const app = makeApp({ handleReply: async () => ({ ok: true }) });
    const r = await request(app).post("/internal/reply")
      .set("Authorization", "Bearer any-token")
      .send({ brief: "x" });
    expect(r.status).toBe(403);
  });
});

describe("批次 C：/internal/egress/source 读取回执登记", () => {
  it("token 绑定会话登记 shingle；席位私有 op 打 taint；缺参 400；未启用 501", async () => {
    const reg = createSessionTokenRegistry();
    const tok = reg.issue("feishu:p2p:ou_owner");
    const recorded = [];
    const app = makeApp({
      tokens: reg,
      handleReply: async () => ({ ok: true }),
      egressSource: {
        record({ sessionKey, op, text }) {
          recorded.push({ sessionKey, op, textLength: text.length });
          return { ok: true, shingles: 3, sensitivity: op === "mail_list" ? "restricted" : "internal" };
        },
      },
    });

    const ok = await request(app).post("/internal/egress/source")
      .set("Authorization", `Bearer ${tok}`)
      .send({ session_key: "feishu:p2p:ou_owner", op: "mail_list", text: "邮件正文".repeat(20) });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, sensitivity: "restricted" });
    expect(recorded[0]).toMatchObject({ sessionKey: "feishu:p2p:ou_owner", op: "mail_list" });

    const missing = await request(app).post("/internal/egress/source")
      .set("Authorization", `Bearer ${tok}`)
      .send({ session_key: "feishu:p2p:ou_owner", op: "read_doc" });
    expect(missing.status).toBe(400);

    const spoof = await request(app).post("/internal/egress/source")
      .set("Authorization", `Bearer ${tok}`)
      .send({ session_key: "feishu:p2p:ou_别人", op: "read_doc", text: "x" });
    expect(spoof.status).toBe(403);

    const bare = makeApp({ tokens: reg, handleReply: async () => ({ ok: true }) });
    const off = await request(bare).post("/internal/egress/source")
      .set("Authorization", `Bearer ${reg.issue("feishu:p2p:ou_owner")}`)
      .send({ op: "read_doc", text: "x" });
    expect(off.status).toBe(501);
  });
});
