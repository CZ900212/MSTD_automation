import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createChatLock } from "./process-owner.mjs";

/**
 * Deterministic director: sole scheduler and stop authority for actor bots.
 * States: created -> validating -> running -> draining -> grading -> passed|failed|aborted
 */
export function createRunner({
  transport,
  scenario,
  chatId,
  resultsDir,
  grader = null,
  improviser = null,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  lockDir = null,
}) {
  const runId = randomUUID();
  let status = "created";
  let abortRequested = false;
  const turnRecords = [];
  const errors = [];
  let consecutiveErrors = 0;
  const lock = lockDir
    ? createChatLock(join(lockDir, `${chatId.replace(/[^a-zA-Z0-9_-]/g, "_")}.lock`))
    : null;

  function requestAbort() {
    abortRequested = true;
  }

  async function run() {
    status = "validating";
    if (!scenario?.turns?.length) throw new Error("scenario has no turns");
    if (!transport) throw new Error("transport required");
    if (!chatId) throw new Error("chatId required");

    if (lock) {
      const acq = lock.tryAcquire({ pid: process.pid, runId });
      if (!acq.ok) throw new Error(`chat lock held by pid=${acq.existing?.pid}`);
    }

    const startedAt = now();
    const { max_turns, max_duration_ms, messages_per_minute } = scenario.limits;
    const minIntervalMs = Math.ceil(60_000 / messages_per_minute);
    let sent = 0;
    status = "running";

    try {
      turnsLoop:
      for (const turn of scenario.turns) {
        if (abortRequested) break;
        if (sent >= max_turns) {
          errors.push({ code: "max_turns" });
          break;
        }
        if (now() - startedAt > max_duration_ms) {
          errors.push({ code: "wall_timeout" });
          break;
        }
        if (consecutiveErrors >= 5) {
          errors.push({ code: "consecutive_errors" });
          break;
        }

        if (turn.burst) {
          const base = now();
          for (const item of turn.burst) {
            // burst 内层同样要复查，否则一条 burst turn 可以突破 max_turns/墙钟一次性打光多条消息
            if (abortRequested) break turnsLoop;
            if (sent >= max_turns) {
              errors.push({ code: "max_turns" });
              break turnsLoop;
            }
            if (now() - startedAt > max_duration_ms) {
              errors.push({ code: "wall_timeout" });
              break turnsLoop;
            }
            const wait = item.at_ms - (now() - base);
            if (wait > 0) await sleep(wait);
            await sendOne({
              turnId: `${turn.id}:${item.actor}:${item.at_ms}`,
              actorId: item.actor,
              text: item.text,
              expected: turn.expect,
              scenarioTurnId: turn.id,
            });
            sent += 1;
            await sleep(minIntervalMs);
          }
        } else {
          if (turn.after_ms) await sleep(turn.after_ms);
          let text = turn.text;
          if (scenario.mode === "improv" && !text && improviser) {
            const actor = scenario.actors.find((a) => a.id === turn.actor);
            text = await improviser.generate({
              actor,
              objective: turn.objective,
              recent: turnRecords.slice(-6).map((r) => r.text).filter(Boolean),
            });
          }
          await sendOne({
            turnId: turn.id,
            actorId: turn.actor,
            text,
            expected: turn.expect,
            scenarioTurnId: turn.id,
          });
          sent += 1;
          await sleep(minIntervalMs);
        }
      }

      status = "draining";
      // brief drain window for in-flight gateway work (C mode)
      await sleep(500);

      status = "grading";
      let grade = null;
      if (grader) {
        grade = await grader.grade({ runId, scenario, turnRecords, chatId });
      }

      const finalStatus = abortRequested
        ? "aborted"
        : (grade && grade.status === "failed") || errors.length
          ? "failed"
          : "passed";
      status = finalStatus;

      const report = {
        runId,
        scenarioId: scenario.id,
        status: finalStatus,
        transport: transport.mode,
        chatId,
        startedAt,
        finishedAt: now(),
        turns: turnRecords,
        errors,
        grade,
      };
      if (resultsDir) {
        const dir = join(resultsDir, runId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
        if (grade?.markdown) writeFileSync(join(dir, "report.md"), grade.markdown);
      }
      return report;
    } finally {
      lock?.release({ pid: process.pid });
    }
  }

  async function sendOne({ turnId, actorId, text, expected, scenarioTurnId }) {
    const actor = scenario.actors.find((a) => a.id === actorId) ?? { id: actorId, name: actorId };
    const rec = {
      runId,
      scenarioId: scenario.id,
      turnId,
      scenarioTurnId,
      actorId,
      text,
      transport: transport.mode,
      platformMessageIds: [],
      sendStartedAt: now(),
      sentAt: null,
      expected: expected ?? null,
      errors: [],
    };
    try {
      const result = await transport.send({
        runId,
        turnId,
        actor,
        chatId,
        text,
        idempotencyKey: `${runId}:${turnId}`,
      });
      rec.sentAt = result.sentAt ?? now();
      if (result.platformMessageId) rec.platformMessageIds.push(result.platformMessageId);
      if (!result.ok) {
        rec.errors.push(result.error ?? "send_failed");
        consecutiveErrors += 1;
      } else {
        consecutiveErrors = 0;
      }
    } catch (e) {
      rec.errors.push(String(e?.message ?? e));
      consecutiveErrors += 1;
    }
    turnRecords.push(rec);
  }

  return {
    runId,
    run,
    requestAbort,
    getStatus: () => status,
    turnRecords,
  };
}
