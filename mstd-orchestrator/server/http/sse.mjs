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
  if (replaying) {
    buffer?.flush?.();
    let last = Number(sinceSeq);
    const rows = db.prepare(
      "SELECT seq, type, payload_json FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq"
    ).all(jobId, last);
    for (const r of rows) {
      res.write(sseFormat({ event: r.type, data: JSON.parse(r.payload_json ?? "{}"), seq: r.seq }));
      last = r.seq;
    }
    replaying = false;
    for (const sse of backlog) if (sse.seq == null || sse.seq > last) res.write(sseFormat(sse));
    backlog.length = 0;
  }
  const hb = si(() => res.write(": ping\n\n"), heartbeatMs);
  const close = () => { ci(hb); unsub(); };
  res.on?.("close", close);
  return close;
}
