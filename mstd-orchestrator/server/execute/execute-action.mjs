import { buildWriteArgs } from "../safety/write-args.mjs";
import { markStatus } from "../safety/action-store.mjs";
import { assertTestTarget } from "./write-target.mjs";

export function loadApprovedHashes(db, jobId) {
  const row = db.prepare(
    `SELECT approved_action_keys_json FROM decisions WHERE job_id = ? AND decision = 'approve' ORDER BY ts DESC LIMIT 1`
  ).get(jobId);
  const map = new Map();
  if (!row || !row.approved_action_keys_json) return map;
  try {
    for (const e of JSON.parse(row.approved_action_keys_json)) {
      if (e && e.action_key) map.set(e.action_key, e.payload_hash);
    }
  } catch { /* 空 map = 无批准记录 */ }
  return map;
}

export async function executeApprovedAction(db, { actionId, approvedHash, runLark, testTarget, now = Date.now() }) {
  const action = db.prepare(`SELECT * FROM job_actions WHERE id = ?`).get(actionId);
  if (!action) return { ok: false, reason: "unknown action", status: "unknown" };
  if (action.status === "succeeded") return { ok: true, status: "succeeded" };

  const payload = JSON.parse(action.canonical_payload_json);

  if (approvedHash != null && action.payload_hash !== approvedHash) {
    markStatus(db, action.id, "failed", JSON.stringify({ error: "hash_mismatch", now }));
    return { ok: false, reason: "hash_mismatch", status: "failed" };
  }

  try {
    assertTestTarget({ kind: action.kind, payload }, testTarget);
  } catch (e) {
    markStatus(db, action.id, "failed", JSON.stringify({ error: String(e.message || e) }));
    return { ok: false, reason: "non_test_target", status: "failed" };
  }

  let argv;
  try {
    argv = buildWriteArgs({ kind: action.kind, payload }, action.idempotency_key);
  } catch (e) {
    markStatus(db, action.id, "failed", JSON.stringify({ error: String(e.message || e) }));
    return { ok: false, reason: "build_args_rejected", status: "failed" };
  }

  const dry = await runLark([...argv, "--dry-run"]);
  if (dry.exitCode !== 0) {
    markStatus(db, action.id, "failed", JSON.stringify({ error: "dry_run_failed", stderr: dry.stderr }));
    return { ok: false, reason: "dry_run_failed", status: "failed" };
  }

  markStatus(db, action.id, "executing");
  const res = await runLark(argv);
  if (res.exitCode === 0) {
    markStatus(db, action.id, "succeeded", JSON.stringify({ stdout: res.stdout }));
    return { ok: true, status: "succeeded" };
  }
  markStatus(db, action.id, "failed", JSON.stringify({ error: "exec_failed", exitCode: res.exitCode, stderr: res.stderr }));
  return { ok: false, reason: "exec_failed", status: "failed" };
}

export async function reconcileAction(db, { action, runLark }) {
  const res = await runLark(["task", "+list", "--as", "user"]);
  let found = false;
  try {
    const parsed = JSON.parse(res.stdout || "{}");
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    found = items.some((it) => it && it.idempotency_key === action.idempotency_key);
  } catch { found = false; }
  if (found) { markStatus(db, action.id, "succeeded", JSON.stringify({ reconciled: true })); return { reconciled: true }; }
  return { reconciled: false };
}
