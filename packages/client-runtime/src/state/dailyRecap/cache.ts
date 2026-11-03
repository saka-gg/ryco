// @effect-diagnostics globalDate:off
import type { EnvironmentId } from "@ryco/contracts";
import type { DailyRecapRequest, DailyRecapSnapshot } from "@ryco/contracts/daily-recap";

import { REMOTE_CONTROL_PLANE_REQUEST_TIMEOUT_MS } from "../../connection/fetchWithDeadline.ts";
import { hasErrorTag, isAwaitingAdmission, RpcRequestRefusedError } from "../../rpc/protocol.ts";
import { isUnsupportedRpcError } from "../../rpc/wsTransport.ts";
import { SharedRequests, type SharedRequestOptions } from "../../usage/sharedRequests.ts";

/**
 * How long one node may take to answer. A node that does not answer in time
 * (asleep, behind a dropped relay) counts as offline, so it never holds the view.
 */
export const DAILY_RECAP_NODE_TIMEOUT_MS = REMOTE_CONTROL_PLANE_REQUEST_TIMEOUT_MS;

const READ_FAILED_MESSAGE = "Couldn't read the recap.";

const DEFAULT_RECAP_LIMIT = 32;

/** One node that can answer daily recap requests. */
export interface DailyRecapTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly getDailyRecap: (
    input: DailyRecapRequest,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<DailyRecapSnapshot>;
}

interface DailyRecapNode {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Client time the request was sent: the result is at least this recent. */
  readonly requestedAtMs: number;
}

export interface ReadyDailyRecap extends DailyRecapNode {
  readonly status: "ready";
  readonly snapshot: DailyRecapSnapshot;
}

/**
 * Why a node has no recap: `offline` did not answer in time or its session is
 * not ready yet, `unsupported` predates the recap, `forbidden` refuses this
 * session (the recap is owner-only), `failed` could not read it.
 */
type DailyRecapFailure =
  | { readonly status: "offline" | "unsupported" | "forbidden" }
  | {
      readonly status: "failed";
      /** Safe to show: the node's own explanation, or a generic one. */
      readonly message: string;
    };

export type DailyRecapNodeIssue = DailyRecapNode & DailyRecapFailure;

export type DailyRecapNodeResult = ReadyDailyRecap | DailyRecapNodeIssue;

/** Transport text never reaches the view: only the node's own read error explains itself. */
function classifyDailyRecapFailure(cause: unknown): DailyRecapFailure {
  if (isUnsupportedRpcError(cause)) return { status: "unsupported" };
  if (hasErrorTag(cause, "AuthRpcError")) return { status: "forbidden" };
  if (cause instanceof RpcRequestRefusedError) {
    return { status: isAwaitingAdmission(cause) ? "offline" : "forbidden" };
  }
  const detail = hasErrorTag(cause, "DailyRecapReadError")
    ? (cause as { readonly detail?: unknown }).detail
    : undefined;
  return { status: "failed", message: typeof detail === "string" ? detail : READ_FAILED_MESSAGE };
}

export interface DailyRecapReadOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/**
 * Ask one node for its recap and classify the outcome. Never rejects. The
 * deadline and a cancellation abort the request and settle the caller
 * themselves: a request to a node whose socket is down waits for a reconnect
 * before the transport looks at its signal. The timer is manual rather than
 * `AbortSignal.timeout`/`AbortSignal.any`, which React Native does not provide.
 */
