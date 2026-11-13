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
  type StatisticsMachineUsage,
  type StatisticsSnapshot,
  USAGE_CONTRACT_VERSION,
  type UsageReadError,
  type UsageSummary,
  type UsageSummaryRequest,
} from "@ryco/contracts";
import { Context, Effect, type Path } from "effect";

/** A directory that belongs to a Ryco project: its workspace or one of its worktrees. */
export interface MachineProjectRoot {
  readonly path: string;
  readonly projectId: string;
  /** Deleted projects still own their directories, but a live project wins a tie. */
  readonly deleted?: boolean;
}

/** What Statistics know about Ryco's own threads, to place session files beside them. */
export interface MachineStatisticsRequest {
  /** The provider session ids of Ryco's threads (Claude session ids, Codex thread ids). */
  readonly rycoSessionIds: {
    readonly claude: readonly string[];
    readonly codex: readonly string[];
  };
  readonly projectRoots: readonly MachineProjectRoot[];
  /** How long to wait for a read in progress before answering with the previous one. */
  readonly maxWaitMs: number;
}

export interface UsageServiceShape {
  readonly readSummary: (input: UsageSummaryRequest) => Effect.Effect<UsageSummary, UsageReadError>;
  /**
   * Settings → Statistics with each bucket's `costUsd` at the rates and custom prices usage
   * uses. Never fails: without rates the buckets stay unpriced.
   */
  readonly priceStatistics: (snapshot: StatisticsSnapshot) => Effect.Effect<StatisticsSnapshot>;
  /**
   * Ryco's snapshot with the Claude Code and Codex sessions this node ran outside Ryco added
   * (`scope: "machine"`, unpriced). Reads the session files in the background on first use and
   * answers with the previous read (and `machine.progress`) while one runs. Never fails: a read
   * that cannot run reports `machine.state: "failed"`.
   */
  readonly machineStatistics: (
    snapshot: StatisticsSnapshot,
    request: MachineStatisticsRequest,
  ) => Effect.Effect<StatisticsSnapshot>;
}

/** The machine status of a node that cannot read session files (or a failed load). */
export const emptyMachineUsage = (
  state: StatisticsMachineUsage["state"],
): StatisticsMachineUsage => ({
  state,
  fileCount: 0,
  totalBytes: 0,
  parsedFileCount: 0,
  reusedFileCount: 0,
  malformedLineCount: 0,
  failedFileCount: 0,
  unreadableDirectoryCount: 0,
  duplicateResponseCount: 0,
  rycoResponseCount: 0,
  outsideSessionCount: 0,
});

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
  priceStatistics: (snapshot) => Effect.succeed(snapshot),
  machineStatistics: (snapshot) =>
    Effect.succeed({ ...snapshot, scope: "machine", machine: emptyMachineUsage("ready") }),
});

/** The usage pipeline's own state (rates, scan cache) under the server state directory. */
export const usageStateDirectory = (path: Path.Path, stateDir: string): string =>
  path.join(stateDir, "usage");

/** The last downloaded rate table; it exists once usage has been opened on this node. */
export const usageRatesCachePath = (path: Path.Path, stateDir: string): string =>
  path.join(usageStateDirectory(path, stateDir), "pricing-cache.json");
