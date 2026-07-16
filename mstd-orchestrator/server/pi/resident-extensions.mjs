// Pi capability profiles are the only production source of extension paths and tool names.
// `startPi` consumes a profile directly; callers must not assemble extension/tool lists.
import { join } from "node:path";

const PROFILE_SPECS = Object.freeze({
  resident: Object.freeze([
    ["turn-context.ts", []],
    ["persona.ts", []],
    ["providers.ts", []],
    ["reply.ts", ["reply"]],
    ["memory.ts", ["memory"]],
    ["session-search.ts", ["session_search"]],
    ["propose-actions.ts", ["propose_actions"]],
    ["background-job.ts", ["spawn_background_job"]],
    ["heartbeat.ts", ["heartbeat_update"]],
    ["lark-read.ts", ["lark_read"]],
    ["time.ts", ["time"]],
  ]),
  // Meeting extraction is a fresh, read-only worker. It may read Lark and render
  // the structured draft, but cannot reply, write memory, propose actions, or spawn.
  readonly_job: Object.freeze([
    ["providers.ts", []],
    ["lark-read.ts", ["lark_read"]],
    ["draft.ts", ["draft_zh"]],
  ]),
  // Resident-background work is likewise a fresh reader. Its result is returned to
  // the server reinjector; it must not gain any resident side-effect tool.
  background: Object.freeze([
    ["providers.ts", []],
    ["lark-read.ts", ["lark_read"]],
  ]),
});

export const CAPABILITY_ROLE_NAMES = Object.freeze(Object.keys(PROFILE_SPECS));

export function resolveCapabilityProfile(profile) {
  if (!profile || typeof profile !== "object" || !CAPABILITY_ROLE_NAMES.includes(profile.role)) {
    throw new Error("invalid Pi capability profile");
  }
  if (!Array.isArray(profile.extensions) || !Array.isArray(profile.tools)) {
    throw new Error("invalid Pi capability profile shape");
  }
  const expected = PROFILE_SPECS[profile.role];
  const expectedTools = expected.flatMap(([, tools]) => tools);
  const extensionPaths = profile.extensions.map((extension) => extension?.path);
  const extensionTools = profile.extensions.flatMap((extension) => extension?.tools ?? []);
  if (extensionPaths.length !== expected.length || extensionPaths.some((path) => typeof path !== "string" || !path)) {
    throw new Error(`invalid Pi ${profile.role} extension paths`);
  }
  if (new Set(profile.tools).size !== profile.tools.length
    || new Set(extensionTools).size !== extensionTools.length
    || profile.tools.join("|") !== expectedTools.join("|")
    || extensionTools.join("|") !== expectedTools.join("|")) {
    throw new Error(`invalid Pi ${profile.role} tool binding`);
  }
  return profile;
}

export function buildCapabilityProfile(root, role = "resident") {
  const spec = PROFILE_SPECS[role];
  if (!spec) throw new Error(`unknown Pi capability role: ${role}`);
  const extensions = spec.map(([file, tools]) => Object.freeze({
    path: join(root, "pi-ext", file),
    tools: Object.freeze([...tools]),
  }));
  const tools = extensions.flatMap((extension) => extension.tools);
  if (new Set(tools).size !== tools.length) throw new Error(`duplicate Pi tool in ${role} capability profile`);
  return Object.freeze({
    role,
    extensions: Object.freeze(extensions),
    tools: Object.freeze(tools),
  });
}

// Compatibility helper for existing test/e2e imports. New production code uses
// buildCapabilityProfile() so paths and tool names remain bound together.
export function buildResidentExtensions(root) {
  return buildCapabilityProfile(root, "resident").extensions.map(({ path }) => path);
}
