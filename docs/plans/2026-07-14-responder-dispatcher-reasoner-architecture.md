# Responder–Dispatcher–Reasoner Architecture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the session-wide fast/slow routing pipeline with an always-available responder, an independent post-response dispatcher, and task-isolated reasoners that can run concurrently inside one Feishu conversation.

**Architecture:** Keep the system as one Node.js modular monolith. The responder sends the first user-facing message, a separate dispatcher reviews that message without being told the responder requested help, and a coordinator attaches work to an existing task or starts a new task-scoped Pi resident. Reasoner output continues through the reply boundary, but the responder becomes the sole writer of user-facing text.

**Tech Stack:** Node.js 22 · ESM · Vitest · better-sqlite3 · Pi RPC residents · DeepSeek/GPT model chains · Express internal routes · lark-cli outbound

---

## Review Amendments (2026-07-14)

The implementation review was checked against the current tree and incorporated here:

- Migration numbers are 018 for task persistence and 019 for observability because 017_security_quarantine.sql already exists.
- Dispatcher input now includes a byte-bounded recent transcript so short follow-ups can be matched to the correct task.
- Reply provenance migration explicitly includes resident-scoped taint and recycle semantics, with cross-task security tests.
- Reasoner handoff preserves both kind (message/card_copy) and deliverKind (group/p2p).
- Runtime ownership and reply authorization are separate implementation phases with independent green test points.
- The first outbound candidate is durably recorded as pending_send before physical delivery, closing the previously inconsistent send-before-persist sequence through idempotent retry.
- Full E2E acceptance explicitly requires both MSTD_E2E=1 and MSTD_ENABLE_WRITE=1 and must not treat a skipped suite as success.

The proposed ambient zero-cost shortcut is not part of the core migration. Its cost is measured during shadow evaluation; any deterministic shortcut that changes when the responder or dispatcher runs requires a separate owner-approved design change.

## 1. Explored State

The accepted product contract is in project.md. The following implementation paths were inspected:

- Inbound and serialization: mstd-orchestrator/server/gateway/wire.mjs, debounce.mjs, sessions/actor.mjs.
- Current routing and response generation: server/models/triage.mjs, reply.mjs, caller.mjs.
- Reasoner lifecycle: server/models/brain.mjs, sessions/active-turn.mjs.
- Reply authorization and delivery: gateway/reply-pipeline.mjs, safety/reply-egress.mjs, safety/lark-read-egress-source.mjs, http/internal-routes.mjs, pi-ext/reply.ts.
- Async work and reinjection: jobs/background.mjs, background-executor.mjs, reinjector.mjs.
- Persistence and configuration: sessions/store.mjs, db/migrations, config.mjs.
- Existing architecture specifications and the older session-coordinator proposal under docs/superpowers.

Baseline verification:

- Command: cd mstd-orchestrator && npm test -- test/triage.test.mjs test/turn-handler.test.mjs test/brain-concurrency.test.mjs test/active-turn.test.mjs test/active-brain-turn.test.mjs test/business-turn-terminal.test.mjs test/reply-egress.test.mjs test/internal-routes.test.mjs
- Result: 8 test files passed, 202 tests passed.

## 2. Problems Found

### 2.1 The foreground is not actually always available

wire.mjs puts the complete handleTurn promise inside the per-session actor. handleTurn waits for brain.turn to finish. A second message in the same session therefore waits behind the first reasoner instead of reaching the foreground immediately. The current steer branch is unit-tested but cannot normally be reached through the production gateway while the actor is blocked.

### 2.2 Routing and speaking are coupled

triage.mjs asks one fast call to choose quick_reply, no_reply, escalate, or steer and to write the corresponding user text. Code then overrides semantic decisions with broad regular expressions. This is the opposite of the accepted design, where the responder speaks first and an independent reviewer decides whether deeper work is still required.

### 2.3 All reasoner ownership is keyed by session

brain.mjs keys its resident pool, spawn coalescing, turn tails, steer, busy state, and recycle operations by sessionKey. active-turn.mjs also allows one active record per session. This structurally prevents two independent tasks from running in the same conversation.

### 2.4 Reply authorization also assumes one resident per session