export async function readDailyRecapNode(
  target: DailyRecapTarget,
  request: DailyRecapRequest,
  options: DailyRecapReadOptions = {},
): Promise<DailyRecapNodeResult> {
  const node = {
    environmentId: target.environmentId,
    label: target.label,
    requestedAtMs: (options.now ?? Date.now)(),
  };
  const callerSignal = options.signal;
  if (callerSignal?.aborted) return { ...node, status: "failed", message: READ_FAILED_MESSAGE };
  const controller = new AbortController();
  let stop: (result: DailyRecapNodeResult) => void = () => undefined;
  const stopped = new Promise<DailyRecapNodeResult>((resolve) => {
    stop = (result) => {
      controller.abort();
      resolve(result);
    };
  });
  const timer = setTimeout(
    () => stop({ ...node, status: "offline" }),
    options.timeoutMs ?? DAILY_RECAP_NODE_TIMEOUT_MS,
  );
  const onCallerAbort = () => stop({ ...node, status: "failed", message: READ_FAILED_MESSAGE });
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const answered = (async (): Promise<DailyRecapNodeResult> => {
    try {
      const snapshot = await target.getDailyRecap(request, { signal: controller.signal });
      return { ...node, status: "ready", snapshot };
    } catch (cause) {
      return { ...node, ...classifyDailyRecapFailure(cause) };
    }
  })();
  try {
    return await Promise.race([answered, stopped]);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

function isReady(result: DailyRecapNodeResult): result is ReadyDailyRecap {
  return result.status === "ready";
}

export interface DailyRecapLoadOptions extends SharedRequestOptions {
  /**
   * Only an answer to a request sent at or after this client time will do (a
   * turn finished then). A request already out since earlier is joined, then
   * asked again once it settles, because its answer may miss that turn.
   */
  readonly sinceMs?: number | undefined;
}

/**
 * The last recap per (node, day, time zone, limit), so a reopened view paints
 * it at once and refreshes in the background, plus sharing of identical
 * in-flight requests and of the route's prefetch (see {@link SharedRequests}).
 * Failures are never kept.
 *
 * Recaps are owner-only node data that hold thread titles: they stay in
 * memory, one node's recap is never handed to another, and {@link forget} /
 * {@link clear} also discard answers still in flight when they ran, so a node
 * switch or an account teardown cannot be repopulated by the connection it
 * just left.
 */
export class DailyRecapCache {
  readonly #recaps = new Map<string, ReadyDailyRecap>();
  // One per node, so forgetting a node drops all of its flights and no other node's.
  readonly #requests = new Map<EnvironmentId, SharedRequests<DailyRecapNodeResult>>();
  readonly #generations = new Map<EnvironmentId, number>();
  readonly #limit: number;
  readonly #handoffMs: number | undefined;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  #epoch = 0;

  constructor(
    options: {
      readonly limit?: number;
      readonly handoffMs?: number;
      readonly now?: () => number;
      readonly timeoutMs?: number;
    } = {},
  ) {
    this.#limit = options.limit ?? DEFAULT_RECAP_LIMIT;
    this.#handoffMs = options.handoffMs;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? DAILY_RECAP_NODE_TIMEOUT_MS;
  }

  /** The last recap this client received from `environmentId` for `request`, if any. */
  peek(environmentId: EnvironmentId, request: DailyRecapRequest): ReadyDailyRecap | undefined {
    return this.#recaps.get(recapKey(environmentId, request));
  }

  /** The view's own request: joins an identical one in flight or takes a fresh prefetched answer. */
  async load(
    target: DailyRecapTarget,
    request: DailyRecapRequest,
    options: DailyRecapLoadOptions = {},
  ): Promise<DailyRecapNodeResult> {
    const read = (signal: AbortSignal) => this.#read(target, request, signal);
    const result = await this.#requestsFor(target.environmentId).request(
      flightKey(request),
      read,
      options,
    );
    const { sinceMs, signal } = options;
    if (sinceMs === undefined || result.requestedAtMs >= sinceMs || signal?.aborted === true) {
      return result;
    }
    // Sent before `sinceMs`, so ask again; a request out by now was sent after it and may be joined.
    return this.#requestsFor(target.environmentId).request(flightKey(request), read, {
      signal,
      fresh: true,
    });
  }

  /** Start the request a view is about to make (route loader, link intent). */
  prefetch(target: DailyRecapTarget, request: DailyRecapRequest): void {
    this.#requestsFor(target.environmentId).prefetch(
      flightKey(request),
      (signal) => this.#read(target, request, signal),
      isReady,
    );
  }

  /** Drop one node's recaps, prefetched answers and in-flight sharing. */
  forget(environmentId: EnvironmentId): void {
    this.#generations.set(environmentId, this.#generation(environmentId) + 1);
    const prefix = `${environmentId}\0`;
    for (const key of this.#recaps.keys()) {
      if (key.startsWith(prefix)) this.#recaps.delete(key);
    }
    this.#requests.get(environmentId)?.clear();
    this.#requests.delete(environmentId);
  }

  /** Drop every recap, e.g. when the signed-in account goes away. */
  clear(): void {
    this.#epoch += 1;
    this.#recaps.clear();
    for (const requests of this.#requests.values()) requests.clear();
    this.#requests.clear();
  }

  #requestsFor(environmentId: EnvironmentId): SharedRequests<DailyRecapNodeResult> {
    let requests = this.#requests.get(environmentId);
    if (requests === undefined) {
      requests = new SharedRequests({
        ...(this.#handoffMs === undefined ? {} : { handoffMs: this.#handoffMs }),
        now: this.#now,
      });
      this.#requests.set(environmentId, requests);
    }
    return requests;
  }

  async #read(
    target: DailyRecapTarget,
    request: DailyRecapRequest,
    signal: AbortSignal,
  ): Promise<DailyRecapNodeResult> {
    const { environmentId } = target;
    const epoch = this.#epoch;
    const generation = this.#generation(environmentId);
    const result = await readDailyRecapNode(target, request, {
      signal,
      timeoutMs: this.#timeoutMs,
      now: this.#now,
    });
    if (
      isReady(result) &&
      epoch === this.#epoch &&
      generation === this.#generation(environmentId)
    ) {
      const key = recapKey(environmentId, request);
      this.#recaps.delete(key);
      this.#recaps.set(key, result);
      while (this.#recaps.size > this.#limit) {
        const oldest = this.#recaps.keys().next().value;
        if (oldest === undefined) break;
        this.#recaps.delete(oldest);
      }
    }
    return result;
  }

  #generation(environmentId: EnvironmentId): number {
    return this.#generations.get(environmentId) ?? 0;
  }
}

function flightKey(request: DailyRecapRequest): string {
  return `${request.date}\0${request.timeZone}\0${request.limit ?? ""}`;
}

function recapKey(environmentId: EnvironmentId, request: DailyRecapRequest): string {
  return `${environmentId}\0${flightKey(request)}`;
}

/** Shared by every recap view in this client. */
export const dailyRecapCache = new DailyRecapCache();
