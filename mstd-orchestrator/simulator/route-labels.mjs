/**
 * Versioned route label sets for simulator expectations / graders.
 * v1: legacy triage vocabulary (current production path)
 * v2: responder architecture vocabulary (post-migration)
 *
 * Graders operate on a label-set version; mapping between sets is additive.
 */

export const ROUTE_LABEL_SET_VERSION = Object.freeze({
  V1: "v1",
  V2: "v2",
});

/** Legacy triage / gateway actions used by scenarios today. */
export const ROUTE_LABELS_V1 = Object.freeze([
  "observed",
  "quick_reply",
  "no_reply",
  "escalate",
  "steer",
  "confirm_card",
  "security_refused",
]);

/** Responder-era labels (Task: architecture migration). */
export const ROUTE_LABELS_V2 = Object.freeze([
  "reply",
  "no_reasoning",
  "attach_existing",
  "spawn_new",
  "observed",
  "confirm_card",
  "security_refused",
]);

/** Best-effort v1→v2 mapping for migration of scenario expectations. */
export const ROUTE_V1_TO_V2 = Object.freeze({
  quick_reply: "reply",
  no_reply: "no_reasoning",
  escalate: "spawn_new",
  steer: "attach_existing",
  observed: "observed",
  confirm_card: "confirm_card",
  security_refused: "security_refused",
});

export function routeLabelsForVersion(version = ROUTE_LABEL_SET_VERSION.V1) {
  if (version === ROUTE_LABEL_SET_VERSION.V2) return ROUTE_LABELS_V2;
  if (version === ROUTE_LABEL_SET_VERSION.V1) return ROUTE_LABELS_V1;
  throw new Error(`unknown route label set version: ${version}`);
}

export function isValidRoute(route, version = ROUTE_LABEL_SET_VERSION.V1) {
  return routeLabelsForVersion(version).includes(route);
}

export function mapRouteV1ToV2(route) {
  return ROUTE_V1_TO_V2[route] ?? null;
}
