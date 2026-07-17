import { describe, it, expect, vi } from "vitest";
import {
  GatewayCapabilityError,
  requireGatewayCapability,
} from "../simulator/gateway-capability.mjs";

function response(body, { ok = true } = {}) {
  return { ok, json: async () => body };
}

describe("simulator gateway capability preflight", () => {
  it("accepts trace-capable B mode without requiring C ingress", async () => {
    const fetchFn = vi.fn(async () => response({
      contractVersion: 1,
      traceEnabled: true,
      ingressEnabled: false,
    }));
    await expect(requireGatewayCapability({
      baseUrl: "http://127.0.0.1:8899",
      transport: "user",
      fetchFn,
    })).resolves.toMatchObject({ traceEnabled: true });
    expect(fetchFn).toHaveBeenCalledWith("http://127.0.0.1:8899/api/health/simulator");
  });

  it("rejects a healthy but stale daemon before sending", async () => {
    const fetchFn = vi.fn(async () => response({}, { ok: false }));
    await expect(requireGatewayCapability({
      baseUrl: "http://127.0.0.1:8899",
      transport: "user",
      fetchFn,
    })).rejects.toMatchObject({
      name: "GatewayCapabilityError",
      code: "gateway_simulator_contract_missing",
    });
  });

  it("requires enabled ingress for synthetic transport", async () => {
    const fetchFn = vi.fn(async () => response({
      contractVersion: 1,
      traceEnabled: true,
      ingressEnabled: false,
    }));
    await expect(requireGatewayCapability({
      baseUrl: "http://127.0.0.1:8899",
      transport: "synthetic",
      fetchFn,
    })).rejects.toBeInstanceOf(GatewayCapabilityError);
    await expect(requireGatewayCapability({
      baseUrl: "http://127.0.0.1:8899",
      transport: "synthetic",
      fetchFn,
    })).rejects.toMatchObject({ code: "gateway_simulator_ingress_disabled" });
  });
});
