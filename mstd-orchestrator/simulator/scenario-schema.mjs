import { isValidRoute, ROUTE_LABEL_SET_VERSION } from "./route-labels.mjs";

const ACTOR_IDS = new Set(["lin_xi", "zhou_yan", "he_miao"]);
const TOP_KEYS = new Set(["version", "id", "mode", "limits", "actors", "turns", "route_label_version", "description"]);
const LIMIT_KEYS = new Set(["max_turns", "max_duration_ms", "messages_per_minute"]);
const ACTOR_KEYS = new Set(["id", "name", "profile_env"]);
const TURN_KEYS = new Set(["id", "actor", "text", "after_ms", "expect", "burst", "objective"]);
const BURST_ITEM_KEYS = new Set(["actor", "text", "at_ms"]);
const EXPECT_KEYS = new Set([
  "route", "outbound_min", "outbound_max", "terminal_within_ms", "input_count",
  "ack_required", "security_hard_fail",
]);

export function validateScenarioObject(doc, { routeLabelVersion = ROUTE_LABEL_SET_VERSION.V1 } = {}) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("scenario must be a mapping");
  }
  for (const k of Object.keys(doc)) {
    if (!TOP_KEYS.has(k)) throw new Error(`unknown top-level field: ${k}`);
  }
  if (doc.version !== 1) throw new Error("version must be 1");
  if (!doc.id || typeof doc.id !== "string") throw new Error("id required");
  if (!["scripted", "improv"].includes(doc.mode)) throw new Error("mode must be scripted|improv");

  const labelVersion = doc.route_label_version ?? routeLabelVersion;
  if (![ROUTE_LABEL_SET_VERSION.V1, ROUTE_LABEL_SET_VERSION.V2].includes(labelVersion)) {
    throw new Error(`invalid route_label_version: ${labelVersion}`);
  }

  if (!doc.limits || typeof doc.limits !== "object") throw new Error("limits required");
  for (const k of Object.keys(doc.limits)) {
    if (!LIMIT_KEYS.has(k)) throw new Error(`unknown limits field: ${k}`);
  }
  for (const key of ["max_turns", "max_duration_ms", "messages_per_minute"]) {
    const v = doc.limits[key];
    if (!Number.isInteger(v) || v <= 0) throw new Error(`limits.${key} must be positive integer`);
  }

  if (!Array.isArray(doc.actors) || doc.actors.length === 0) throw new Error("actors required");
  const actorIds = new Set();
  for (const a of doc.actors) {
    for (const k of Object.keys(a)) {
      if (!ACTOR_KEYS.has(k)) throw new Error(`unknown actor field: ${k}`);
    }
    if (!ACTOR_IDS.has(a.id)) throw new Error(`illegal actor id: ${a.id}`);
    if (actorIds.has(a.id)) throw new Error(`duplicate actor id: ${a.id}`);
    actorIds.add(a.id);
    if (!a.name || typeof a.name !== "string") throw new Error("actor.name required");
  }

  if (!Array.isArray(doc.turns) || doc.turns.length === 0) throw new Error("turns required");
  const turnIds = new Set();
  for (const turn of doc.turns) {
    for (const k of Object.keys(turn)) {
      if (!TURN_KEYS.has(k)) throw new Error(`unknown turn field: ${k}`);
    }
    if (!turn.id || typeof turn.id !== "string") throw new Error("turn.id required");
    if (turnIds.has(turn.id)) throw new Error(`duplicate turn id: ${turn.id}`);
    turnIds.add(turn.id);

    if (turn.burst) {
      if (!Array.isArray(turn.burst) || turn.burst.length === 0) throw new Error("burst must be non-empty array");
      for (const item of turn.burst) {
        for (const k of Object.keys(item)) {
          if (!BURST_ITEM_KEYS.has(k)) throw new Error(`unknown burst item field: ${k}`);
        }
        if (!ACTOR_IDS.has(item.actor)) throw new Error(`burst actor illegal: ${item.actor}`);
        if (typeof item.text !== "string" || !item.text) throw new Error("burst text required");
        if (!Number.isInteger(item.at_ms) || item.at_ms < 0) throw new Error("burst at_ms must be >= 0");
      }
    } else {
      if (!ACTOR_IDS.has(turn.actor)) throw new Error(`turn actor illegal: ${turn.actor}`);
      if (doc.mode === "scripted" && (typeof turn.text !== "string" || !turn.text)) {
        throw new Error(`turn ${turn.id}: scripted mode requires text`);
      }
      if (doc.mode === "improv" && !turn.objective && !turn.text) {
        throw new Error(`turn ${turn.id}: improv requires objective or text`);
      }
      if (turn.after_ms != null && (!Number.isInteger(turn.after_ms) || turn.after_ms < 0)) {
        throw new Error("after_ms must be >= 0");
      }
    }

    if (doc.mode === "scripted") {
      if (!turn.expect || typeof turn.expect !== "object") {
        throw new Error(`turn ${turn.id}: scripted mode requires expect`);
      }
    }
    if (turn.expect) {
      for (const k of Object.keys(turn.expect)) {
        if (!EXPECT_KEYS.has(k)) throw new Error(`unknown expect field: ${k}`);
      }
      if (!isValidRoute(turn.expect.route, labelVersion)) {
        throw new Error(`illegal route: ${turn.expect.route} (label set ${labelVersion})`);
      }
    }
  }

  if (doc.turns.length > doc.limits.max_turns) {
    throw new Error("turns length exceeds limits.max_turns");
  }

  return { ...doc, route_label_version: labelVersion };
}