reply-egress.mjs keeps one active provenance epoch per sessionKey. Starting a second resident for the same conversation would make the first resident stale. Session tokens bind only the audience session and resident epoch; they do not carry authoritative task ownership.

### 2.5 Reasoner replay is conversation-scoped

brain.mjs replays the whole session summary plus recent transcript into a new resident. Even if the pool were changed to task IDs, this replay would still mix unrelated tasks from the same chat.

### 2.6 Async effects lose task identity

Background jobs, write confirmations, and reinjection carry sessionKey and sometimes sessionVersion, but not a server-owned reasoning task ID. A completion can therefore only return to the conversation, not to the task that created it.

### 2.7 The reply tool is already the right seam

pi-ext/reply.ts does not directly write or send slow-model text. It submits a brief to the daemon, which renders and delivers it. This seam should be retained and renamed conceptually: the reasoner hands facts and decisions to the responder; the responder speaks.

## 3. Target Runtime Contract

### 3.1 Responder result

The responder never requests escalation and never selects a reasoner. Its foreground output is restricted to:

    { "action": "reply", "text": "..." }
    { "action": "no_reply" }

Rules:

- Addressed and private messages normally return reply.
- no_reply remains available for ambient group participation.
- The reply is sent before dispatcher evaluation begins.
- The responder can give a complete answer or an honest provisional response.
- Routing fields such as escalate, task_id, needs_reasoning, or confidence are rejected from this contract.

The same responder role exposes a second internal method for rendering a reasoner handoff:

    renderHandoff({ sessionKey, taskId, brief, tone, kind, deliverKind, recentConversation })

This returns user-facing text but cannot alter task conclusions or add unsupported facts. kind retains the existing message/card_copy distinction, and deliverKind retains the existing group/p2p delivery style. Neither dimension may be inferred from the reasoner brief or silently dropped during the migration.

### 3.2 Dispatcher result

The dispatcher receives:

- The original normalized user message batch.
- The actual responder text that was sent, or an explicit no-reply marker.
- Mode and conversation type.
- A recent user/assistant transcript window preceding the current source batch, newest-first selected and then rendered chronologically, capped by MSTD_DISPATCH_CONTEXT_LINES (default 20) and MSTD_DISPATCH_CONTEXT_BYTES (default 8192). This is context for reference resolution, not a substitute for the original batch or actual responder output.
- A bounded list of active task candidates containing opaque task IDs, titles, short summaries, and status.

It returns exactly one decision:

    {
      "action": "no_reasoning",
      "reason_code": "complete_answer"
    }

    {
      "action": "attach_existing",
      "task_id": "server-supplied-candidate-id",
      "brief": "new information or correction",
      "closure": "required | silent_ok",
      "reason_code": "same_task_update"
    }

    {
      "action": "spawn_new",
      "title": "short task title",
      "brief": "task to reason about",
      "closure": "required | silent_ok",
      "reason_code": "needs_tools"
    }

Contract rules:

- The system prompt describes an independent third-party reviewer.
- It must not say that the responder requested escalation or assistance.
- An attach_existing task ID is accepted only if it was present in the supplied candidate list.
- New task IDs are issued by the server, never by the model.
- The dispatcher does not produce user-facing prose.
- Transcript rendering excludes tool payloads, internal prompts, hidden metadata, and unrelated rows beyond the configured bounds.
- Invalid JSON, unknown fields, invented task IDs, and unsupported enum values fail closed through a deterministic fallback policy.

### 3.3 Task and execution identity

- sessionKey identifies the conversation and authorized audience.
- taskId identifies one logical piece of work inside that conversation.
- runId identifies one reasoner execution for that task.
- residentKey identifies one Pi resident and its reply provenance epoch.
- turnId and lease continue to identify one admitted tool-calling turn.

These identities must not be collapsed into one string in persistent data. Runtime maps may use a derived execution key, but logs and authorization bindings retain the individual fields.

### 3.4 Conditional closure

- closure=required means the run must end with a responder-rendered final, a responder-rendered failure/cancellation notice, or an explicitly recorded cancellation.
- closure=silent_ok means no reply is valid when the reasoner finds no correction, new result, or user-relevant information.
- A progress reply never satisfies required closure.
- A final reply is unique per run, while multiple logical tasks in the same conversation may each produce their own final follow-up.

