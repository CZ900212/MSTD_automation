import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { startMinutesConsumer } from "../server/triggers/minutes-consumer.mjs";
import {
  resolveMinutesInitiator,
  makeFetchMinutesOwner,
  createMinutesBroadcast,
} from "../server/triggers/minutes-agent.mjs";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

function fakeSpawn() {
  return { stdout: { on: () => {} }, stderr: { on: () => {} }, on: () => {}, kill: () => {} };
}

describe("resolveMinutesInitiator：确认人三级兜底", () => {
  it("params.host_open_id 优先，直接返回不反查", async () => {
    let fetched = 0;
    const r = await resolveMinutesInitiator({
      params: { host_open_id: "ou_host", minute_token: "m1" },
      fetchOwner: async () => { fetched++; return "ou_owner"; },
      alertOpenId: "ou_alert",
    });
    expect(r).toBe("ou_host");
    expect(fetched).toBe(0);
  });

  it("无 host 时反查妙记 owner", async () => {
    const r = await resolveMinutesInitiator({
      params: { minute_token: "m1" },
      fetchOwner: async (t) => (t === "m1" ? "ou_owner" : null),
      alertOpenId: "ou_alert",
    });
    expect(r).toBe("ou_owner");
  });

  it("反查失败/为空/抛错 → alertOpenId 兜底；全空 → null", async () => {
    expect(await resolveMinutesInitiator({
      params: { minute_token: "m1" },
      fetchOwner: async () => null,
      alertOpenId: "ou_alert",
    })).toBe("ou_alert");
    expect(await resolveMinutesInitiator({
      params: { minute_token: "m1" },
      fetchOwner: async () => { throw new Error("网络挂了"); },
      alertOpenId: "ou_alert",
    })).toBe("ou_alert");
    expect(await resolveMinutesInitiator({ params: {} })).toBe(null);
  });
});

describe("makeFetchMinutesOwner：owner 反查的 argv 与解析", () => {
  it("拼 GET /minutes/{token} 并解析 owner_id（含 data 包一层的形状）", async () => {
    const calls = [];
    const fetchOwner = makeFetchMinutesOwner({
      runLark: async (argv) => {
        calls.push(argv);
        return { exitCode: 0, stdout: JSON.stringify({ minute: { owner_id: "ou_owner" } }), stderr: "" };
      },
    });
    expect(await fetchOwner("obcxxx")).toBe("ou_owner");
    expect(calls[0]).toEqual(["api", "GET", "/open-apis/minutes/v1/minutes/obcxxx", "--as", "user"]);

    const wrapped = makeFetchMinutesOwner({
      runLark: async () => ({ exitCode: 0, stdout: JSON.stringify({ data: { minute: { owner_id: "ou_w" } } }), stderr: "" }),
    });
    expect(await wrapped("t")).toBe("ou_w");
  });

  it("非零退出码或坏 JSON → null", async () => {
    const bad1 = makeFetchMinutesOwner({ runLark: async () => ({ exitCode: 1, stdout: "", stderr: "403" }) });
    expect(await bad1("t")).toBe(null);
    const bad2 = makeFetchMinutesOwner({ runLark: async () => ({ exitCode: 0, stdout: "not json", stderr: "" }) });
    expect(await bad2("t")).toBe(null);
  });
});

describe("createMinutesBroadcast：执行后群播报", () => {
  function setupJob(db, { id = "job1", templateId = "meeting_to_task", title = "周会派发" } = {}) {
    db.prepare(
      "INSERT INTO orch_jobs (id, template_id, title, status, created_at, updated_at) VALUES (?,?,?,?,?,?)"
    ).run(id, templateId, title, "done", 1, 1);
  }

  it("meeting_to_task job → handleReply 到指定群，brief 带标题与结果", async () => {
    const db = freshDb();
    setupJob(db);
    const replies = [];
    const bc = createMinutesBroadcast({
      db,
      chatKey: "feishu:group:oc_broadcast",
      handleReply: async (args) => { replies.push(args); return { ok: true }; },
      log: () => {},
    });
    const r = await bc.onJobExecuted({ jobId: "job1", ok: true, resultsMd: "✅ 建任务：成功" });
    expect(r).toBe(true);
    expect(replies.length).toBe(1);
    expect(replies[0].sessionKey).toBe("feishu:group:oc_broadcast");
    expect(replies[0].brief).toContain("周会派发");
    expect(replies[0].brief).toContain("✅ 建任务：成功");
    expect(replies[0].brief).toContain("全部成功");
  });

  it("未配置群 / 非 meeting_to_task job → 不播报", async () => {
    const db = freshDb();
    setupJob(db);
    const replies = [];
    const noChat = createMinutesBroadcast({ db, chatKey: "", handleReply: async (a) => { replies.push(a); return { ok: true }; }, log: () => {} });
    expect(await noChat.onJobExecuted({ jobId: "job1", ok: true, resultsMd: "x" })).toBe(false);

    db.prepare("INSERT INTO orch_jobs (id, template_id, status, created_at, updated_at) VALUES (?,?,?,?,?)")
      .run("job2", "other_template", "done", 1, 1);
    const bc = createMinutesBroadcast({ db, chatKey: "feishu:group:oc_x", handleReply: async (a) => { replies.push(a); return { ok: true }; }, log: () => {} });
    expect(await bc.onJobExecuted({ jobId: "job2", ok: true, resultsMd: "x" })).toBe(false);
    expect(replies.length).toBe(0);
  });

  it("handleReply 失败/抛错 → 返回 false 不炸", async () => {
    const db = freshDb();
    setupJob(db);
    const logs = [];
    const bc = createMinutesBroadcast({
      db, chatKey: "feishu:group:oc_x",
      handleReply: async () => ({ ok: false, error: "渲染挂了" }),
      log: (m) => logs.push(m),
    });
    expect(await bc.onJobExecuted({ jobId: "job1", ok: false, resultsMd: "❌" })).toBe(false);
    expect(logs.join()).toContain("渲染挂了");

    const bc2 = createMinutesBroadcast({
      db, chatKey: "feishu:group:oc_x",
      handleReply: async () => { throw new Error("boom"); },
      log: () => {},
    });
    expect(await bc2.onJobExecuted({ jobId: "job1", ok: true, resultsMd: "x" })).toBe(false);
  });
});

describe("minutes-consumer：事件里的 owner 透传为 host_open_id", () => {
  it("evt.owner_id 存在时进 params，缺席时不加字段", () => {
    const db = freshDb();
    const submitted = [];
    const launcher = {
      submit: (o) => {
        const j = { id: `job${submitted.length + 1}` };
        submitted.push(o);
        db.prepare("INSERT INTO orch_jobs (id, template_id, status, created_at, updated_at) VALUES (?,?,?,?,?)")
          .run(j.id, "meeting_to_task", "queued", 1, 1);
        return j;
      },
    };
    const c = startMinutesConsumer({ db, launcher, larkCli: "lark-cli", spawnFn: fakeSpawn, log: () => {} });
    c.handleLine(JSON.stringify({ event_id: "e1", minute_token: "m1", owner_id: "ou_owner" }));
    c.handleLine(JSON.stringify({ event_id: "e2", minute_token: "m2" }));
    expect(submitted[0].params).toEqual({ minute_token: "m1", host_open_id: "ou_owner" });
    expect(submitted[1].params).toEqual({ minute_token: "m2" });
    c.stop();
  });
});
