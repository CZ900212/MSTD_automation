# Resident Agent Security and Reliability Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all reported P0/P1 security and reliability defects while retaining accurate code-assisted computation through an isolated container tool.

**Architecture:** Pi remains an untrusted reasoning process. It receives only explicitly allowlisted extension tools; host filesystem and shell tools stay disabled. Stateful effects, session coordination, approvals, and memory persistence remain authoritative in the Node daemon, with durable SQLite records for replay and recovery.

**Tech Stack:** Node.js 22 ESM, TypeScript Pi extensions, Express, better-sqlite3, Vitest, React/Vite, Docker sandbox runtime.

## Global Constraints

- Never expose Pi built-in `bash`, `read`, `write`, or `edit` to resident or readonly processes.
- Resident tools are `reply,memory,session_search,propose_actions,spawn_background_job`; append `sandbox_exec` only when its feature flag and health check pass.
- Readonly job tools are exactly `lark_read,draft_zh`.
- Disable Pi project approval, extension discovery, skills, prompt templates, themes, and context files on every RPC process.
- `sandbox_exec` never falls back to host execution; Docker unavailable means the tool is not registered.
- Sandbox limits are 10 seconds, 1 CPU, 256 MiB memory, 32 processes, 32 KiB code, 1 MiB stdin, 64 KiB combined output, and three calls per turn.
- Reply delivery is always the current logical session; cross-session delivery uses server-owned jobs or approved action DSL only.
- Every model-authored persistent memory write passes authorization, injection scanning, redaction, size limits, and drift detection.
- Only one `brain.turn()` may drive a session instance at a time; every ingress path uses the same coordinator.
- Default `MSTD_MAX_CONCURRENT_PI=2` remains unchanged.
- Database migrations preserve existing data and run through the current ordered migration mechanism.
- Follow strict TDD: add a focused failing regression test, observe the expected failure, implement minimally, then run focused and full suites.
- Do not use Playwright. UI verification uses the Browser plugin.
- Do not stop an existing dev server or event consumer; live E2E runs only when the shared test application is already free.

---

### Task 1: Harden Pi Process Profiles and Readonly File Access

**Files:**
- Modify: `mstd-orchestrator/supervisor/pi-client.mjs`
- Modify: `mstd-orchestrator/server/pi/rpc-protocol.mjs`
- Modify: `mstd-orchestrator/server/index.mjs`
- Modify: `mstd-orchestrator/server/jobs/orchestrator.mjs`
- Modify: `mstd-orchestrator/pi-ext/lark-read.ts`
- Delete: `mstd-orchestrator/pi-ext/lark.ts`
- Test: `mstd-orchestrator/test/pi-client.test.mjs`
- Test: `mstd-orchestrator/test/pi-rpc-protocol.test.mjs`
- Test: `mstd-orchestrator/test/lark-read-extension.test.mjs`

**Interfaces:**
- Produces: `buildPiArgs({ provider, model, extensions, thinking, tools }) -> string[]` exported from `pi-client.mjs`.
- Produces: `startPi({ ..., tools = [] })`; an empty list emits `--no-tools`, otherwise emits `--no-builtin-tools --tools <comma-list>`.
- Produces: readonly `read_file` that requires `MSTD_JOB_WORKDIR` and rejects realpath escape.

