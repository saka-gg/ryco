import type {
  EnvironmentApi,
  ProviderSessionPrewarmInput,
  ProviderSessionPrewarmResult,
} from "@ryco/contracts";

/** A repeat of the same request within this window is not sent again. */
export const SESSION_PREWARM_REPEAT_MS = 30_000;
/** Any request for one thread at most this often (a changed model may ask again sooner). */
export const SESSION_PREWARM_MIN_INTERVAL_MS = 3_000;

interface LastRequest {
  readonly key: string;
  readonly atMs: number;
}

const lastRequests = new WeakMap<EnvironmentApi, Map<string, LastRequest>>();

function requestKey(input: ProviderSessionPrewarmInput): string {
  return JSON.stringify([
    input.projectId ?? null,
    input.modelSelection ?? null,
    input.runtimeMode ?? null,
    input.tokenMode ?? null,
  ]);
}

/**
 * Asks the node to start the provider session the composer's next send would start (on
 * composer focus or the first keystroke), so the send does not wait for the provider to boot.
 * Fire and forget: throttled per environment and thread, never throws, and a no-op unless
 * `supported` (the node advertises `providerSessionPrewarm`) and the transport has the method.
 * Returns whether a request was sent.
 */
export function requestProviderSessionPrewarm(input: {
  readonly api: EnvironmentApi | undefined;
  readonly supported: boolean;
  readonly request: ProviderSessionPrewarmInput;
  readonly nowMs?: number;
  readonly onResult?: (result: ProviderSessionPrewarmResult) => void;
}): boolean {
  const call = input.api?.server?.prewarmProviderSession;
  if (!input.supported || !input.api || !call) return false;
  const nowMs = input.nowMs ?? Date.now();
  let byThread = lastRequests.get(input.api);
  if (!byThread) {
    byThread = new Map();
    lastRequests.set(input.api, byThread);
  }
  const key = requestKey(input.request);
  const last = byThread.get(input.request.threadId);
  if (
    last !== undefined &&
    (nowMs - last.atMs < SESSION_PREWARM_MIN_INTERVAL_MS ||
      (last.key === key && nowMs - last.atMs < SESSION_PREWARM_REPEAT_MS))
  ) {
    return false;
  }
  byThread.set(input.request.threadId, { key, atMs: nowMs });
  void call(input.request).then(
    (result) => input.onResult?.(result),
    () => {
      // Best effort: the send starts the session itself.
    },
  );
  return true;
}