## 4. Architecture Decisions and Trade-offs

### Keep one daemon, not new services

Use a modular coordinator and SQLite-backed task/outbox state inside the existing daemon. A message broker or microservice split would add operations and recovery complexity without solving a proven scale problem.

### Persist outbound and dispatcher work before each side effect

The responder first produces an outbound candidate. For reply, before physical delivery the daemon creates a durable dispatch row in pending_send with the candidate text and a stable outbound idempotency key. After delivery, one transaction records the responder message and advances the row to pending_review. For no_reply, it creates pending_review directly with an explicit no-reply marker and no outbound key. The dispatcher pump claims only pending_review rows. On restart, pending_send delivery is retried with the same idempotency key; stale running reviews are released and retried idempotently. This prevents a send-success/process-crash gap from silently losing an explicitly promised task or producing an untracked first reply.

### Use task-scoped replay

A task reasoner sees linked task messages, the task summary, memory layers already authorized for the conversation, and explicitly reinjected tool results. It does not receive the entire session transcript by default.

### Preserve deterministic safety gates

Semantic difficulty routing moves out of regular expressions. Write approval, audience authorization, sensitive-content checks, target grants, token binding, and verbatim protection remain deterministic server-side gates.

### Reuse the existing global Pi semaphore

All reasoner residents continue to consume the existing MSTD_MAX_CONCURRENT_PI capacity. Add a separate per-session active-task cap only as a configurable fairness guard; never bypass the global lease.

### Roll out behind modes

Add legacy, shadow, and active modes. legacy preserves the current path. shadow computes responder and dispatcher outcomes without changing outbound or starting task reasoners. active enables the new foreground and coordinator. Rollback is one configuration change and restart.

## 5. Implementation Tasks

### Task 1: Freeze architecture mode and model-chain names

**Files:**

- Modify: mstd-orchestrator/server/config.mjs
- Modify: mstd-orchestrator/server/models/caller.mjs
- Modify: mstd-orchestrator/.env.example
- Test: mstd-orchestrator/test/config.test.mjs
- Test: mstd-orchestrator/test/model-caller.test.mjs

**Steps:**

1. Add failing config tests for MSTD_AGENT_ARCHITECTURE_MODE values legacy, shadow, and active.
2. Add a failing test proving an unknown or blank explicit value is rejected at startup.
3. Implement the config enum with legacy as the migration default.
4. Add responder and dispatcher model-chain names while retaining legacy fast/respond aliases.
5. Add MSTD_DISPATCH_CONTEXT_LINES=20 and MSTD_DISPATCH_CONTEXT_BYTES=8192 defaults and reject non-positive or unsafe values.
6. Add tests proving responder and dispatcher calls are non-thinking and have independent retry/fallback telemetry.
7. Document the mode, context bound, and model overrides in .env.example.
8. Run: npm test -- test/config.test.mjs test/model-caller.test.mjs.
9. Commit: feat(agent): add responder architecture modes.

### Task 2: Build the responder as the single public voice

**Files:**

- Create: mstd-orchestrator/server/models/responder.mjs
- Modify: mstd-orchestrator/server/models/reply.mjs
- Modify: mstd-orchestrator/server/index.mjs
- Test: mstd-orchestrator/test/responder.test.mjs
- Test: mstd-orchestrator/test/reply.test.mjs
- Test: mstd-orchestrator/test/e2e-persona.test.mjs

**Steps:**

1. Add failing parser tests for reply and no_reply only.
2. Add rejection tests for escalate, steer, task_id, needs_reasoning, additional keys, multiple JSON objects, and fenced mixed output.
3. Add prompt-shape tests proving SOUL is present and internal architecture is not disclosed.
4. Add addressed/private tests requiring a non-empty reply; retain ambient no_reply.
5. Add identity and capability fixtures proving the responder can answer directly from SOUL.
6. Implement answerTurn with a strict schema and a safe addressed fallback.
7. Add failing renderHandoff tests that provide a reasoning brief and forbid unsupported factual additions.
8. Add matrix tests preserving kind=message/card_copy and deliverKind=group/p2p, including the confirmed-card copy path.
9. Move the existing reply rendering prompt into responder.renderHandoff while retaining the old renderReply adapter for legacy mode.
10. Route both methods through the responder chain and record usage through the existing budget.
11. Run: npm test -- test/responder.test.mjs test/reply.test.mjs test/e2e-persona.test.mjs.
12. Commit: feat(agent): introduce the always-available responder.