- [ ] **Step 1: Add failing Pi argument tests** asserting all discovery/context flags, absence of `-a`, zero-tool default, exact resident/readonly allowlists, and explicit extension loading.
- [ ] **Step 2: Run `npx vitest run test/pi-client.test.mjs`** and confirm failure because `buildPiArgs` and hardened flags do not exist.
- [ ] **Step 3: Implement `buildPiArgs` and route `startPi` through it** using `--no-approve --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files`; keep explicit `-e` paths functional.
- [ ] **Step 4: Replace wildcard environment forwarding** with explicit `PATH,HOME,LANG,TZ,CZ_GPT_KEY,CZ_CLAUDE_KEY,DEEPSEEK_KEY,LARK_PROFILE,PI_TELEMETRY,PI_SKIP_VERSION_CHECK`, plus explicit overrides.
- [ ] **Step 5: Pass exact tools from resident and readonly call sites** and remove `lark-read.ts` from resident extensions.
- [ ] **Step 6: Add failing readonly filesystem tests** for missing workdir, `..`, and a symlink pointing outside the job directory.
- [ ] **Step 7: Implement fail-closed realpath confinement** without `process.cwd()` fallback and delete the unused unrestricted `lark.ts` extension.
- [ ] **Step 8: Run focused tests and `npm test`**, then commit `fix(mstd): harden Pi tools and readonly workspace access`.

### Task 2: Add Container-Isolated Code Execution

**Files:**
- Create: `mstd-orchestrator/sandbox/Dockerfile`
- Create: `mstd-orchestrator/sandbox/.dockerignore`
- Create: `mstd-orchestrator/server/sandbox/runner.mjs`
- Create: `mstd-orchestrator/pi-ext/sandbox-exec.ts`
- Modify: `mstd-orchestrator/server/config.mjs`
- Modify: `mstd-orchestrator/server/http/internal-routes.mjs`
- Modify: `mstd-orchestrator/server/index.mjs`
- Modify: `mstd-orchestrator/.env.example`
- Test: `mstd-orchestrator/test/sandbox-runner.test.mjs`
- Test: `mstd-orchestrator/test/sandbox-route.test.mjs`

**Interfaces:**
- Produces: `createSandboxRunner({ spawnFn, image, timeoutMs, maxCodeBytes, maxInputBytes, maxOutputBytes })` with `health()` and `run({ runtime, code, stdin })`.
- Produces: `POST /internal/sandbox-exec` accepting only `{session_key,runtime,code,stdin?}`.
- Produces: env settings `MSTD_ENABLE_SANDBOX_EXEC`, `MSTD_SANDBOX_IMAGE`, `MSTD_SANDBOX_TIMEOUT_MS`.

- [ ] **Step 1: Add failing runner tests** that capture Docker argv and assert fixed image, no network, read-only rootfs, dropped capabilities, non-root user, resource limits, readonly work mount, and hardcoded runtime commands.
- [ ] **Step 2: Verify RED** with `npx vitest run test/sandbox-runner.test.mjs`.
- [ ] **Step 3: Implement the runner without a shell** using `spawn("docker", args)`, a mode `0700` temporary directory, generated `main.js/main.py/main.sh`, bounded stdout/stderr, timeout cleanup via `docker rm -f`, and unconditional temp deletion.
- [ ] **Step 4: Add route and extension tests** for invalid runtime, oversized code/input, per-turn maximum of three calls, unavailable daemon, and clipped output.
- [ ] **Step 5: Implement the internal route and Pi extension**; register the extension/tool only when the flag is on and `health()` succeeds.
- [ ] **Step 6: Add a pinned sandbox image definition** based on `node:22-bookworm-slim` resolved to a committed digest, with Python 3, bash, coreutils, jq, a non-root runtime user, no lark-cli/git/ssh/package-manager entrypoint, and no host credentials.
- [ ] **Step 7: With Docker daemon available, run representative Node/Python/bash calculations and negative network/host-file probes**; if the daemon is unavailable, keep automated argv/health tests green and report live sandbox verification as blocked without enabling the tool.
- [ ] **Step 8: Run focused tests and `npm test`**, then commit `feat(mstd): add container-isolated code execution`.

### Task 3: Bind Replies and Confirmation Cards to Authoritative Context

