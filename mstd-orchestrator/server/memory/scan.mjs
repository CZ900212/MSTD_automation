// Compatibility boundary for legacy memory/cron callers. The canonical rules live in
// safety/injection-signals so prompt inputs and persistence use one deterministic scanner.
export { scanPromptInjection as scanForInjection } from "../safety/injection-signals.mjs";