### Task 3: Build the independent dispatcher

**Files:**

- Create: mstd-orchestrator/server/models/dispatcher.mjs
- Create: mstd-orchestrator/test/dispatcher.test.mjs
- Create: mstd-orchestrator/test/fixtures/dispatcher-cases.json
- Modify: mstd-orchestrator/server/models/model-log.mjs

**Steps:**

1. Add fixture cases for complete identity answers, greetings, complete factual answers, promises to check, tool-required work, advice, corrections, unrelated simultaneous tasks, and context-dependent follow-ups such as “对，改成周五”.
2. Add prompt tests proving the dispatcher is described as an independent reviewer.
3. Add a negative prompt test proving the system prompt does not contain wording equivalent to “the responder requested escalation”.
4. Add strict parser tests for no_reasoning, attach_existing, and spawn_new.
5. Add tests rejecting task IDs not present in activeTaskCandidates.
6. Add tests proving the dispatcher receives original user text and actual sent reply, not the responder's hidden metadata.
7. Add bounded-transcript tests proving recent user/assistant rows resolve short references, preserve chronological order, obey line and byte caps, and exclude tool/internal payloads.
8. Add a bounded task-candidate renderer that exposes title, summary, status, and opaque ID only.
9. Implement the owner-confirmed deterministic failure fallback. Proposed default: addressed/private defaults to spawn_new with silent_ok closure; ambient defaults to no_reasoning.
10. Emit dispatcher_started, dispatcher_decision, dispatcher_invalid, and dispatcher_fallback events with latency and reason code.
11. Run: npm test -- test/dispatcher.test.mjs test/model-log.test.mjs.
12. Commit: feat(agent): add independent post-response dispatcher.

### Task 4: Add durable task and dispatch persistence

**Files:**

- Create: mstd-orchestrator/server/db/migrations/018_reasoning_tasks.sql
- Create: mstd-orchestrator/server/reasoning/task-store.mjs
- Create: mstd-orchestrator/test/reasoning-task-store.test.mjs
- Modify: mstd-orchestrator/server/db/index.mjs

**Schema:**

- reasoning_tasks: id, session_id, title, summary, status, closure_mode, created_at, updated_at, completed_at.
- reasoning_task_messages: task_id, message_id, relation, created_at, unique task/message/relation.
- reasoning_dispatches: id, session_id, source_message_ids_json, responder_message_id nullable, responder_action, responder_text nullable, outbound_idempotency_key nullable, mode, status, verdict_json, attempts, created_at, updated_at, unique source batch identity and unique non-null outbound idempotency key. Checks require text/key for reply and forbid them for no_reply. Status covers pending_send, pending_review, running, done, and failed.

**Steps:**

1. Add a failing migration-shape test for all columns, foreign keys, indexes, and status checks.
2. Add failing store tests for createDispatch idempotency and stable outbound idempotency keys.
3. Add state-transition tests for reply (pending_send -> pending_review -> running -> done/failed) and no_reply (pending_review -> running -> done/failed); dispatcher claims must reject pending_send.
4. Add retry/recovery tests for pending_send delivery and stale running reviews after restart.
5. Add task creation tests proving IDs are server-issued.
6. Add attach tests proving a message cannot attach to a task from another session.
7. Add active-summary tests with a strict result count and byte budget.
8. Add task transition tests for active, completed, failed, and cancelled.
9. Implement the migration and store transactionally, including one post-send operation that records responder_message_id and advances to pending_review.
10. Confirm whether migration discovery is automatic; touch server/db/index.mjs only if the current loader requires explicit registration.
11. Run: npm test -- test/reasoning-task-store.test.mjs test/db.test.mjs.
12. Commit: feat(agent): persist dispatcher and reasoning tasks.

### Task 5: Make reasoner runtime ownership task-scoped

**Files:**