**Files:**
- Modify: `mstd-orchestrator/pi-ext/reply.ts`
- Modify: `mstd-orchestrator/server/http/internal-routes.mjs`
- Modify: `mstd-orchestrator/server/gateway/turn-handler.mjs`
- Create: `mstd-orchestrator/server/db/migrations/012_confirmation_integrity.sql`
- Modify: `mstd-orchestrator/server/cards/confirm-flow.mjs`
- Modify: `mstd-orchestrator/server/cards/templates.mjs`
- Modify: `mstd-orchestrator/server/safety/approval.mjs`
- Test: `mstd-orchestrator/test/turn-handler.test.mjs`
- Test: `mstd-orchestrator/test/card-callback.test.mjs`
- Test: `mstd-orchestrator/test/confirm-flow.test.mjs`

**Interfaces:**
- Removes: `target` from the reply tool and internal reply handler.
- Produces: card rows with immutable `action_snapshot_json` and `snapshot_hash`; approval tokens with `context_hash`.
- Produces: approval decisions containing exact `{action_key,payload_hash}` entries used by execution.

- [ ] **Step 1: Add failing cross-session reply tests** proving a supplied `target` is rejected and outbound always receives the current session destination.
- [ ] **Step 2: Remove `target` end-to-end** and make `/internal/reply` return HTTP 400 when a legacy body supplies it.
- [ ] **Step 3: Add the confirmation migration** with snapshot, decision, execution result/timestamps, and reinjection columns; add token context binding.
- [ ] **Step 4: Add failing tamper tests**: issue a card, mutate `job_actions`, submit the original callback, assert no token consumption, no `runLark`, and a hash-mismatch response.
- [ ] **Step 5: Render deterministic canonical action summaries** in fixed card elements; Opus text remains introductory copy only, and button values include `snapshot_ref`.
- [ ] **Step 6: Split token verification from consumption** and implement a single SQLite transaction that conditionally consumes the token, applies validated form data to the frozen snapshot, records `decisions`, and marks job/card executing.
- [ ] **Step 7: Make execution load approved hashes from the decision record** instead of passing current row hashes as approval input.
- [ ] **Step 8: Run focused tests and `npm test`**, then commit `fix(mstd): bind replies and approvals to authoritative context`.

### Task 4: Enforce Memory Read Scope and Safe Persistence

**Files:**
- Create: `mstd-orchestrator/server/memory/sanitize.mjs`
- Create: `mstd-orchestrator/server/memory/persistence.mjs`
- Modify: `mstd-orchestrator/server/memory/tool.mjs`
- Modify: `mstd-orchestrator/server/memory/journal.mjs`
- Modify: `mstd-orchestrator/server/ticker/dreaming.mjs`
- Test: `mstd-orchestrator/test/memory-tool.test.mjs`
- Test: `mstd-orchestrator/test/memory-sanitize.test.mjs`
- Test: `mstd-orchestrator/test/journal.test.mjs`
- Test: `mstd-orchestrator/test/dreaming.test.mjs`

**Interfaces:**
- Produces: `authorizeMemory({ action, layer, id, sessionKey })` used before every read or write.
- Produces: `sanitizeSensitive(text) -> { text, redactions[] }`.
- Produces: `preparePersistentText(text) -> { ok, text?, redactions?, error? }` applying scan and redaction.

- [ ] **Step 1: Add failing scope matrix tests** for group A reading group B, group reading user, user A reading user B, journal/soul writes, and valid same-scope reads.
- [ ] **Step 2: Move authorization before all file access**; use `readJournal()` for journal reads and deny journal/soul mutation.
- [ ] **Step 3: Add failing sanitizer tests** for bank-card-like digit sequences, PRC identity numbers, password assignments, API keys/tokens, and non-sensitive dates/order IDs.
- [ ] **Step 4: Implement centralized scan/redaction preparation** and use typed `[REDACTED:<kind>]` markers.
- [ ] **Step 5: Redact journal input before model invocation and scan/redact output before append**; unsafe output produces no journal entry.
- [ ] **Step 6: Validate and sanitize dreaming candidate arrays, additions, invalidations, and report text**; rejected candidates are reported without leaking their sensitive value.
- [ ] **Step 7: Run focused tests and `npm test`**, then commit `fix(mstd): authorize and sanitize persistent memory`.

