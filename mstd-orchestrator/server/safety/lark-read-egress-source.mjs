import { larkReadSensitivity } from "./lark-read.mjs";

// 将 lark_read 的源文本登记、敏感度判定与 resident taint 收敛为可独立验证的安全边界。
export function createLarkReadEgressSource({
  verbatimGuard,
  replyEgress,
  onEvent = () => {},
}) {
  if (!verbatimGuard || typeof verbatimGuard.record !== "function") {
    throw new Error("lark-read egress source 需要 verbatimGuard");
  }
  if (!replyEgress || typeof replyEgress.markTainted !== "function") {
    throw new Error("lark-read egress source 需要 replyEgress");
  }

  function record({ sessionKey, op, text, residentKey = null, taskId = null }) {
    // residentKey/taskId must come from server token binding, never model body fields.
    const shingles = verbatimGuard.record(sessionKey, text);
    const sensitivity = larkReadSensitivity(op);
    if (sensitivity === "restricted") {
      const tainted = replyEgress.markTainted(sessionKey, `lark_read:${op}`, { residentKey, taskId });
      if (tainted) {
        onEvent({
          type: "resident_tainted",
          sessionKey,
          residentKey: residentKey ?? null,
          taskId: taskId ?? null,
          detail: `lark_read:${op}`,
        });
      }
    }
    return { ok: true, shingles, sensitivity };
  }

  return { record };
}