- Modify: mstd-orchestrator/server/models/brain.mjs
- Modify: mstd-orchestrator/server/sessions/active-turn.mjs
- Modify: mstd-orchestrator/server/index.mjs
- Test: mstd-orchestrator/test/brain-concurrency.test.mjs
- Test: mstd-orchestrator/test/active-turn.test.mjs
- Test: mstd-orchestrator/test/active-brain-turn.test.mjs

**Steps:**

1. Add a failing brain test with two task IDs in one session; both Pi residents must enter runJob before either completes.
2. Add a same-task test proving turns still serialize and steer targets only that task.
3. Add a test proving task A cannot steer, recycle, or close task B.
4. Refactor brain pool, spawning, turn tails, busy checks, steer, and recycle to use taskId/residentKey while retaining sessionKey as audience metadata.
5. Introduce a task-context provider seam in place of hard-coded full-session replay; retain a legacy adapter until Task 7 supplies the task-scoped implementation.
6. Add failing active-turn tests for two execution records sharing one sessionKey.
7. Refactor active-turn maps to use runId or executionKey and store sessionKey/taskId/residentKey as immutable metadata.
8. Run: npm test -- test/brain-concurrency.test.mjs test/active-turn.test.mjs test/active-brain-turn.test.mjs.
9. Commit: refactor(agent): scope reasoner runtime by task.

### Task 6: Make reply authorization and egress resident-scoped

**Files:**

- Modify: mstd-orchestrator/server/http/session-tokens.mjs
- Modify: mstd-orchestrator/server/safety/reply-egress.mjs
- Modify: mstd-orchestrator/server/safety/lark-read-egress-source.mjs
- Modify: mstd-orchestrator/server/http/internal-routes.mjs
- Modify: mstd-orchestrator/server/gateway/reply-pipeline.mjs
- Modify: mstd-orchestrator/server/index.mjs
- Test: mstd-orchestrator/test/internal-routes.test.mjs
- Test: mstd-orchestrator/test/reply-egress.test.mjs
- Test: mstd-orchestrator/test/lark-read-egress-source.test.mjs
- Test: mstd-orchestrator/test/business-turn-terminal.test.mjs

**Steps:**

1. Add taskId, runId, and residentKey to server-issued session-token bindings while retaining sessionKey as the authorized audience.
2. Add failing provenance tests proving two residents in one session have independent active epochs and neither activation invalidates the other.
3. Refactor reply-egress active, epoch, and taint maps to use residentKey; all audience checks continue to use sessionKey.
4. Add security tests proving taint on task A's resident does not affect task B's resident in the same session, while A remains tainted with its original reasons.
5. Add recycle tests proving recycling A rotates only A's epoch and expires A's old epoch-bound taint; B's epoch and taint state remain unchanged.
6. Make lark-read taint attribution resolve the authoritative residentKey from the server token/binding, never from model-supplied body fields.
7. Pass authoritative task/run/resident identity from token binding through internal-routes to reply-pipeline.
8. Add a test proving a forged body task ID or resident key is ignored or rejected.
9. Add a test proving both concurrent reasoners can deliver one final reply each without stale-resident rejection.
10. Run: npm test -- test/internal-routes.test.mjs test/reply-egress.test.mjs test/lark-read-egress-source.test.mjs test/business-turn-terminal.test.mjs.
11. Commit: refactor(agent): scope reply authorization by resident.

### Task 7: Add the dispatcher coordinator and task-scoped context

**Files:**

- Create: mstd-orchestrator/server/reasoning/coordinator.mjs
- Create: mstd-orchestrator/server/reasoning/task-context.mjs
- Create: mstd-orchestrator/test/reasoning-coordinator.test.mjs
- Create: mstd-orchestrator/test/task-context.test.mjs
- Modify: mstd-orchestrator/server/config.mjs
- Modify: mstd-orchestrator/server/sessions/store.mjs
- Modify: mstd-orchestrator/server/index.mjs
- Modify: mstd-orchestrator/.env.example
- Test: mstd-orchestrator/test/config.test.mjs

**Steps:**

