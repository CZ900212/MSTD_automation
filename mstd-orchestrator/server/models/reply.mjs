// Legacy adapter over the always-available responder.
// New code should call createResponder(...).renderHandoff directly.
// DeepSeek V4 Pro non-thinking is preferred for user-facing text; GPT-5.6 Sol is fallback only.

import { createResponder, responderPrompts } from "./responder.mjs";

// Re-export handoff system helpers so existing scene-lock tests can stay stable via renderReply.
export const SCENE = responderPrompts.scene;

export async function renderReply({
  caller,
  soul = "",
  context = "",
  brief,
  kind = "message",
  stage = "final",
  tone = "",
  deliverKind = "p2p",
  sessionKey = null,
  taskId = null,
  recentConversation = "",
}) {
  const responder = createResponder({ caller, soul });
  return responder.renderHandoff({
    sessionKey,
    taskId,
    brief,
    tone,
    kind,
    stage,
    deliverKind,
    recentConversation: recentConversation || context,
    context,
    soul,
  });
}
