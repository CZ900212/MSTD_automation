export function sseFormat(sse) {
  return `event: ${sse.event}\ndata: ${JSON.stringify(sse.data ?? {})}\n\n`;
}

export function streamJobEvents({ bus, jobId, res, heartbeatMs = 15000, setInterval: si = setInterval, clearInterval: ci = clearInterval }) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": open\n\n");
  const unsub = bus.subscribe(jobId, (sse) => res.write(sseFormat(sse)));
  const hb = si(() => res.write(": ping\n\n"), heartbeatMs);
  const close = () => { ci(hb); unsub(); };
  res.on?.("close", close);
  return close;
}