1. Add a failing no_reasoning test proving no task or Pi resident is created.
2. Add a spawn_new test proving the server creates a task, links source messages, and starts one reasoner run.
3. Add an attach_existing test proving related input is linked and steered into the selected busy task.
4. Add an idle-existing-task test proving a new run starts on the same task rather than creating a new task.
5. Add a simultaneous-unrelated-task test proving two task residents can run concurrently in one session.
6. Add a fabricated-task-ID test proving the coordinator refuses cross-session or absent candidates.
7. Add task-context tests proving task A receives only its linked messages, task summary, authorized memory, and explicit tool results.
8. Add negative tests proving unrelated session transcript lines are absent.
9. Implement a durable dispatch pump that claims pending_review rows, calls the dispatcher with bounded recent transcript and task candidates, persists the verdict, and schedules work.
10. Return from schedule immediately; catch and record background promise failures so no unhandled rejection occurs.
11. On daemon boot, release stale claims and resume pending dispatches.
12. Reuse the global Pi semaphore and, after owner confirmation, add MSTD_MAX_REASONERS_PER_SESSION=3 as a documented and validated fairness cap.
13. Queue excess tasks without merging their contexts.
14. Run: npm test -- test/reasoning-coordinator.test.mjs test/task-context.test.mjs test/session-store.test.mjs test/config.test.mjs.
15. Commit: feat(agent): coordinate task-isolated reasoners.

### Task 8: Replace foreground triage with responder-first delivery

**Files:**

- Modify: mstd-orchestrator/server/gateway/turn-handler.mjs
- Modify: mstd-orchestrator/server/gateway/wire.mjs
- Modify: mstd-orchestrator/server/sessions/actor.mjs
- Modify: mstd-orchestrator/server/index.mjs
- Test: mstd-orchestrator/test/turn-handler.test.mjs
- Test: mstd-orchestrator/test/gateway-consumer.test.mjs
- Test: mstd-orchestrator/test/ambient-gate.test.mjs
- Test: mstd-orchestrator/test/e2e-p2p.test.mjs

**Steps:**

1. Add a failing ordering test: pending_send persistence completes before physical send, and physical send completes before dispatcher review begins.
2. Add a blocked-reasoner test: while task A is running, a new user message reaches the responder and is sent without waiting.
3. Add an actor test proving the actor protects only transcript/outbox state transitions, not the lifetime of a reasoner promise.
4. Add a private identity test proving one immediate responder answer and no mandatory reasoner.
5. Add a promise-to-check test proving the first answer is sent and a dispatch with the owner-confirmed closure mode is scheduled.
6. Add ambient no_reply tests proving no unsolicited first message while dispatcher policy remains explicit.
7. Implement the active-mode sequence: append user messages and call responder; for reply, persist pending_send with responder text and a stable outbound idempotency key, deliver with that key, then transactionally append the assistant message and advance to pending_review; for no_reply, persist pending_review with the explicit marker; schedule the coordinator only after pending_review exists, then return.
8. Add a crash-recovery test for physical-send success followed by process failure before pending_review: restart retries the same outbound idempotency key, produces no duplicate user-visible message, and preserves dispatcher work.
9. Preserve legacy behavior unchanged when mode=legacy.
10. In shadow mode, execute responder and dispatcher without changing physical outbound, transcript, task store, or reasoner scheduling.
11. Move memory nudge and compaction triggers outside the foreground actor so they cannot delay later responder turns.
12. Retain deterministic budget, audience, Markdown, rate-limit, and outbound gates.
13. Run the four focused suites listed above.
14. Commit: feat(agent): make responder foreground non-blocking.

### Task 9: Complete reply handoff and propagate task identity through tools

**Files:**

- Modify: mstd-orchestrator/pi-ext/reply.ts
- Modify: mstd-orchestrator/server/gateway/reply-pipeline.mjs
- Modify: mstd-orchestrator/server/http/internal-routes.mjs
- Modify: mstd-orchestrator/server/jobs/background.mjs
- Modify: mstd-orchestrator/server/jobs/reinjector.mjs
- Modify: mstd-orchestrator/server/cards/confirm-flow.mjs
- Modify: mstd-orchestrator/server/index.mjs
- Test: mstd-orchestrator/test/reply.test.mjs
- Test: mstd-orchestrator/test/business-turn-terminal.test.mjs
- Test: mstd-orchestrator/test/background-job.test.mjs
- Test: mstd-orchestrator/test/reinject.test.mjs
- Test: mstd-orchestrator/test/card-execute.test.mjs

