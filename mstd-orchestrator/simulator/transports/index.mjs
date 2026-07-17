import { createLarkTransport } from "./lark-transport.mjs";
import { createSyntheticTransport } from "./synthetic-transport.mjs";

export function createTransport({
  mode,
  env = process.env,
  fetchFn = fetch,
  runLarkFactory,
  profilesByActor,
  baseUrl,
  secret,
}) {
  if (mode === "bot" || mode === "feishu_bot") {
    return createLarkTransport({
      as: "bot",
      runLarkFactory,
      profilesByActor: profilesByActor ?? defaultProfiles(env),
    });
  }
  if (mode === "user" || mode === "feishu_user") {
    return createLarkTransport({
      as: "user",
      runLarkFactory,
      profilesByActor: profilesByActor ?? defaultProfiles(env),
    });
  }
  if (mode === "synthetic" || mode === "simulator") {
    return createSyntheticTransport({
      baseUrl: baseUrl ?? `http://127.0.0.1:${env.PORT ?? 8787}`,
      secret: secret ?? env.MSTD_SIMULATOR_SECRET,
      fetchFn,
    });
  }
  throw new Error(`unsupported transport: ${mode}`);
}

function defaultProfiles(env) {
  return {
    lin_xi: env.MSTD_SIM_BOT_PRODUCT_PROFILE,
    zhou_yan: env.MSTD_SIM_BOT_ENGINEER_PROFILE,
    he_miao: env.MSTD_SIM_BOT_OPS_PROFILE,
  };
}

export { createLarkTransport, createSyntheticTransport };
