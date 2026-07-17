// per-spawn immutable identity plus an attempt-safe current-turn binding.
import { randomUUID } from "node:crypto";

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

export function createSessionTokenRegistry() {
  // token -> { spawn: frozen server-owned identity, turn: frozen mutable attempt identity|null }
  const byToken = new Map();

  function resolveBinding(token) {
    const entry = byToken.get(token);
    if (!entry) return null;
    return Object.freeze(entry.turn
      ? { ...entry.spawn, ...entry.turn }
      : { ...entry.spawn });
  }

  function bindTurn(token, {
    taskId = null,
    runId,
    dispatchId = null,
    turnId,
    lease,
    executionKey,
  } = {}) {
    const entry = byToken.get(token);
    if (!entry || !nonEmpty(runId) || !nonEmpty(turnId) || !nonEmpty(lease) || !nonEmpty(executionKey)) {
      return false;
    }
    const spawnTaskId = entry.spawn.taskId ?? null;
    const spawnExecutionKey = entry.spawn.residentKey ?? (spawnTaskId ? `task:${spawnTaskId}` : entry.spawn.sessionKey);
    if (spawnTaskId !== (taskId ?? null) || spawnExecutionKey !== executionKey) return false;
    entry.turn = Object.freeze({
      runId,
      ...(dispatchId ? { dispatchId } : {}),
      turnId,
      turnLease: lease,
      executionKey,
    });
    return true;
  }

  function clearTurn(token, { runId, turnId, lease } = {}) {
    const entry = byToken.get(token);
    const turn = entry?.turn;
    if (
      !turn
      || turn.runId !== runId
      || turn.turnId !== turnId
      || turn.turnLease !== lease
    ) {
      return false;
    }
    entry.turn = null;
    return true;
  }

  return {
    issue(sessionKey, binding = {}) {
      const token = randomUUID();
      byToken.set(token, {
        spawn: Object.freeze({ sessionKey, ...binding }),
        turn: null,
      });
      return token;
    },
    // Compatibility API delegates to the authoritative combined binding lookup.
    resolve(token) { return resolveBinding(token)?.sessionKey ?? null; },
    resolveBinding,
    bindTurn,
    clearTurn,
    revoke(token) { if (token) byToken.delete(token); },
  };
}
