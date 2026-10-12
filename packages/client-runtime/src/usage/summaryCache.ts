// @effect-diagnostics globalDate:off
import type { EnvironmentId } from "@ryco/contracts";
import {
  USAGE_CONTRACT_VERSION,
  type UsageSummary,
  type UsageSummaryRequest,
} from "@ryco/contracts/usage";

import { isUsageContractMismatch } from "./compatibility.ts";
import type { UsageEnvironmentResult } from "./merge.ts";
import { usageRequestForRange, type UsageSummaryRange } from "./request.ts";
import { SharedRequests, type SharedRequestOptions } from "./sharedRequests.ts";

/** One environment that can answer usage summary requests. */
export interface UsageSummaryTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly getUsageSummary: (
    input: UsageSummaryRequest,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<UsageSummary>;
}

/** Request one environment's summary and classify the outcome. Never rejects. */
export async function readUsageEnvironmentResult(
  target: UsageSummaryTarget,
  request: UsageSummaryRequest,
  signal?: AbortSignal,
): Promise<UsageEnvironmentResult> {
  const base = { environmentId: target.environmentId, label: target.label };
  try {
    const summary = await (signal === undefined
      ? target.getUsageSummary(request)
      : target.getUsageSummary(request, { signal }));
    if (summary.contractVersion !== USAGE_CONTRACT_VERSION) {
      return {
        ...base,
        status: "stale-contract",
        message: "This environment uses an incompatible usage contract.",
      };
    }
    const partial = summary.sources.some(
      (source) => source.status === "partial" || source.status === "failed",
    );
    return { ...base, status: partial ? "partial" : "complete", summary };
  } catch (cause) {
    return {
      ...base,
      status: isUsageContractMismatch(cause) ? "stale-contract" : "failed",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

function hasUsableSummary(result: UsageEnvironmentResult): boolean {
  return (
    result.summary !== undefined && (result.status === "complete" || result.status === "partial")
  );
}

const DEFAULT_RESULT_LIMIT = 32;

export interface UsageSummaryLoadOptions extends SharedRequestOptions {
  readonly nowMs?: number;
}

/**
 * Last usable result per (environment, range, time zone), so a reopened view
 * paints immediately and refreshes in the background, plus sharing of
 * identical in-flight requests (a remount or a second view does not start
 * another server scan) and prefetches a view can join (see {@link SharedRequests}).
 */
export class UsageSummaryCache {
  readonly #results = new Map<string, UsageEnvironmentResult>();
  readonly #requests: SharedRequests<UsageEnvironmentResult>;
  readonly #limit: number;

  constructor(
    limit = DEFAULT_RESULT_LIMIT,
    options: { readonly handoffMs?: number; readonly now?: () => number } = {},
  ) {
    this.#limit = limit;
    this.#requests = new SharedRequests(options);
  }

  /** The last usable result for this view, if any (possibly from an earlier day). */
  peek(
    environmentId: EnvironmentId,
    range: UsageSummaryRange,
    timeZone: string,
  ): UsageEnvironmentResult | undefined {
    return this.#results.get(resultKey(environmentId, range, timeZone));
  }

  /** The view's own request: joins an identical one in flight or takes a fresh prefetched answer. */
  load(
    target: UsageSummaryTarget,
    range: UsageSummaryRange,
    timeZone: string,
    options: UsageSummaryLoadOptions = {},
  ): Promise<UsageEnvironmentResult> {
    const request = usageRequestForRange(range, timeZone, options.nowMs ?? Date.now());
    return this.#requests.request(
      flightKey(target.environmentId, request),
      (signal) => this.#read(target, range, request, signal),
      options,
    );
  }

  /** Start the request a view of `range` is about to make (route loader, link intent). */
  prefetch(
    target: UsageSummaryTarget,
    range: UsageSummaryRange,
    timeZone: string,
    nowMs = Date.now(),
  ): void {
    const request = usageRequestForRange(range, timeZone, nowMs);
    this.#requests.prefetch(
      flightKey(target.environmentId, request),
      (signal) => this.#read(target, range, request, signal),
      hasUsableSummary,
    );
  }

  clear(): void {
    this.#results.clear();
    this.#requests.clear();
  }

  async #read(
    target: UsageSummaryTarget,
    range: UsageSummaryRange,
    request: UsageSummaryRequest,
    signal: AbortSignal,
  ): Promise<UsageEnvironmentResult> {
    const result = await readUsageEnvironmentResult(target, request, signal);
    if (hasUsableSummary(result)) {
      const key = resultKey(target.environmentId, range, request.timeZone);
      this.#results.delete(key);
      this.#results.set(key, result);
      while (this.#results.size > this.#limit) {
        const oldest = this.#results.keys().next().value;
        if (oldest === undefined) break;
        this.#results.delete(oldest);
      }
    }
    return result;
  }
}

function resultKey(environmentId: EnvironmentId, range: UsageSummaryRange, timeZone: string) {
  return `${environmentId}\0${range}\0${timeZone}`;
}

function flightKey(environmentId: EnvironmentId, request: UsageSummaryRequest) {
  return `${environmentId}\0${request.startDate ?? ""}\0${request.endDate}\0${request.timeZone}`;
}

/** Shared by every usage view in this client. */
export const usageSummaryCache = new UsageSummaryCache();
