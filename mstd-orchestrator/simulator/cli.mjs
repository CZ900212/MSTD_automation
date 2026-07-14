import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenarioFile } from "./scenario-loader.mjs";
import { createTransport } from "./transports/index.mjs";
import { createRunner } from "./runner.mjs";
import { createGrader } from "./grader.mjs";
import { createImproviser } from "./improviser.mjs";
import { openDb, migrate } from "../server/db/index.mjs";
import { makeRunLark } from "../server/execute/run-lark.mjs";
import { createModelCaller } from "../server/models/caller.mjs";
import { requireGatewayCapability } from "./gateway-capability.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { scenario: null, transport: "synthetic", chatId: null, waitMs: 15_000 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scenario") out.scenario = argv[++i];
    else if (a === "--transport") out.transport = argv[++i];
    else if (a === "--chat-id") out.chatId = argv[++i];
    else if (a === "--wait-ms") out.waitMs = Number(argv[++i]);
    else if (a === "--help") out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv);
if (args.help || !args.scenario) {
  console.error("Usage: npm run sim:run -- --scenario <path.yaml> --transport synthetic|bot|user [--chat-id oc_...]");
  process.exit(args.help ? 0 : 2);
}

const scenarioPath = resolve(process.cwd(), args.scenario);
const scenario = loadScenarioFile(scenarioPath);
const chatId = args.chatId || process.env.MSTD_SIM_CHAT_ID || process.env.MSTD_SIMULATOR_CHAT_IDS?.split(",")[0];
if (!chatId) {
  console.error("chat id required via --chat-id or MSTD_SIM_CHAT_ID");
  process.exit(2);
}

const gatewayBaseUrl = process.env.MSTD_SIMULATOR_BASE_URL
  ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`;
try {
  await requireGatewayCapability({ baseUrl: gatewayBaseUrl, transport: args.transport });
} catch (error) {
  console.error(JSON.stringify({
    error: "gateway_preflight_failed",
    reason: error?.code ?? "gateway_capability_unknown",
    hint: "restart the daemon with the current code/config before running the simulator",
  }));
  process.exit(3);
}

const transport = createTransport({
  mode: args.transport,
  env: process.env,
  baseUrl: gatewayBaseUrl,
  runLarkFactory: ({ profile }) => makeRunLark({ profile }),
});

const dbPath = process.env.MSTD_DB_PATH || join(HERE, "..", "db", "mstd.sqlite");
const db = openDb(dbPath);
migrate(db);
const grader = createGrader({ db, waitMs: args.waitMs });
let improviser = null;
if (scenario.mode === "improv") {
  if (!process.env.CZ_GPT_KEY) {
    console.error(JSON.stringify({
      error: "improviser_config_missing",
      reason: "CZ_GPT_KEY required for gpt-5.6-sol",
    }));
    process.exit(4);
  }
  improviser = createImproviser({
    caller: createModelCaller({
      env: process.env,
      maxTokens: 512,
      retries: 2,
      retryDelayMs: 1_000,
      attemptTimeoutMs: 30_000,
    }),
  });
}

const resultsDir = join(HERE, "..", "simulator-results");
const runner = createRunner({
  transport,
  scenario,
  chatId,
  resultsDir,
  grader,
  improviser,
  lockDir: join(resultsDir, "locks"),
});

const onSig = () => {
  console.error("[sim] SIGINT — draining, no new sends");
  runner.requestAbort();
};
process.on("SIGINT", onSig);
process.on("SIGTERM", onSig);

const report = await runner.run();
console.log(JSON.stringify({
  status: report.status,
  runId: report.runId,
  accuracy: report.grade?.routes?.accuracy,
  critical: report.grade?.routes?.critical_mismatches?.length ?? 0,
  results: join(resultsDir, report.runId),
}, null, 2));
process.exit(report.status === "passed" ? 0 : 1);