**Steps:**

1. Change reply tool copy from an Opus/direct-output concept to “submit facts and decisions to the responder”.
2. Add a test proving reasoner finalText never reaches outbound.
3. Route reply briefs through responder.renderHandoff and preserve authoritative kind and deliverKind values plus all pre/post egress checks.
4. Add required-closure tests: no final reply produces one responder-rendered failure closure, not raw daemon/model text.
5. Add silent_ok tests: no final reply closes the run without a duplicate message or fallback.
6. Keep progress non-terminal and enforce one final per run.
7. Add authoritative taskId to spawn_background_job using the internal token binding, not model parameters.
8. Persist taskId with background-job metadata and reinject completion into that task.
9. Carry taskId through propose_actions and confirmed execution results so write outcomes return to the originating task.
10. Add card_copy tests proving confirm-flow retains kind=card_copy and the original group/p2p deliverKind when rendering the handoff.
11. Add tests proving two task completions in one session cannot swap destinations or context.
12. Add restart/retry tests proving an already delivered task final is not sent twice.
13. Run the five focused suites listed above.
14. Commit: feat(agent): route task results through the responder.

### Task 10: Add task-aware observability and update architecture documentation

**Files:**

- Create: mstd-orchestrator/server/db/migrations/019_reasoning_observability.sql
- Modify: mstd-orchestrator/server/models/model-log.mjs
- Modify: mstd-orchestrator/server/http/admin-routes.mjs
- Modify: mstd-orchestrator/README.md
- Modify: project.md
- Modify: docs/superpowers/specs/2026-07-09-feishu-resident-agent.md
- Modify: docs/superpowers/specs/2026-07-10-agent-persona-prompt-design.md
- Test: mstd-orchestrator/test/model-log.test.mjs
- Test: mstd-orchestrator/test/admin-routes.test.mjs

**Steps:**

1. Add task_id, dispatch_id, run_id, decision, reason_code, and latency fields to model observability.
2. Add indexes for session/task/time and dispatch decision/time.
3. Emit responder_sent, dispatcher_decision, task_created, task_attached, reasoner_started, reasoner_completed, handoff_sent, silent_closed, and task_failed.
4. Add admin filters for taskId and dispatch decision.
5. Add an event-sequence test covering first reply, dispatch, task start, and responder-rendered follow-up.
6. Mark the old V4/5.5/Opus and one-resident-per-session sections as superseded, linking to project.md and this plan.
7. Document the three rollout modes, task isolation, and rollback procedure in README.
8. Run: npm test -- test/model-log.test.mjs test/admin-routes.test.mjs.
9. Commit: docs(agent): document task-isolated responder architecture.

### Task 11: Shadow evaluation, canary, activation, and cleanup

**Files:**

- Create: mstd-orchestrator/scripts/dispatcher-eval.mjs
- Create: mstd-orchestrator/test/dispatcher-eval.test.mjs
- Modify: mstd-orchestrator/test/fixtures/dispatcher-cases.json
- Modify: mstd-orchestrator/test/e2e-persona.test.mjs
- Modify: mstd-orchestrator/test/e2e-full.test.mjs
- Later remove: mstd-orchestrator/server/models/triage.mjs after rollback window
- Later modify: legacy triage tests after rollback window

**Steps:**