### Task 5: Fix Recent Transcript Selection and Session Generations

**Files:**
- Create: `mstd-orchestrator/server/db/migrations/013_session_generations.sql`
- Modify: `mstd-orchestrator/server/sessions/store.mjs`
- Modify: `mstd-orchestrator/server/sessions/search.mjs`
- Modify: `mstd-orchestrator/server/http/admin-routes.mjs`
- Modify: `mstd-orchestrator/server/ticker/session-expiry.mjs`
- Modify: `mstd-orchestrator/server/models/brain.mjs`
- Test: `mstd-orchestrator/test/session-store.test.mjs`
- Test: `mstd-orchestrator/test/session-expiry.test.mjs`
- Test: `mstd-orchestrator/test/brain.test.mjs`

**Interfaces:**
- Produces: `getOrCreate(logicalSessionKey, meta?, now?)` returning the active generation only.
- Produces: `getById(id)`, `archive(sessionId, now?)`, and session fields `instance_key`, `session_key`, `generation`.
- Changes: brain pool keys and `steer/isBusy/recycle` use session instance id, while tool authorization still receives logical session key.

- [ ] **Step 1: Add failing transcript regression** with 25 messages and limit 20, expecting `m5..m24` in chronological order.
- [ ] **Step 2: Implement recent-N selection** through an inner `ORDER BY ts DESC, rowid DESC LIMIT ?` and chronological outer ordering.
- [ ] **Step 3: Add the generation migration** by renaming the old unique key to `instance_key`, adding logical `session_key` and `generation`, backfilling existing rows, and creating a unique active-session partial index.
- [ ] **Step 4: Add failing lifecycle tests** showing archive followed by getOrCreate returns a new id/generation and an empty transcript.
- [ ] **Step 5: Implement transactional active lookup/creation and archive APIs**, preserving archived rows for admin/search.
- [ ] **Step 6: Key resident Pi entries by session id** so a new generation never reuses old Pi context; recycle the old instance during archive.
- [ ] **Step 7: Increment version once for each admitted non-observed user batch** and update background job snapshots to include session id and generation.
- [ ] **Step 8: Run focused tests and `npm test`**, then commit `fix(mstd): add session generations and recent transcripts`.

### Task 6: Introduce a Shared Session Coordinator and Fair Pi Leases

**Files:**
- Create: `mstd-orchestrator/server/sessions/coordinator.mjs`
- Modify: `mstd-orchestrator/server/sessions/actor.mjs`
- Modify: `mstd-orchestrator/server/gateway/wire.mjs`
- Modify: `mstd-orchestrator/server/gateway/turn-handler.mjs`
- Modify: `mstd-orchestrator/server/jobs/reinjector.mjs`
- Modify: `mstd-orchestrator/server/memory/compact.mjs`
- Modify: `mstd-orchestrator/server/ticker/session-expiry.mjs`
- Modify: `mstd-orchestrator/server/jobs/semaphore.mjs`
- Modify: `mstd-orchestrator/server/jobs/background.mjs`
- Modify: `mstd-orchestrator/server/jobs/launcher.mjs`
- Modify: `mstd-orchestrator/server/index.mjs`
- Test: `mstd-orchestrator/test/session-coordinator.test.mjs`
- Test: `mstd-orchestrator/test/background-job.test.mjs`
- Test: `mstd-orchestrator/test/semaphore.test.mjs`

**Interfaces:**
- Produces: `createSessionCoordinator({ actors, brain, store, ... })` with `dispatchUser(turn)`, `dispatchSystem(event)`, `isActive(sessionId)`, and `shutdown()`.
- Produces: semaphore `acquire() -> Promise<releaseOnce>` and `pending` count; `tryAcquire()` remains only where synchronous probing is required.

