import type { HttpClientService, HttpRequestInit, HttpResponse } from "../platform/index.ts";

/**
 * Deadline for a control-plane request to the node this client is served by
 * (session state, bootstrap exchange, descriptor, WebSocket token). They answer
 * in about a millisecond; a request that does not answer at all — one that
 * reached a restarting server just before it listened, or a half-open socket
 * after sleep — would otherwise hold its caller, and one of the browser's six
 * connections per origin, until the page reloads.
 */
export const CONTROL_PLANE_REQUEST_TIMEOUT_MS = 5_000;
/** The same deadline for a saved environment, which may sit behind a slower link. */
export const REMOTE_CONTROL_PLANE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * A control-plane request did not finish within its deadline. Named like the
 * platform's own `AbortSignal.timeout` reason, so retry policies that treat
 * timeouts as transient classify it the same way.
 */
export class ControlPlaneRequestTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    super(`Request to ${url} did not answer within ${timeoutMs} ms.`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Errors a deadline or a cancellation produce, which a retry may outlive. */
export function isAbortOrTimeoutError(error: unknown): boolean {
  const name = (error as { readonly name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

/** The rejection a cancelled request settles with, named like the platform's own. */
function abortErrorFor(signal: AbortSignal): unknown {
  const reason = (signal as { readonly reason?: unknown }).reason;
  if (isAbortOrTimeoutError(reason)) return reason;
  const error = new Error("The request was aborted.");
  error.name = "AbortError";
  return error;
}

/**
 * `httpClient.fetch` bounded by a deadline that covers the response body as
 * well as its headers. A caller `signal` still cancels the request early. The
 * timer is manual rather than `AbortSignal.timeout`/`AbortSignal.any`, which
 * React Native does not provide. The deadline and a cancellation abort the
 * request and also settle the caller themselves, so an adapter whose fetch
 * does not honour the signal cannot hold its caller past either.
 */
export async function fetchWithDeadline(
  httpClient: HttpClientService,
  url: string,
  init: HttpRequestInit = {},
  timeoutMs: number = CONTROL_PLANE_REQUEST_TIMEOUT_MS,
): Promise<HttpResponse> {
  const controller = new AbortController();
  const callerSignal = init.signal;
  let rejectStopped: (error: unknown) => void = () => undefined;
  // Rejects once the deadline passes or the caller cancels; never resolves.
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject;
  });
  stopped.catch(() => undefined);
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  };
  const stop = (error: unknown) => {
    settle();
    rejectStopped(error);
    controller.abort();
  };
  const onCallerAbort = () => stop(abortErrorFor(callerSignal!));
  const timer = setTimeout(
    () => stop(new ControlPlaneRequestTimeoutError(url, timeoutMs)),
    timeoutMs,
  );
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort);

  let response: HttpResponse;
  try {
    response = await Promise.race([
      httpClient.fetch(url, { ...init, signal: controller.signal }),
      stopped,
    ]);
  } catch (error) {
    settle();
    throw error;
  }
  const readBody = async <T>(read: () => Promise<T>): Promise<T> => {
    try {
      return await Promise.race([read(), stopped]);
    } finally {
      settle();
    }
  };
  return {
    ok: response.ok,
    status: response.status,
    json: () => readBody(() => response.json()),
    text: () => readBody(() => response.text()),
  };
}
