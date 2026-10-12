import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  type UsageSummary,
  type UsageSummaryRequest,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { UsageContractMismatchError } from "./compatibility.ts";
import { readUsageEnvironmentResult, UsageSummaryCache } from "./summaryCache.ts";

const environmentId = EnvironmentId.make("synthetic-node");
const NOW = Date.parse("2026-08-10T12:00:00.000Z");

function summary(request: UsageSummaryRequest, status: "complete" | "partial" = "complete") {
  return {
    contractVersion: USAGE_CONTRACT_VERSION,
    ...(request.startDate === undefined ? {} : { startDate: request.startDate }),
    endDate: request.endDate,
    timeZone: request.timeZone,
    generatedAt: "2026-08-10T12:00:00.000Z",
    scanDurationMs: 1,
    buckets: [],
    sources: [
      {
        sourceId: "source",
        provider: "claude",
        deduplicationKind: "physical",
        status,
        transcriptFileCount: 1,
        reusedCacheFileCount: 1,
        parsedFileCount: 0,
        skippedLineCount: 0,
        malformedLineCount: 0,
        distinctSessionCount: 0,
        distinctResponseCount: 0,
        scanStartedAt: "2026-08-10T12:00:00.000Z",
        scanFinishedAt: "2026-08-10T12:00:00.000Z",
        scanDurationMs: 1,
      },
    ],
    pricing: { state: "cached", recognizedModelCount: 0, unrecognizedModelCount: 0 },
  } satisfies UsageSummary;
}

describe("usage summary cache", () => {
  it("shares identical in-flight requests and keeps the last usable result per view", async () => {
    let resolve: ((value: UsageSummary) => void) | undefined;
    const getUsageSummary = vi.fn(
      (request: UsageSummaryRequest) =>
        new Promise<UsageSummary>((done) => {
          resolve = () => done(summary(request));
        }),
    );
    const cache = new UsageSummaryCache();
    const target = { environmentId, label: "Node", getUsageSummary };
    expect(cache.peek(environmentId, "30d", "UTC")).toBeUndefined();
    const first = cache.load(target, "30d", "UTC", { nowMs: NOW });
    const second = cache.load(target, "30d", "UTC", { nowMs: NOW });
    expect(second).toBe(first);
    expect(getUsageSummary).toHaveBeenCalledTimes(1);
    resolve?.(undefined as never);
    expect((await first).status).toBe("complete");
    expect(cache.peek(environmentId, "30d", "UTC")).toBe(await first);
    expect(cache.peek(environmentId, "7d", "UTC")).toBeUndefined();
    // A settled request is not reused: the next load asks the node again.
    void cache.load(target, "30d", "UTC", { nowMs: NOW });
    expect(getUsageSummary).toHaveBeenCalledTimes(2);
  });

  it("never caches failures and evicts the least recently stored view", async () => {
    const cache = new UsageSummaryCache(1);
    const failing = {
      environmentId,
      label: "Node",
      getUsageSummary: () => Promise.reject(new Error("offline")),
    };
    expect((await cache.load(failing, "7d", "UTC", { nowMs: NOW })).status).toBe("failed");
    expect(cache.peek(environmentId, "7d", "UTC")).toBeUndefined();
    const working = {
      environmentId,
      label: "Node",
      getUsageSummary: (request: UsageSummaryRequest) => Promise.resolve(summary(request)),
    };
    await cache.load(working, "7d", "UTC", { nowMs: NOW });
    await cache.load(working, "90d", "UTC", { nowMs: NOW });
    expect(cache.peek(environmentId, "7d", "UTC")).toBeUndefined();
    expect(cache.peek(environmentId, "90d", "UTC")?.status).toBe("complete");
  });

  it("hands a settled prefetch to the next view once, then revalidates", async () => {
    const getUsageSummary = vi.fn((request: UsageSummaryRequest) =>
      Promise.resolve(summary(request)),
    );
    let now = NOW;
    const cache = new UsageSummaryCache(32, { now: () => now });
    const target = { environmentId, label: "Node", getUsageSummary };
    cache.prefetch(target, "30d", "UTC", NOW);
    // A second prefetch (another hover) while it runs asks nothing.
    cache.prefetch(target, "30d", "UTC", NOW);
    expect(getUsageSummary).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(cache.peek(environmentId, "30d", "UTC")).toBeDefined());
    // The view that mounts right after takes the prefetched answer...
    now += 1_000;
    const handedOff = await cache.load(target, "30d", "UTC", { nowMs: NOW });
    expect(handedOff.status).toBe("complete");
    expect(getUsageSummary).toHaveBeenCalledTimes(1);
    // ...exactly once: a remount revalidates.
    await cache.load(target, "30d", "UTC", { nowMs: NOW });
    expect(getUsageSummary).toHaveBeenCalledTimes(2);
  });

  it("withdraws a superseded request only once no caller waits for it", async () => {
    const signals: AbortSignal[] = [];
    const getUsageSummary = vi.fn(
      (_request: UsageSummaryRequest, options?: { readonly signal?: AbortSignal }) => {
        if (options?.signal !== undefined) signals.push(options.signal);
        return new Promise<UsageSummary>(() => undefined);
      },
    );
    const cache = new UsageSummaryCache();
    const target = { environmentId, label: "Node", getUsageSummary };
    const first = new AbortController();
    const second = new AbortController();
    void cache.load(target, "7d", "UTC", { nowMs: NOW, signal: first.signal });
    void cache.load(target, "7d", "UTC", { nowMs: NOW, signal: second.signal });
    expect(getUsageSummary).toHaveBeenCalledTimes(1);
    first.abort();
    expect(signals[0]?.aborted).toBe(false);
    second.abort();
    expect(signals[0]?.aborted).toBe(true);
    // The next view asks again instead of joining the withdrawn request.
    void cache.load(target, "7d", "UTC", { nowMs: NOW });
    expect(getUsageSummary).toHaveBeenCalledTimes(2);
  });

  it("classifies partial coverage and contract mismatches", async () => {
    const request = {
      contractVersion: USAGE_CONTRACT_VERSION,
      endDate: "2026-08-10",
      timeZone: "UTC",
    } as const;
    const partial = await readUsageEnvironmentResult(
      {
        environmentId,
        label: "Node",
        getUsageSummary: () => Promise.resolve(summary(request, "partial")),
      },
      request,
    );
    expect(partial.status).toBe("partial");
    const stale = await readUsageEnvironmentResult(
      {
        environmentId,
        label: "Node",
        getUsageSummary: () => Promise.reject(new UsageContractMismatchError()),
      },
      request,
    );
    expect(stale.status).toBe("stale-contract");
  });
});
