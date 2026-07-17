import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_VERSION = "0.80.3";
export const CAPABILITY_FIXTURE_SCHEMA_VERSION = 1;

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent");
const defaultPiCli = join(packageRoot, "dist", "cli.js");
const marker = "MSTD_CAPABILITY_PROBE=";

// These are passed directly to Pi. The harness always adds RPC, ephemeral-session,
// and offline flags, but deliberately leaves discovery enabled unless a case tests
// its disabling behavior. The temporary cwd and agent dir contain no resources.
export const CAPABILITY_PROBE_CASES = Object.freeze([
  { id: "default", args: [], extensionNames: ["probe_allowed", "probe_unlisted"] },
  { id: "approve", args: ["-a"], extensionNames: ["probe_allowed", "probe_unlisted"] },
  { id: "no-approve", args: ["--no-approve"], extensionNames: ["probe_allowed", "probe_unlisted"] },
  { id: "no-tools", args: ["--no-tools"], extensionNames: ["probe_allowed", "probe_unlisted"] },
  { id: "tools", args: ["--tools", "probe_allowed"], extensionNames: ["probe_allowed", "probe_unlisted"] },
  { id: "no-tools-plus-tools", args: ["--no-tools", "--tools", "probe_allowed"], extensionNames: ["probe_allowed", "probe_unlisted"] },
  { id: "no-extensions-plus-explicit-e", args: ["--no-extensions"], extensionNames: ["probe_allowed"] },
  {
    id: "no-skills-context-prompts",
    args: ["--no-skills", "--no-context-files", "--no-prompt-templates"],
    extensionNames: ["probe_allowed", "probe_unlisted"],
  },
]);

function probeExtensionSource() {
  return `
export default function (pi) {
  pi.registerTool({
    name: "__TOOL_NAME__",
    label: "Capability probe",
    description: "Reports Pi's already-configured tool registry; it is never invoked.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { throw new Error("The capability probe tool must never execute"); },
  });
  pi.on("session_start", async () => {
    process.stderr.write(${JSON.stringify(marker)} + JSON.stringify({
      activeTools: pi.getActiveTools().slice().sort(),
      configuredTools: pi.getAllTools().map((tool) => tool.name).sort(),
    }) + "\\n");
  });
}
`;
}

async function writeProbeExtensions(root) {
  const paths = {};
  for (const name of ["probe_allowed", "probe_unlisted"]) {
    const path = join(root, `${name}.mjs`);
    await writeFile(path, probeExtensionSource().replace("__TOOL_NAME__", name), "utf8");
    paths[name] = path;
  }
  return paths;
}

function stableStderr(stderr) {
  return stderr
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => !line.startsWith(marker));
}

function extractObservation(stderr) {
  const lines = stderr.split(/\r?\n/).filter((line) => line.startsWith(marker));
  if (lines.length < 1) {
    throw new Error(`expected a capability marker, received none; stderr: ${stderr}`);
  }
  const unique = [...new Set(lines)];
  if (unique.length !== 1) {
    throw new Error(`expected identical capability markers, received ${unique.length}; stderr: ${stderr}`);
  }
  try {
    return JSON.parse(unique[0].slice(marker.length));
  } catch (error) {
    throw new Error(`invalid capability marker: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runProcess(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

async function assertPinnedPiVersion() {
  const raw = await readFile(join(packageRoot, "package.json"), "utf8");
  const version = JSON.parse(raw).version;
  if (version !== PI_VERSION) throw new Error(`expected ${PI_PACKAGE}@${PI_VERSION}, found ${version}`);
}

/**
 * Runs the pinned local Pi CLI in a blank temporary workspace and observes the
 * effective tool set through Pi's ExtensionAPI. It never prompts a model or
 * invokes any tool; the only writes are temporary probe extensions, removed on
 * completion. This deliberately does not use the production Pi launcher.
 */
export async function runCapabilityProbe({ timeoutMs = 10_000, piCli = defaultPiCli } = {}) {
  await assertPinnedPiVersion();
  const root = await mkdtemp(join(tmpdir(), "mstd-pi-capability-"));
  try {
    const agentDir = join(root, "agent");
    const extensions = await writeProbeExtensions(root);
    // Pi creates its isolated agent directory. The already-created temporary root
    // is also the empty working directory passed to every child process.
    const effectiveCwd = root;
    const cases = [];

    for (const testCase of CAPABILITY_PROBE_CASES) {
      const extensionArgs = testCase.extensionNames.flatMap((name) => ["-e", extensions[name]]);
      const result = await runProcess(process.execPath, [piCli, "--mode", "rpc", "--no-session", "--offline", ...testCase.args, ...extensionArgs], {
        cwd: effectiveCwd,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: root,
          LANG: "C",
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0",
          PI_SKIP_VERSION_CHECK: "1",
        },
        timeoutMs,
      });
      if (result.timedOut) throw new Error(`Pi capability case ${testCase.id} timed out after ${timeoutMs}ms`);
      if (result.code !== 0 || result.signal !== null) {
        throw new Error(`Pi capability case ${testCase.id} exited code=${result.code} signal=${result.signal}; stderr: ${result.stderr}`);
      }
      cases.push({
        id: testCase.id,
        args: testCase.args,
        extensions: testCase.extensionNames,
        observation: extractObservation(result.stderr),
        stderr: stableStderr(result.stderr),
        stdout: result.stdout.split(/\r?\n/).filter(Boolean),
        exit: { code: result.code, signal: result.signal },
      });
    }

    return {
      schemaVersion: CAPABILITY_FIXTURE_SCHEMA_VERSION,
      pi: { package: PI_PACKAGE, version: PI_VERSION },
      execution: {
        mode: "rpc",
        isolation: "temporary empty cwd and agent directory; offline; no session; no model prompt or tool invocation",
      },
      cases,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