- [ ] **Step 1: Add a failing steer reachability test** with a blocked first brain turn; the second message must be triaged and steered before the first promise resolves.
- [ ] **Step 2: Add a failing serialization test** proving user, reinjection, and maintenance events never create two simultaneous `brain.turn()` calls for one session id.
- [ ] **Step 3: Implement the coordinator state machine**: actors protect short transitions; foreground Pi promises run outside the actor; user input steers an active foreground turn; system/maintenance events queue and drain after completion.
- [ ] **Step 4: Inject one coordinator into gateway, reinjector, compactor, expiry, heartbeat, debug chat, and write-result paths**; remove local actor pools and direct same-session brain calls.
- [ ] **Step 5: Add failing FIFO lease tests** for immediate acquisition, queued wakeup, one-shot release, and no negative/double release.
- [ ] **Step 6: Convert actual Pi owners to leases**; background orchestration no longer acquires a permit before `brain.turn()` acquires the real Pi permit.
- [ ] **Step 7: When a turn finishes and leases are waiting, recycle the just-idle resident Pi immediately** instead of retaining it for the full idle timeout.
- [ ] **Step 8: Reproduce default maxPi=2 scenarios**: one foreground plus one background starts promptly; two occupied slots wake the queued job on release.
- [ ] **Step 9: Run focused tests and `npm test`**, then commit `fix(mstd): coordinate sessions and repair Pi scheduling`.

### Task 7: Add Model Request Timeouts and Durable Tool-Effect Ledger

**Files:**
- Create: `mstd-orchestrator/server/db/migrations/014_turn_effects.sql`
- Create: `mstd-orchestrator/server/pi/turn-effects.mjs`
- Modify: `mstd-orchestrator/server/models/caller.mjs`
- Modify: `mstd-orchestrator/server/models/brain.mjs`
- Modify: `mstd-orchestrator/server/http/internal-routes.mjs`
- Modify: `mstd-orchestrator/server/gateway/turn-handler.mjs`
- Modify: `mstd-orchestrator/server/store/jobs.mjs`
- Modify: `mstd-orchestrator/server/memory/tool.mjs`
- Modify: `mstd-orchestrator/.env.example`
- Test: `mstd-orchestrator/test/model-caller.test.mjs`
- Test: `mstd-orchestrator/test/turn-effects.test.mjs`

**Interfaces:**
- Produces: `createModelCaller({ requestTimeoutMs = 60_000, ... })`.
- Produces: `createTurnEffects(db)` with `beginTurn`, `beginAttempt`, `runEffect`, `completeTurn`, and `failTurn`.
- Produces: stable `effectId` supplied to state-changing internal handlers.

- [ ] **Step 1: Add a failing hung-fetch test** using an abort-aware fetch double; assert timeout enters retry/fallback and emits a timeout model event.
- [ ] **Step 2: Implement per-attempt AbortController timeout** covering response headers and body parsing, with timer cleanup in `finally`.
- [ ] **Step 3: Add the effect migration** for `agent_turns`, `agent_tool_effects`, and unique source-effect indexes on messages/jobs.
- [ ] **Step 4: Add failing replay tests** where reply/card/background succeeds, the Pi turn fails, and the next provider repeats the same logical call; assert one external effect and the cached response.
- [ ] **Step 5: Implement stable turn ids across provider attempts** and per-attempt occurrence counters keyed by canonical request hash.
- [ ] **Step 6: Wrap state-changing internal tools**: reply/card/background/job/memory/heartbeat use `runEffect`; read-only tools bypass the ledger.
- [ ] **Step 7: Make operations effect-idempotent**: outbound idempotency key derives from effect id, transcript append is unique, job creation finds-or-creates by effect id, and file additions include/detect an effect marker.
- [ ] **Step 8: Run focused tests and `npm test`**, then commit `fix(mstd): make model tool effects replay-safe`.

