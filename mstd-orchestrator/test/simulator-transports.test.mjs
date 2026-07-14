import { describe, it, expect, vi } from "vitest";
import { createTransport } from "../simulator/transports/index.mjs";
import { signSimulatorRequest } from "../server/simulator/auth.mjs";

describe("simulator transports", () => {
  it("bot transport uses actor profile and --as bot, never consume", async () => {
    const calls = [];
    const transport = createTransport({
      mode: "bot",
      profilesByActor: { lin_xi: "prof_lin" },
      runLarkFactory: ({ profile }) => async (argv) => {
        calls.push({ profile, argv });
        return { exitCode: 0, stdout: JSON.stringify({ data: { message_id: "om_1" } }), stderr: "" };
      },
    });
    const result = await transport.send({
      runId: "r", turnId: "t", actor: { id: "lin_xi", name: "林夕" },
      chatId: "oc_1", text: "hi", idempotencyKey: "r:t",
    });
    expect(result).toMatchObject({ source: "feishu_bot", platformMessageId: "om_1", ok: true });
    expect(calls[0].profile).toBe("prof_lin");
    expect(calls[0].argv).toContain("--as");
    expect(calls[0].argv).toContain("bot");
    expect(calls[0].argv.join(" ")).not.toMatch(/event|consume/);
  });

  it("missing actor profile fails without falling back", async () => {
    const transport = createTransport({
      mode: "bot",
      profilesByActor: {},
      runLarkFactory: () => async () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
    });
    const result = await transport.send({
      runId: "r", turnId: "t", actor: { id: "lin_xi", name: "林夕" },
      chatId: "oc_1", text: "hi",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("actor_profile_missing");
  });

  it("synthetic transport signs HMAC and returns server message id", async () => {
    const fetchFn = vi.fn(async (_url, init) => {
      expect(init.headers["X-MSTD-Sim-Signature"]).toMatch(/^[a-f0-9]+$/);
      return {
        ok: true,
        status: 202,
        json: async () => ({ platformMessageId: "sim_abc", eventId: "sim:r:t" }),
      };
    });
    const transport = createTransport({
      mode: "synthetic",
      secret: "z".repeat(32),
      baseUrl: "http://127.0.0.1:8787",
      fetchFn,
    });
    const result = await transport.send({
      runId: "r", turnId: "t", actor: { id: "lin_xi", name: "林夕" },
      chatId: "oc_1", text: "@小达 hi",
    });
    expect(result).toMatchObject({ ok: true, source: "simulator", platformMessageId: "sim_abc" });
  });
});
