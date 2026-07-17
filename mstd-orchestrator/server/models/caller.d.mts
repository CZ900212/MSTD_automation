export interface ModelMessage {
  role: string;
  content: string;
}

export interface ModelCallRequest {
  system?: string;
  messages: ModelMessage[];
  thinking?: boolean;
  promptVariant?: string | null;
}

export interface ModelCallResult {
  text: string;
  model: string;
  usage: unknown | null;
}

export interface ModelCallerOptions {
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  env?: NodeJS.ProcessEnv;
  sleepFn?: (milliseconds: number) => Promise<void>;
  retries?: number;
  retryDelayMs?: number;
  fastRetryDelayMs?: number;
  attemptTimeoutMs?: number;
  maxTokens?: number;
  log?: (message: string) => void;
  onEvent?: (event: Record<string, unknown>) => void;
}

export function createModelCaller(options?: ModelCallerOptions): {
  call(chain: string, request: ModelCallRequest): Promise<ModelCallResult>;
};