### Task 8: Recover Confirmed Writes Across Process Restarts

**Files:**
- Modify: `mstd-orchestrator/server/safety/write-args.mjs`
- Modify: `mstd-orchestrator/server/execute/execute-action.mjs`
- Modify: `mstd-orchestrator/server/execute/reconcile-startup.mjs`
- Modify: `mstd-orchestrator/server/cards/confirm-flow.mjs`
- Modify: `mstd-orchestrator/server/index.mjs`
- Test: `mstd-orchestrator/test/write-args.test.mjs`
- Test: `mstd-orchestrator/test/reconcile-startup.test.mjs`
- Test: `mstd-orchestrator/test/card-execute.test.mjs`

**Interfaces:**
- Produces: action-kind recovery adapters that return `succeeded | not_found | uncertain`.
- Produces: `confirmFlow.recoverExecutingCards()` called after flow construction during startup.

- [ ] **Step 1: Add failing calendar fingerprint tests** requiring a deterministic `MSTD-ID:<idempotency_key>` marker in event description.
- [ ] **Step 2: Add failing restart tests** seeding an executing card and approved decision, reconstructing services, and asserting terminal card/job/action state plus one reinjection.
- [ ] **Step 3: Implement per-kind reconciliation**: task fingerprint lookup, message idempotent resend/reconcile, calendar search by marker and exact fields; unknown/ambiguous results remain uncertain and are not blindly executed.
- [ ] **Step 4: Implement `recoverExecutingCards()`** to reconcile executing actions, continue approved pending/failed actions, rebuild result markdown, update the card, persist aggregate result, and mark reinjection exactly once.
- [ ] **Step 5: Move startup reconciliation after confirm-flow assembly** while keeping low-level stale action reconciliation available before normal traffic starts.
- [ ] **Step 6: Run focused tests and `npm test`**, then commit `fix(mstd): recover confirmed writes after restart`.

### Task 9: Restore UI Build and Close Release Gates

**Files:**
- Modify: `mstd-ui/src/atoms/ToolDetailItem.tsx`
- Modify: `mstd-ui/src/views/ApprovalActionEditor.tsx`
- Modify: `mstd-ui/src/views/LoginFeishu.tsx`
- Modify: `mstd-ui/src/views/Timeline.tsx`
- Modify: `mstd-ui/package.json`
- Modify: `mstd-orchestrator/README.md`
- Modify: `mstd-orchestrator/.env.example`
- Modify: `docs/superpowers/runbooks/agent-rollout.md`
- Test: existing UI and orchestrator suites

**Interfaces:**
- Produces: UI script `npm run check` executing `npm test && npm run build`.
- Documents: sandbox prerequisites, timeout settings, migrations, recovery behavior, credential rotation, and staged rollout.

- [ ] **Step 1: Run `npm run build` in `mstd-ui`** and record the four TS6133 failures.
- [ ] **Step 2: Remove only the unused React default imports** and add the `check` script.
- [ ] **Step 3: Run `npm run check`** and require UI tests plus Vite production build to pass without TypeScript errors.
- [ ] **Step 4: Update README, env example, and rollout runbook** with exact flags, Docker fail-closed behavior, model timeout, migrations, startup recovery, and production gates.
- [ ] **Step 5: Run `cd mstd-orchestrator && npm test` and `cd ../mstd-ui && npm run check`**.
- [ ] **Step 6: If an existing UI dev server is available, use the Browser plugin to smoke the login screen and main tabs; otherwise start a temporary server, verify, and stop only that server.**
- [ ] **Step 7: When the shared test app has no existing daemon/event consumer, run authorized E2E files serially; otherwise record live E2E as blocked rather than stopping another process.**
- [ ] **Step 8: Commit `fix(mstd-ui): restore build and production release gates` and request a final whole-branch review.**
