export function createDebugTurn({ actors, agentStore, handleTurn }) {
  return function debugTurn({ debugId, text, operator }) {
    const sessionKey = `debug:${debugId}`;
    return actors.enqueue(sessionKey, async () => {
      const session = agentStore.getOrCreate(sessionKey, { kind: "debug", title: `[debug] ${operator}` });
      await handleTurn({
        kind: "message",
        session,
        sessionKey,
        items: [{ content: text, senderOpenId: operator, senderName: "管理员", ts: Date.now() }],
        mode: "addressed",
      });
      return { ok: true, sessionId: session.id };
    });
  };
}