1. Build a fixture evaluator that records responder output, dispatcher verdict, selected task, and expected labels without sending messages.
2. Include identity, capability, greeting, factual, advice, tool, write, multi-topic, short context-dependent follow-up, correction, ambient, and prompt-injection cases.
3. Add structural gates: zero invented task IDs accepted, zero cross-task context lines, zero reasoner raw text outbound, and one final maximum per run.
4. Run the complete unit suite: npm test.
5. Harden e2e-full startup so MSTD_E2E=1 with MSTD_ENABLE_WRITE missing fails loudly instead of skipping; an intentionally local run with neither flag may still skip.
6. Run full acceptance with MSTD_E2E=1 MSTD_ENABLE_WRITE=1 npm test -- test/e2e-full.test.mjs, and require executed/passed tests with zero environment-gated skips before treating it as green.
7. Deploy shadow mode and collect decision/latency/model-call volume data without changing user behavior.
8. Review false attach, false spawn, missed reasoning, dispatcher parse failure, responder latency, and ambient model cost samples with the project owner.
9. If ambient cost warrants optimization, write a separate owner-confirmed proposal limited to exact deterministic cases; it must not use broad semantic regexes, suppress substantive dispatcher review, or alter this migration implicitly.
10. Enable active mode for private/admin canary sessions only.
11. Verify on real representative input that the first response arrives while a reasoner remains blocked.
12. Verify two unrelated tasks in one chat run under different task IDs and return to the correct topic.
13. Expand active mode to private chats, then addressed groups, then ambient groups.
14. Roll back to legacy immediately on cross-task leakage, lost required closure, write-authorization regression, or reply provenance mismatch.
15. After an agreed rollback window, remove legacy triage routing, old route guards, legacy chain aliases, and obsolete tests in a separate commit.
16. Commit: refactor(agent): retire legacy fast-slow routing.

## 6. Verification Matrix

| Invariant | Test level | Required evidence |
|---|---|---|
| First reply does not wait for reasoner | Unit + E2E | Responder send completes while blocked reasoner promise remains pending |
| Dispatcher is independent and context-aware | Prompt shape + fixture | No “responder requested” wording; user text, sent reply, bounded recent transcript, and bounded task candidates only |
| Same task stays coherent | Unit | Related input attaches to the selected task and reaches only its resident |
| Different tasks stay isolated | Unit + E2E | Two task IDs, two residents, no cross-task replay |
| Concurrent same-session replies remain authorized | Security unit | Independent resident epochs; both valid, neither invalidates the other |
| Taint remains task-isolated | Security unit | Taint and recycle affect only the authoritative residentKey; A cannot taint or clear B |
| Reasoner never speaks directly | Unit | finalText absent from outbound; reply always passes responder and egress gates |
| Conditional closure works | Unit | required gets final/failure/cancel; silent_ok can close without message |
| First response survives crash boundaries | Integration | pending_send exists before send; stable idempotency key prevents duplicate send and review resumes |
| Write safety is unchanged | Integration | Existing action/hash/operator/idempotency suites remain green |
| E2E acceptance is real | E2E preflight | MSTD_E2E=1 and MSTD_ENABLE_WRITE=1; environment-gated skip cannot be reported as green |
| Rollback is safe | Config integration | legacy mode uses the current path with unchanged output contracts |

## 7. Rollback Strategy

- Keep legacy modules and schema readable through the shadow and canary periods.
- Switching MSTD_AGENT_ARCHITECTURE_MODE back to legacy must stop new dispatch claims and new task reasoners while allowing already running tasks to finish or time out safely.
- Database migrations are additive; rollback does not drop task or dispatch history.
- Do not reuse task-scoped tokens or provenance in the legacy path.
- Legacy removal is a separate phase after production review, never part of the initial activation commit.

## 8. Explicit Non-goals

- Do not weaken write confirmation, target grants, memory authorization, DLP, prompt-injection checks, or verbatim guards.
- Do not expose internal model names or routing architecture to users.
- Do not introduce a message broker, microservice, or distributed task system.
- Do not solve the separate persistent-memory cleanup project in this migration.
- Do not automatically merge different tasks because they share one Feishu conversation.

## 9. Defaults Requiring Owner Confirmation Before Implementation

This plan proposes these defaults but implementation must not begin until they are confirmed:

1. Dispatcher failure: addressed/private falls back to spawn_new with silent_ok closure; ambient falls back to no_reasoning. This favors avoiding a guaranteed mechanical second reply during dispatcher parse/provider failure while still allowing the reasoner to correct or complete a real promise.
2. Fairness: reuse global MSTD_MAX_CONCURRENT_PI and add MSTD_MAX_REASONERS_PER_SESSION=3.
3. Cancellation: no automatic cancellation on topic change; different tasks continue independently. Explicit “stop/cancel” semantics require a follow-up decision before active-mode rollout.
