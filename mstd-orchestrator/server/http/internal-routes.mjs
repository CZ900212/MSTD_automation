// 内部通道：仅供本机 Pi 扩展（reply/memory 等工具）回传 daemon。
// C0.3 会话绑定 token：每个 Pi 进程持 per-spawn token，服务端由 token 反查绑定会话；
// body 里的 session_key 只作一致性校验，冒名其他会话一律 403 并落 model_log。
export function mountInternalRoutes(app, { tokens = null, modelLog = null, handleReply, memoryTool = null, searchTool = null, spawnBackground = null, proposeActions = null, heartbeat = null, log = console.error }) {
  const guard = (req, res) => {
    const auth = String(req.headers.authorization ?? "");
    const match = /^Bearer (\S+)$/.exec(auth);
    const bound = match ? (tokens?.resolve(match[1]) ?? null) : null;
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
    return { sessionKey: bound, body };
  };

  app.post("/internal/reply", async (req, res) => {
    const auth = guard(req, res);
    if (!auth) return;
    const { sessionKey, body } = auth;
    const { kind, brief, tone, target } = body;
    try {
      res.json(await handleReply({ sessionKey, kind, brief, tone, target }));
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
    const { sessionKey, body } = auth;
    const { title, intents } = body;
    try {
      const r = await proposeActions({ sessionKey, title, intents });
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

  app.post("/internal/heartbeat", (req, res) => {
    const auth = guard(req, res);
    if (!auth) return;
    if (!heartbeat) return res.status(501).json({ ok: false, error: "heartbeat 未启用" });
    const { sessionKey, body } = auth;
    const { action, due_iso: dueIso, text, deliver_to: deliverTo, match } = body;
    if (action === "add") {
      if (!dueIso || !text) return res.status(400).json({ ok: false, error: "add 需要 due_iso + text" });
      return res.json(heartbeat.addItem({ dueIso, text, deliverTo: deliverTo || sessionKey }));
    }
    if (action === "remove") {
      if (!match) return res.status(400).json({ ok: false, error: "remove 需要 match" });
      return res.json(heartbeat.removeItem(match));
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
}
