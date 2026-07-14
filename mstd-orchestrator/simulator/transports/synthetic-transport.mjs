import { signSimulatorRequest, newNonce } from "../../server/simulator/auth.mjs";
import { canonicalJson } from "../../server/safety/action-dsl.mjs";

export function createSyntheticTransport({
  baseUrl = "http://127.0.0.1:8787",
  secret,
  fetchFn = fetch,
}) {
  if (!secret || secret.length < 32) throw new Error("synthetic transport requires secret >= 32 chars");
  return {
    mode: "synthetic",
    source: "simulator",
    async send({ runId, turnId, actor, chatId, text }) {
      const body = {
        version: 1,
        run_id: runId,
        turn_id: turnId,
        actor_id: actor.id,
        actor_name: actor.name,
        chat_id: chatId,
        text,
        sent_at: Date.now(),
      };
      const canon = JSON.parse(canonicalJson(body));
      const timestamp = String(Date.now());
      const nonce = newNonce();
      const signature = signSimulatorRequest({ secret, timestamp, nonce, body: canon });
      const res = await fetchFn(`${baseUrl.replace(/\/$/, "")}/api/simulator/v1/inject`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-MSTD-Sim-Timestamp": timestamp,
          "X-MSTD-Sim-Nonce": nonce,
          "X-MSTD-Sim-Signature": signature,
        },
        body: JSON.stringify(canon),
      });
      let payload = null;
      try { payload = await res.json(); } catch { /* ignore */ }
      if (!res.ok) {
        return {
          ok: false,
          error: payload?.error ?? `http_${res.status}`,
          source: "simulator",
          platformMessageId: null,
          sentAt: Date.now(),
        };
      }
      return {
        ok: true,
        source: "simulator",
        platformMessageId: payload?.platformMessageId ?? null,
        eventId: payload?.eventId ?? null,
        sentAt: Date.now(),
      };
    },
  };
}
