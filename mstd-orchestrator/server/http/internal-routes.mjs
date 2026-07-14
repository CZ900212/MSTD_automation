// 内部通道：仅供本机 Pi 扩展（reply/memory 等工具）回传 daemon。
// C0.3 会话绑定 token：每个 Pi 进程持 per-spawn token，服务端由 token 反查绑定会话；
// body 里的 session_key 只作一致性校验，冒名其他会话一律 403 并落 model_log。
import { isBrainTurnAdmissionRejectionCode } from "../sessions/active-turn.mjs";

export function mountInternalRoutes(app, { tokens = null, activeTurnInitiators = null, modelLog = null, handleReply, memoryTool = null, searchTool = null, spawnBackground = null, proposeActions = null, heartbeat = null, egressSource = null, log = console.error }) {
  const guard = (req, res) => {
    const auth = String(req.headers.authorization ?? "");
    const match = /^Bearer (\S+)$/.exec(auth);
    // The complete binding (including resident epoch) is server-issued at Pi spawn;
    // registries that cannot provide that shape are rejected rather than silently downgraded.
    const binding = match && typeof tokens?.resolveBinding === "function"
      ? tokens.resolveBinding(match[1])
      : null;
    const bound = binding?.sessionKey ?? null;
    if (!bound) {
      // token 值不落日志:只留痕类别(缺头/解析失败),便于发现被回收 Pi 的在途请求与探测
      modelLog?.record({ type: "internal_auth_reject", sessionKey: null, detail: match ? "token 未解析" : "缺 Bearer 头" });
      res.status(403).json({ ok: false, error: "forbidden" });
      return null;
    }
    const body = req.body == null ? {} : req.body;
    if (typeof body !== "object" || Array.isArray(body)) {
      res.status(400).json({ ok: false, error: "JSON object body required" });
      return null;
    }
    if (body.session_key && body.session_key !== bound) {
      modelLog?.record({ type: "internal_auth_reject", sessionKey: bound, detail: `body=${body.session_key}` });
      res.status(403).json({ ok: false, error: "session 越权" });
      return null;
    }
    return { sessionKey: bound, binding, body };
  };

  app.post("/internal/reply", async (req, res) => {
    const auth = guard(req, res);
    if (!auth) return;
    const { sessionKey, binding, body } = auth;
    const { kind, stage = "final", brief, tone, target, turn_id: turnId, turn_lease: turnLease } = body;
    if (stage !== "progress" && stage !== "final") {
      return res.status(400).json({ ok: false, error: "stage 必须是 progress 或 final" });
    }
    if (typeof brief !== "string" || !brief.trim()) {
      return res.status(400).json({ ok: false, error: "brief 必填" });
    }
    const residentEpoch = binding?.residentEpoch ?? null;
    try {
      const result = await handleReply({
        sessionKey,
        kind,
        stage,
        brief,
        tone,
        target,
        turnId,
        turnLease,
        residentEpoch,
      });
      // ok:false 也要留痕：否则失败只存在于 Pi transcript,daemon 侧零可观测
      if (!result?.ok) log(`[internal/reply] ok=false session=${sessionKey}: ${JSON.stringify(result?.error ?? null)?.slice(0, 300)}`);
      if (!result?.ok && isBrainTurnAdmissionRejectionCode(result?.code)) {
        return res.status(403).json(result);
      }
      res.json(result);
    } catch (e) {
      log(`[internal/reply] ${e?.message ?? e}`);
      res.status(500).json({ ok: false, error: String(e?.message ?? e) });
    }
  });

  app.post("/internal/memory", (req, res) => {
    const auth = guard(req, res);
    if (!auth) return;
    if (!memoryTool) return res.status(501).json({ ok: false, error: "memory 未启用" });
    const { sessionKey, body } = auth;
    const { session_key: _ignored, ...params } = body;
    res.json(memoryTool.run(params, { sessionKey }));
  });

  app.post("/internal/propose-actions", async (req, res) => {
    const auth = guard(req, res);
    if (!auth) return;
    if (!proposeActions) return res.status(501).json({ ok: false, error: "写路径未启用" });
    const { sessionKey, binding, body } = auth;
    const { turn_id: turnId, turn_lease: turnLease } = body;
    const initiatorOpenId = activeTurnInitiators?.resolveAuthorized?.({
      sessionKey,
      turnId,
      lease: turnLease,
      residentEpoch: binding?.residentEpoch ?? null,
    }) ?? null;
    if (!initiatorOpenId) {
      modelLog?.record({ type: "internal_auth_reject", sessionKey, detail: "propose_actions 无 active turn initiator" });
      return res.status(403).json({ ok: false, error: "当前调用未绑定真实消息发起人，拒绝创建写操作" });
    }
    const { title, intents } = body;
    try {
      const r = await proposeActions({ sessionKey, initiatorOpenId, title, intents });
      res.json(r.ok ? { ok: true, job_id: r.jobId, message_id: r.messageId } : r);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message ?? e) });
    }
  });

  app.post("/internal/background", (req, res) => {
    const auth = guard(req, res);
    if (!auth) return;
    if (!spawnBackground) return res.status(501).json({ ok: false, error: "后台 job 未启用" });
    const { sessionKey, body } = auth;
    const { kind, brief, params } = body;
    try {
      const jobId = spawnBackground({ sessionKey, kind, brief, params });
      res.json({ ok: true, job_id: jobId });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message ?? e) });
    }
  });

  // C0.4：heartbeat 绑定 token 会话——owner 恒为服务端绑定值,跨会话 deliver_to 一律 403;
  // remove 只认 item_id（配合 store 的 id+owner+status=pending 限定,废除任意子串删除）。
  app.post("/internal/heartbeat", (req, res) => {
    const auth = guard(req, res);
    if (!auth) return;
    if (!heartbeat) return res.status(501).json({ ok: false, error: "heartbeat 未启用" });
    const { sessionKey, body } = auth;
    const { action, due_iso: dueIso, text, deliver_to: deliverTo, item_id: itemId } = body;
    if (action === "add") {
      if (deliverTo !== undefined && deliverTo !== sessionKey) {
        modelLog?.record({ type: "internal_auth_reject", sessionKey, detail: `heartbeat deliver_to=${deliverTo}` });
        return res.status(403).json({ ok: false, error: "deliver_to 越权：heartbeat 只能给当前会话加提醒,跨会话提醒请用 propose_actions 的 schedule_reminder（需用户确认）" });
      }
      if (!dueIso || !text) return res.status(400).json({ ok: false, error: "add 需要 due_iso + text" });
      const r = heartbeat.addOwned({ ownerSessionKey: sessionKey, dueIso, text });
      return r.ok ? res.json({ ok: true, item_id: r.itemId }) : res.status(400).json(r);
    }
    if (action === "list") {
      return res.json({ ok: true, items: heartbeat.listOwned(sessionKey) });
    }
    if (action === "remove") {
      if (!itemId) return res.status(400).json({ ok: false, error: "remove 需要 item_id（match 子串协议已废除,先 list 拿 id）" });
      return res.json(heartbeat.removeOwned({ ownerSessionKey: sessionKey, itemId }));
    }
    res.status(400).json({ ok: false, error: `未知 action: ${action}` });
  });

  app.post("/internal/session-search", (req, res) => {
    const auth = guard(req, res);
    if (!auth) return;
    if (!searchTool) return res.status(501).json({ ok: false, error: "session_search 未启用" });
    const { sessionKey, body } = auth;
    const { session_key: _ignored, ...params } = body;
    res.json(searchTool.run(params, { sessionKey }));
  });

  // 批次 C：lark_read 读取回执。Pi 每次成功读取后上报源文本——服务端登记逐字 shingle
  // （群聊逐字引用禁令/私聊预算的比对基准），席位私有 op 同时给本 epoch 打 taint。
  // 纯登记面：永不返回内容、永不影响读取本身；上报文本只进内存 shingle，不落库。
  app.post("/internal/egress/source", (req, res) => {
    const auth = guard(req, res);
    if (!auth) return;
    if (!egressSource) return res.status(501).json({ ok: false, error: "egress source 未启用" });
    const { sessionKey, body } = auth;
    const op = typeof body.op === "string" ? body.op : "";
    const text = typeof body.text === "string" ? body.text : "";
    if (!op || !text) return res.status(400).json({ ok: false, error: "op + text 必填" });
    try {
      res.json(egressSource.record({ sessionKey, op, text }));
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message ?? e) });
    }
  });
}
