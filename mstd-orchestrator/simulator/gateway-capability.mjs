export class GatewayCapabilityError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "GatewayCapabilityError";
    this.code = code;
  }
}

export async function requireGatewayCapability({
  baseUrl,
  transport,
  fetchFn = fetch,
} = {}) {
  if (!baseUrl) throw new GatewayCapabilityError("gateway_url_missing");
  let response;
  try {
    response = await fetchFn(`${baseUrl.replace(/\/$/, "")}/api/health/simulator`);
  } catch {
    throw new GatewayCapabilityError("gateway_unreachable");
  }
  if (!response?.ok) {
    throw new GatewayCapabilityError("gateway_simulator_contract_missing");
  }
  let capability;
  try {
    capability = await response.json();
  } catch {
    throw new GatewayCapabilityError("gateway_simulator_contract_invalid");
  }
  if (capability?.contractVersion !== 1 || capability?.traceEnabled !== true) {
    throw new GatewayCapabilityError("gateway_trace_unavailable");
  }
  if ((transport === "synthetic" || transport === "simulator") && capability?.ingressEnabled !== true) {
    throw new GatewayCapabilityError("gateway_simulator_ingress_disabled");
  }
  return capability;
}
