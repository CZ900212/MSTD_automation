import { randomUUID } from "node:crypto";

const DAY = 86_400_000;
const dayOf = (ts) => Math.floor(ts / DAY);

export function createBudget(db, { dailyLimit, sessionLimit, onExceed = () => {} }) {
  const insert = db.prepare(
    "INSERT INTO token_usage (id, session_key, tokens, day, ts) VALUES (?, ?, ?, ?, ?)"
  );
  const sumSession = db.prepare(
    "SELECT COALESCE(SUM(tokens), 0) AS n FROM token_usage WHERE session_key = ? AND day = ?"
  );
  const sumDaily = db.prepare(
    "SELECT COALESCE(SUM(tokens), 0) AS n FROM token_usage WHERE day = ?"
  );

  function record(sessionKey, usage, now = Date.now()) {
    const tokens = usage?.total_tokens
      ?? (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0);
    if (!tokens) return;
    insert.run(randomUUID(), sessionKey, tokens, dayOf(now), now);
  }

  function allow(sessionKey, now = Date.now()) {
    const day = dayOf(now);
    if (sessionLimit && sumSession.get(sessionKey, day).n >= sessionLimit) {
      const verdict = { ok: false, scope: "session" };
      onExceed({ scope: "session", sessionKey });
      return verdict;
    }
    if (dailyLimit && sumDaily.get(day).n >= dailyLimit) {
      onExceed({ scope: "daily", sessionKey });
      return { ok: false, scope: "daily" };
    }
    return { ok: true };
  }

  return { record, allow };
}
