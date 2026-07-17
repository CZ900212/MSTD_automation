export type LarkReadParams = Record<string, string | number | boolean | null | undefined>;

export type LarkReadScope =
  | { kind: "unknown"; ownerOpenId?: string | null }
  | { kind: "group"; chatId: string; ownerOpenId?: string | null }
  | { kind: "p2p"; chatId?: string | null; openId: string; ownerOpenId?: string | null }
  | { kind: "job"; ownerOpenId?: string | null; requesterOpenId?: string | null; privateReadAuthorized?: boolean }
  | { kind: string; ownerOpenId?: string | null };

export function resolveLarkScope(env?: NodeJS.ProcessEnv): LarkReadScope;
export function buildLarkReadArgsScoped(op: string, params?: LarkReadParams, scope?: LarkReadScope): string[];
