import { describe, it, expect, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSemaphore } from "../server/jobs/semaphore.mjs";
import { createEventBus } from "../server/jobs/event-bus.mjs";
import { createEventBuffer } from "../server/jobs/event-buffer.mjs";
import { createRuntimeRegistry } from "../server/jobs/runtime.mjs";
import { createJobLauncher } from "../server/jobs/launcher.mjs";
import { transitionJobStatus } from "../server/store/jobs.mjs";

const goodIntent = JSON.stringify({
  card_text: "请确认",
  items: [{ owner_name: "张三", task: "写周报", due: "2026-07-15", suggested_open_id: "ou_a", confidence: "high" }],
});

function fakeStartPi() {
  return () => ({
    child: { kill() {} },
    runJob(_p, { onEvent }) {
      onEvent({ event: "tool_start", data: {} });
      return Promise.resolve({ finalText: goodIntent });
    },
    close() {
      return Promise.resolve();
    },
  });
}

async function waitFor(fn, { timeoutMs = 2000, intervalMs = 15 } = {}) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      if (fn()) return;
    } catch {
      /* retry until timeout */
    }
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

let db, bus, buffer, registry;

beforeEach(() => {
  db = openDb();
  migrate(db);
  db.prepare("INSERT INTO users (id, feishu_open_id, name, avatar, role, created_at) VALUES (?,?,?,?,?,?)")
    .run("u-1", "ou_me", "我", null, "user", 1);
  bus = createEventBus();
  buffer = createEventBuffer(db);
  registry = createRuntimeRegistry();
});

describe("createJobLauncher", () => {
  it("submit 超并发入队，release 后自动 pump", async () => {
    const sem = createSemaphore(1);
    const launcher = createJobLauncher({
      db,
      config: { pi: {} },
      startPi: fakeStartPi(),
      semaphore: sem,
      bus,
      buffer,
      registry,
      extensions: [],
      now: () => 1000,
    });
    const j1 = launcher.submit({ templateId: "meeting_to_task", params: {}, createdBy: "u-1" });
    const j2 = launcher.submit({ templateId: "meeting_to_task", params: {}, createdBy: "u-1" });
    expect(j1.status).toBe("running_readonly");
    expect(j2.status).toBe("queued");
    expect(launcher.queueLength).toBe(1);
    await waitFor(() => db.prepare("SELECT status FROM orch_jobs WHERE id = ?").get(j2.id).status !== "queued");
    expect(launcher.queueLength).toBe(0);
  });

  it("未知模板抛错", () => {
    const launcher = createJobLauncher({
      db,
      config: { pi: {} },
      startPi: fakeStartPi(),
      semaphore: createSemaphore(2),
      bus,
      buffer,
      registry,
      extensions: [],
      now: () => 1000,
    });
    expect(() => launcher.submit({ templateId: "nope" })).toThrow(/未知模板/);
  });

  it("pump skips a queued job that was aborted while waiting for a semaphore", async () => {
    const sem = createSemaphore(1);
    const first = Promise.withResolvers();
    let spawns = 0;
    const launcher = createJobLauncher({
      db, config: { pi: {} }, semaphore: sem, bus, buffer, registry, extensions: [], now: () => 1000,
      startPi: () => {
        spawns += 1;
        return {
          child: { kill() {} },
          runJob: () => spawns === 1 ? first.promise : Promise.resolve({ finalText: goodIntent }),
          close: () => Promise.resolve(),
        };
      },
    });
    launcher.submit({ templateId: "meeting_to_task", params: {}, createdBy: "u-1" });
    const queued = launcher.submit({ templateId: "meeting_to_task", params: {}, createdBy: "u-1" });
    expect(transitionJobStatus(db, queued.id, { from: "queued", to: "aborted" }, 1001)).toBeTruthy();
    first.resolve({ finalText: goodIntent });
    await waitFor(() => launcher.queueLength === 0);
    expect(spawns).toBe(1);
    expect(db.prepare("SELECT status FROM orch_jobs WHERE id=?").get(queued.id).status).toBe("aborted");
  });
});
