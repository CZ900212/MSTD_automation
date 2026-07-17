export function sseFormat(sse) {
  const id = sse.seq != null ? `id: ${sse.seq}\n` : "";
  return `${id}event: ${sse.event}\ndata: ${JSON.stringify(sse.data ?? {})}\n\n`;
}

export function streamJobEvents({
  db = null,
  bus,
  buffer = null,
  jobId,
  res,
  sinceSeq = null,
  heartbeatMs = 15000,
  setInterval: si = setInterval,
  clearInterval: ci = clearInterval,
}) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": open\n\n");
  const backlog = [];
  let replaying = sinceSeq != null && db != null;
  const unsub = bus.subscribe(jobId, (sse) => {
    if (replaying) backlog.push(sse);
    else res.write(sseFormat(sse));
  });
  // close 清理必须先于回放注册：回放段可能抛错提前退出,若清理还没挂上,订阅和定时器就没人收
  const hb = si(() => res.write(": ping\n\n"), heartbeatMs);
  const close = () => { ci(hb); unsub(); };
  res.on?.("close", close);
  if (replaying) {
    try {
      buffer?.flush?.();
      let last = Number(sinceSeq);
      const rows = db.prepare(
        "SELECT seq, type, payload_json FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq"
      ).all(jobId, last);
      for (const r of rows) {
        // 坏行不砸整个流：headers 已发出,此处抛错会让响应悬死;单行损坏降级为空 data 继续补发
        let data = {};
        try { data = JSON.parse(r.payload_json ?? "{}"); } catch { /* 保持 {} */ }
        res.write(sseFormat({ event: r.type, data, seq: r.seq }));
        last = r.seq;
      }
      replaying = false;
      for (const sse of backlog) if (sse.seq == null || sse.seq > last) res.write(sseFormat(sse));
      backlog.length = 0;
    } catch {
      // 数据源整体抛错(而非单行损坏):不留悬挂订阅/定时器,发一条 error 事件后主动收尾
      replaying = false;
      backlog.length = 0;
      res.write(sseFormat({ event: "error", data: { message: "replay_failed" } }));
      close();
      res.end?.();
    }
  }
  return close;
}
