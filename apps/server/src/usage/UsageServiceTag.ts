/**
 * UsageServiceTag - the part of the usage service the server needs at boot.
 *
 * The `UsageService` tag and its shape, the empty summary of test and tool runtimes, and where
 * the usage pipeline keeps its downloaded rates. The pipeline itself (`UsageService.ts`) is
 * loaded by `UsageServiceDeferred.ts` on first use, so it stays off the boot path
 * (serverBundleBoundaries.test.ts).
 *
 * @module UsageServiceTag
 */
import {
  USAGE_CONTRACT_VERSION,
  type UsageReadError,
  type UsageSummary,
  type UsageSummaryRequest,
} from "@ryco/contracts";
import { Context, Effect, type Path } from "effect";

export interface UsageServiceShape {
  readonly readSummary: (input: UsageSummaryRequest) => Effect.Effect<UsageSummary, UsageReadError>;
}

export class UsageService extends Context.Service<UsageService, UsageServiceShape>()(
  "ryco/usage/UsageService",
) {}

export const makeEmptyUsageSummary = (input: UsageSummaryRequest): UsageSummary => ({
  contractVersion: USAGE_CONTRACT_VERSION,
  ...(input.startDate === undefined ? {} : { startDate: input.startDate }),
  endDate: input.endDate,
  timeZone: input.timeZone,
  generatedAt: "1970-01-01T00:00:00.000Z",
  scanDurationMs: 0,
  buckets: [],
  sources: [],
  pricing: {
    state: "unavailable",
    recognizedModelCount: 0,
    unrecognizedModelCount: 0,
  },
});

export const UsageServiceTest = UsageService.of({
  readSummary: (input) => Effect.succeed(makeEmptyUsageSummary(input)),
});

/** Refresh stale cached rates once shortly after boot, before a summary needs them. */
export const USAGE_RATES_WARM_DELAY_MS = 30_000;

/** The usage pipeline's own state (rates, scan cache) under the server state directory. */
export const usageStateDirectory = (path: Path.Path, stateDir: string): string =>
  path.join(stateDir, "usage");

/** The last downloaded rate table; it exists once usage has been opened on this node. */
export const usageRatesCachePath = (path: Path.Path, stateDir: string): string =>
  path.join(usageStateDirectory(path, stateDir), "pricing-cache.json");
