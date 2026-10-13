// @effect-diagnostics globalDate:off
// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";

import {
  USAGE_CONTRACT_VERSION,
  UsageReadError,
  type UsageCalendarDate,
  type UsageDailyBucket,
  type UsageImportedMetric,
  type UsagePricingStatus,
  type UsageProviderKind,
  type UsageSourceCoverage,
  type UsageSourceDeduplicationKind,
  type UsageSummary,
  type UsageSummaryRequest,
} from "@ryco/contracts";
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Schema,
} from "effect";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientResponse } from "effect/http";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { resolveProviderSourceLayout } from "../provider/ProviderSourceLayout.ts";
import { resolveClaudeHomePath, resolveClaudeSourceRoot } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { UsageAggregator } from "./usageAggregation.ts";
import {
  buildUsageFileAggregate,
  EMPTY_USAGE_FILE_AGGREGATE,
  type UsageFileAggregate,
  UsageSlotAggregator,
} from "./usageFileAggregate.ts";
import {
  lookupUsageModelRate,
  encodeUsageRateTable,
  parseUsageRateTable,
  priceUsageRecord,
  type UsageRateTable,
} from "./usagePricing.ts";
import {
  anonymizeScanCachedUsageRecord,
  capUsageScanCache,
  matchesUsageFileCache,
  deduplicateUsageRecordsWithinFile,
  pruneUsageScanCache,
  usageCacheFileKey,
  usageCacheRootKey,
} from "./usageScanCache.ts";
import { makeUsageScanCacheStore, USAGE_SCAN_CACHE_RECORD_LIMIT } from "./usageScanCacheStore.ts";
import {
  cursorExportSourceId,
  readCursorExportUsage,
  type CursorExportSource,
} from "./cursorExportUsageReader.ts";
import { readOpenCodeUsage } from "./opencodeUsageReader.ts";
import { resolveNativeUsageSources } from "./usageNativeSources.ts";
import { resolveUsageSourceIdentity } from "./usageSourceIdentity.ts";
import {
  listUsageTranscriptFiles,
  createUsageTranscriptReader,
  type UsageTranscriptFile,
  type UsageTranscriptListing,
} from "./usageTranscriptReader.ts";
import { readBoundedUsageFile } from "./usageFileReader.ts";
import type { UsageRecord } from "./usageRecord.ts";

export const LITELLM_USAGE_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const RATES_TTL_MS = 24 * 60 * 60 * 1000;
/** After a fetch attempt, wait this long before trying again (also bounds failed retries). */
const RATES_RETRY_MS = 60 * 60 * 1000;
const RATES_FETCH_TIMEOUT_MS = 10_000;
/** With no rates at all, a summary waits at most this long for the first download. */
const RATES_FIRST_FETCH_WAIT_MS = 2_000;
/** Refresh stale cached rates once shortly after boot, before a summary needs them. */
const RATES_WARM_DELAY_MS = 30_000;
const MTIME_WINDOW_SLACK_MS = 36 * 60 * 60 * 1000;
const PRICING_CACHE_VERSION = 2;
/** Freshly parsed work per source and request. Cached records do not count against it. */
const SOURCE_SCAN_BYTES = 4 * 1024 * 1024 * 1024;
const SOURCE_SCAN_RECORDS = 100_000;
const SOURCE_SCAN_DURATION_MS = 5_000;
/** Aggregating a cached record costs about a microsecond; this only bounds pathological caches. */
const SOURCE_CACHED_RECORDS = 2_000_000;
const SUMMARY_SCAN_DURATION_MS = 30_000;
const SUMMARY_SOURCE_LIMIT = 128;
/** Independent sources are listed and read concurrently (mostly file I/O). */
const SUMMARY_SOURCE_CONCURRENCY = 2;
const SCAN_CACHE_RETENTION_MS = 120 * 24 * 60 * 60 * 1000;
/** Coalesce the scan-cache writes of quick successive summaries, off the request path. */
const SCAN_CACHE_PERSIST_DELAY_MS = 1_000;
/** Release the scan cache and parser checkpoints after this long without a summary. */
const SCAN_CACHE_IDLE_MS = 10 * 60 * 1000;
/** Memoized per-source results (one per source and requested window). */
const SOURCE_MEMO_LIMIT = 32;

interface PersistedRates {
  readonly version: number;
  readonly fetchedAtMs: number;
  readonly revision: string;
  readonly document: unknown;
}

interface ResolvedTranscriptSource {
  readonly provider: UsageProviderKind;
  readonly identityRoot: string;
  readonly scanRoots: readonly string[];
  readonly databasePath?: string;
  readonly allowLegacy?: boolean;
  readonly unsupportedCode?: string;
  readonly cursorExport?: CursorExportSource;
}

interface CachedReadResult {
  readonly aggregate: UsageFileAggregate;
  readonly reused: boolean;
  readonly skippedLineCount: number;
  readonly malformedLineCount: number;
  readonly failed: boolean;
}

interface PlannedSource {
  readonly source: ResolvedTranscriptSource;
  readonly sourceId: string;
  readonly deduplicationKind: UsageSourceDeduplicationKind;
}

/** Rates and pricing status captured once per summary, so every source prices alike. */
interface PricingSnapshot {
  readonly rates: UsageRateTable;
  readonly generation: number;
  readonly state: UsagePricingStatus["state"];
  readonly revision: string | null;
  readonly fetchedAtMs: number | null;
}

interface SummaryContext {
  readonly input: UsageSummaryRequest;
  readonly scanStartedAtMs: number;
  readonly windowStartMs: number;
  readonly pricing: PricingSnapshot;
}

/** One source's contribution to a summary. */
interface SourceScan {
  readonly coverage: UsageSourceCoverage;
  readonly buckets: readonly UsageDailyBucket[];
  readonly imports: readonly UsageImportedMetric[];
  readonly recognizedModels: readonly string[];
  readonly unrecognizedModels: readonly string[];
  readonly liveFileKeys: readonly string[];
  readonly walkedRootKeys: readonly string[];
}

interface SourceMemo {
  readonly fingerprint: string;
  readonly scan: SourceScan;
}

interface SourceTally {
  transcriptFileCount: number;
  reusedCacheFileCount: number;
  parsedFileCount: number;
  skippedLineCount: number;
  malformedLineCount: number;
  listingErrorCount: number;
  failedFileCount: number;
  budgetLimitedFileCount: number;
  existingRootCount: number;
}

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

export const UsageServiceTestLayer = Layer.succeed(UsageService, UsageServiceTest);

function isValidCalendarDate(value: UsageCalendarDate): boolean {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function startOfCalendarDateMs(value: UsageCalendarDate): number {
  return Date.parse(`${value}T00:00:00.000Z`);
}

function iso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function parseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Revision of the downloaded document, from its raw text (no re-serialization). */
function ratesRevision(text: string): string {
  return `litellm-${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

function summaryRequestKey(input: UsageSummaryRequest): string {
  return `${input.contractVersion}\0${input.startDate ?? ""}\0${input.endDate}\0${input.timeZone}`;
}

/** Everything a transcript source's result depends on besides the request and rates. */
function listingFingerprint(
  existingRootCount: number,
  listings: ReadonlyArray<{ readonly rootKey: string; readonly listing: UsageTranscriptListing }>,
): string {
  const hash = createHash("sha256").update(`${existingRootCount}`);
  for (const { rootKey, listing } of listings) {
    hash.update(`\u0002${rootKey}\0${listing.errorCount}\0${listing.skippedEntryCount}`);
    for (const file of listing.files) {
      hash.update(`\u0001${file.path}\0${file.size}\0${file.mtimeMs}\0${file.fingerprint ?? ""}`);
    }
  }
  return hash.digest("hex");
}

function coverageMessage(
  source: ResolvedTranscriptSource,
  status: UsageSourceCoverage["status"],
  diagnosticCode: string | undefined,
): string | undefined {
  if (source.cursorExport !== undefined)
    return status === "partial"
      ? `Saved Cursor Admin API export: billed costs are separate from model costs. Exports may omit pages or token fields, and identical events cannot be distinguished without stable event IDs. Diagnostics: ${diagnosticCode ?? "unavailable"}.`
      : "The configured Cursor JSON exports could not be imported. Check the path, account key, user filter, and format.";
  if (status === "unsupported")
    return source.provider === "cursor"
      ? "Configure saved Cursor Admin API JSON exports in this instance’s provider settings. Automatic consumer CLI history is unavailable; Ryco never reads account credentials."
      : "This OpenCode history source or format is unsupported. Usage is unavailable.";
  if (status === "not-found") return "No transcript directory was found for this provider.";
  if (status === "partial" || status === "failed")
    return diagnosticCode === "transcript-scan-budget"
      ? "Some provider history was not read within this scan's time and size budget. Refresh to continue reading it."
      : "Some provider history could not be read or lacked trustworthy usage telemetry.";
  return undefined;
}

const makeUsageService = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettingsService;
  const serverEnvironment = yield* ServerEnvironment;
  const httpClient = yield* HttpClient.HttpClient;
  const serviceScope = yield* Effect.scope;
  const scanSemaphore = yield* Semaphore.make(1);
  const persistLock = yield* Semaphore.make(1);

  const usageStateDir = path.join(config.stateDir, "usage");
  yield* fileSystem
    .makeDirectory(usageStateDir, { recursive: true })
    .pipe(Effect.catchCause(() => Effect.void));
  const ratesCachePath = path.join(usageStateDir, "pricing-cache.json");
  const store = yield* makeUsageScanCacheStore({
    directory: path.join(usageStateDir, "scan-cache"),
    legacyFilePath: path.join(usageStateDir, "scan-cache.json"),
    retentionMs: SCAN_CACHE_RETENTION_MS,
  });
  const scanCache = store.cache;
  const readTranscript = createUsageTranscriptReader();
  const sourceMemos = new Map<string, SourceMemo>();
  let rates: UsageRateTable = new Map();
  let ratesGeneration = 0;
  let ratesFetchedAtMs: number | null = null;
  let ratesLastAttemptAtMs: number | null = null;
  let ratesRevisionValue: string | null = null;
  let ratesState: UsagePricingStatus["state"] = "unavailable";
  let ratesRefresh: Deferred.Deferred<void> | null = null;

  // Flush pending scan-cache writes on shutdown. Registered first, so it runs
  // after the scope has interrupted any background persist below.
  yield* Effect.addFinalizer(() => persistLock.withPermits(1)(store.persist()));

  const loadScanCache = Effect.fn("UsageService.loadScanCache")(function* () {
    yield* store.ensureLoaded(yield* Clock.currentTimeMillis);
  });

  let persistScheduled = false;
  /** Write changed scan-cache shards shortly after the response, coalescing bursts. */
  const schedulePersist = Effect.suspend(() => {
    if (persistScheduled) return Effect.void;
    persistScheduled = true;
    return Effect.sleep(Duration.millis(SCAN_CACHE_PERSIST_DELAY_MS)).pipe(
      Effect.andThen(Effect.sync(() => (persistScheduled = false))),
      Effect.andThen(persistLock.withPermits(1)(store.persist())),
      Effect.onInterrupt(() => Effect.sync(() => (persistScheduled = false))),
      Effect.forkIn(serviceScope),
      Effect.asVoid,
    );
  });

  let lastSummaryAtMs = 0;
  let idleWatcherRunning = false;
  /** Release the scan cache and parser checkpoints once usage has been idle for a while. */
  const watchIdle: Effect.Effect<void> = Effect.gen(function* () {
    while (true) {
      const idleForMs = (yield* Clock.currentTimeMillis) - lastSummaryAtMs;
      if (idleForMs < SCAN_CACHE_IDLE_MS) {
        yield* Effect.sleep(Duration.millis(Math.max(1_000, SCAN_CACHE_IDLE_MS - idleForMs)));
        continue;
      }
      // A summary that was running while we waited for the lock counts as activity.
      const released = yield* scanSemaphore.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* Clock.currentTimeMillis) - lastSummaryAtMs < SCAN_CACHE_IDLE_MS) return false;
          yield* persistLock.withPermits(1)(store.unload());
          readTranscript.clear();
          return true;
        }),
      );
      if (released) return;
    }
  }).pipe(Effect.ensuring(Effect.sync(() => (idleWatcherRunning = false))));
  const noteSummaryActivity = Effect.gen(function* () {
    lastSummaryAtMs = yield* Clock.currentTimeMillis;
    if (idleWatcherRunning) return;
    idleWatcherRunning = true;
    yield* Effect.forkIn(watchIdle, serviceScope);
  });

  const loadRatesFromDisk = Effect.fn("UsageService.loadRatesFromDisk")(function* () {
    if (ratesFetchedAtMs !== null) return;
    const raw = yield* Effect.promise((signal) =>
      readBoundedUsageFile(ratesCachePath, 16 * 1024 * 1024, signal),
    ).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(null),
      ),
    );
    if (raw === null) return;
    const parsed = parseJson(raw);
    if (typeof parsed !== "object" || parsed === null) return;
    const cache = parsed as Partial<PersistedRates>;
    if (
      cache.version !== PRICING_CACHE_VERSION ||
      typeof cache.fetchedAtMs !== "number" ||
      !Number.isFinite(cache.fetchedAtMs) ||
      typeof cache.revision !== "string"
    ) {
      return;
    }
    const parsedRates = parseUsageRateTable(cache.document);
    // A download may have finished while the disk copy was being read.
    if (parsedRates.size === 0 || ratesFetchedAtMs !== null) return;
    rates = parsedRates;
    ratesGeneration += 1;
    ratesFetchedAtMs = cache.fetchedAtMs;
    ratesRevisionValue = cache.revision;
    ratesState = "cached";
  });

  const fetchRates = Effect.fn("UsageService.fetchRates")(function* () {
    const now = yield* Clock.currentTimeMillis;
    ratesLastAttemptAtMs = now;
    const text = yield* httpClient.get(LITELLM_USAGE_RATES_URL).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.timeout(RATES_FETCH_TIMEOUT_MS),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(null),
      ),
    );
    const parsedRates = text === null ? new Map() : parseUsageRateTable(parseJson(text));
    if (text === null || parsedRates.size === 0) {
      ratesState = rates.size > 0 ? "cached" : "unavailable";
      return;
    }
    const revision = ratesRevision(text);
    // An unchanged document keeps memoized summaries valid.
    if (revision !== ratesRevisionValue) {
      rates = parsedRates;
      ratesGeneration += 1;
    }
    ratesFetchedAtMs = now;
    ratesRevisionValue = revision;
    ratesState = "live";
    yield* writeFileStringAtomically({
      filePath: ratesCachePath,
      contents: `${JSON.stringify({
        version: PRICING_CACHE_VERSION,
        fetchedAtMs: now,
        revision,
        document: encodeUsageRateTable(rates),
      })}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.catchCause(() => Effect.void),
    );
  });

  /**
   * Stale-while-revalidate: start one background download when the rates are
   * stale and no attempt was made recently. Summaries never wait on it unless
   * no rates exist at all. Returns the in-flight refresh, if any.
   */
  const startRatesRefresh = Effect.gen(function* () {
    if (ratesRefresh !== null) return ratesRefresh;
    yield* loadRatesFromDisk();
    const now = yield* Clock.currentTimeMillis;
    // A timestamp in the future means the wall clock moved backwards: treat it as expired.
    const within = (sinceMs: number | null, windowMs: number) =>
      sinceMs !== null && now >= sinceMs && now - sinceMs < windowMs;
    if (ratesRefresh !== null) return ratesRefresh;
    if (within(ratesFetchedAtMs, RATES_TTL_MS) || within(ratesLastAttemptAtMs, RATES_RETRY_MS))
      return null;
    const done = Deferred.makeUnsafe<void>();
    ratesRefresh = done;
    yield* fetchRates().pipe(
      Effect.onExit(() =>
        Effect.sync(() => {
          ratesRefresh = null;
        }).pipe(Effect.andThen(Deferred.succeed(done, undefined))),
      ),
      Effect.forkIn(serviceScope),
    );
    return done;
  });

  // Users who opened usage before get fresh rates before their next visit.
  yield* Effect.sleep(Duration.millis(RATES_WARM_DELAY_MS)).pipe(
    Effect.andThen(fileSystem.exists(ratesCachePath)),
    Effect.flatMap((exists) => (exists ? startRatesRefresh : Effect.void)),
    Effect.catchCause(() => Effect.void),
    Effect.forkIn(serviceScope),
  );

  const resolveTranscriptSources = Effect.fn("UsageService.resolveTranscriptSources")(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new UsageReadError({
            reason: "scan-failed",
            detail: "Server settings could not be read while locating provider transcripts.",
            cause,
          }),
      ),
    );
    const claudeHomes = [
      yield* resolveClaudeHomePath(settings.providers.claudeAgent).pipe(
        Effect.provideService(Path.Path, path),
      ),
    ];
    const codexHomes = [
      (yield* resolveCodexHomeLayout(settings.providers.codex).pipe(
        Effect.provideService(Path.Path, path),
      )).sharedHomePath,
    ];

    const instanceClaudeRoots: string[] = [];
    const invalidSources: ResolvedTranscriptSource[] = [];
    for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
      if (instance.driver !== "codex" && instance.driver !== "claudeAgent") continue;
      // Discovery shares the runtime's path/env precedence, including disabled accounts.
      const layout = yield* resolveProviderSourceLayout(
        instance.driver === "codex" ? "codex" : "claudeAgent",
        instance,
      ).pipe(
        Effect.provideService(Path.Path, path),
        Effect.catch(() => Effect.succeed(null)),
      );
      if (layout === null) {
        invalidSources.push({
          provider: instance.driver === "codex" ? "codex" : "claude",
          identityRoot: `unsupported:${instance.driver}:${instanceId}`,
          scanRoots: [],
          unsupportedCode: "history-config-invalid",
        });
        continue;
      }
      if (instance.driver === "codex") codexHomes.push(layout.root);
      else instanceClaudeRoots.push(path.join(layout.root, "projects"));
    }

    const sources = new Map<string, ResolvedTranscriptSource>();
    for (const claudeHome of claudeHomes) {
      const nestedClaudeRoot = path.join(claudeHome, ".claude", "projects");
      const nestedClaudeExists = yield* fileSystem
        .exists(nestedClaudeRoot)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      const claudeRoot = process.env.CLAUDE_CONFIG_DIR?.trim()
        ? path.join(
            yield* resolveClaudeSourceRoot(settings.providers.claudeAgent).pipe(
              Effect.provideService(Path.Path, path),
            ),
            "projects",
          )
        : nestedClaudeExists
          ? nestedClaudeRoot
          : path.join(claudeHome, "projects");
      sources.set(`claude\0${claudeRoot}`, {
        provider: "claude",
        identityRoot: claudeRoot,
        scanRoots: [claudeRoot],
      });
    }
    for (const claudeRoot of instanceClaudeRoots)
      sources.set(`claude\0${claudeRoot}`, {
        provider: "claude",
        identityRoot: claudeRoot,
        scanRoots: [claudeRoot],
      });
    for (const codexHome of codexHomes) {
      sources.set(`codex\0${codexHome}`, {
        provider: "codex",
        identityRoot: codexHome,
        scanRoots: [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")],
      });
    }
    return [
      ...sources.values(),
      ...invalidSources,
      ...resolveNativeUsageSources(settings.providerInstances, undefined, undefined, true),
    ];
  });

  /** Resolve identities in order; a later source sharing an earlier one's identity is skipped. */
  const planSources = Effect.fn("UsageService.planSources")(function* (
    sources: readonly ResolvedTranscriptSource[],
  ) {
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const claimedSourceIds = new Set<string>();
    const planned: PlannedSource[] = [];
    for (const source of sources) {
      if (source.cursorExport !== undefined) {
        const sourceId = cursorExportSourceId(source.cursorExport);
        claimedSourceIds.add(sourceId);
        planned.push({ source, sourceId, deduplicationKind: "declared" });
        continue;
      }
      const identityRoot =
        source.provider === "opencode" &&
        source.allowLegacy === true &&
        source.databasePath !== undefined &&
        !(yield* fileSystem.exists(source.databasePath).pipe(Effect.orElseSucceed(() => false)))
          ? path.join(source.scanRoots[0]!, "storage", "message")
          : source.identityRoot;
      const identity = yield* Effect.promise(() =>
        resolveUsageSourceIdentity({
          root: identityRoot,
          provider: source.provider,
          environmentId,
        }),
      );
      if (claimedSourceIds.has(identity.sourceId)) continue;
      claimedSourceIds.add(identity.sourceId);
      planned.push({
        source,
        sourceId: identity.sourceId,
        deduplicationKind: identity.deduplicationKind,
      });
    }
    return planned;
  });

  const readFileRecords = Effect.fn("UsageService.readFileRecords")(function* (
    file: UsageTranscriptFile,
    fileKey: string,
    provider: UsageProviderKind,
    rootKey: string,
  ): Effect.fn.Return<CachedReadResult> {
    const cached = scanCache.get(fileKey);
    if (matchesUsageFileCache(cached, file, provider)) {
      return {
        aggregate: cached.aggregate,
        reused: true,
        skippedLineCount: 0,
        malformedLineCount: 0,
        failed: false,
      };
    }

    const read = yield* Effect.promise((signal) => readTranscript(file.path, provider, signal));
    if (read === null) {
      return {
        aggregate: EMPTY_USAGE_FILE_AGGREGATE,
        reused: false,
        skippedLineCount: 0,
        malformedLineCount: 0,
        failed: true,
      };
    }
    const aggregate = buildUsageFileAggregate(
      deduplicateUsageRecordsWithinFile(read.records).map(anonymizeScanCachedUsageRecord),
    );
    if (!read.limited && read.malformedLineCount === 0)
      scanCache.set(fileKey, {
        rootKey,
        size: file.size,
        mtimeMs: file.mtimeMs,
        ...(file.fingerprint === undefined ? {} : { fingerprint: file.fingerprint }),
        provider,
        aggregate,
      });
    else scanCache.delete(fileKey);
    return {
      aggregate,
      reused: false,
      skippedLineCount: read.skippedLineCount,
      malformedLineCount: read.malformedLineCount,
      failed: read.limited,
    };
  });

  const scanSource = Effect.fn("UsageService.scanSource")(function* (
    plan: PlannedSource,
    index: number,
    context: SummaryContext,
  ): Effect.fn.Return<SourceScan> {
    const { source } = plan;
    const { input, pricing } = context;
    const sourceStartedAtMs = yield* Clock.currentTimeMillis;
    const window = {
      timeZone: input.timeZone,
      ...(input.startDate === undefined ? {} : { startDate: input.startDate }),
      endDate: input.endDate,
    };
    // Cursor exports keep one bucket per export record, so they aggregate per record; every
    // other source aggregates per-file slots.
    const recordAggregator = new UsageAggregator({
      sourceId: plan.sourceId,
      retainExportIdentity: true,
      ...window,
      price: (record) => priceUsageRecord(pricing.rates, record),
    });
    const slotAggregator = new UsageSlotAggregator({
      sourceId: plan.sourceId,
      provider: source.provider,
      ...window,
      rates: pricing.rates,
    });
    const recognizedModels = new Set<string>();
    const unrecognizedModels = new Set<string>();
    const sessionIds = new Set<string>();
    const imports: UsageImportedMetric[] = [];
    const liveFileKeys: string[] = [];
    const walkedRootKeys: string[] = [];
    const tally: SourceTally = {
      transcriptFileCount: 0,
      reusedCacheFileCount: 0,
      parsedFileCount: 0,
      skippedLineCount: 0,
      malformedLineCount: 0,
      listingErrorCount: 0,
      failedFileCount: 0,
      budgetLimitedFileCount: 0,
      existingRootCount: 0,
    };
    let nativeStatus: UsageSourceCoverage["status"] | undefined;
    let nativeDiagnostic: string | undefined;
    const addRecord = (record: UsageRecord) => {
      if (recordAggregator.add(record)) {
        const recognized =
          record.reportedCostUsd !== null ||
          lookupUsageModelRate(pricing.rates, record.model) !== null;
        (recognized ? recognizedModels : unrecognizedModels).add(record.model);
        if (record.sessionId.length > 0) sessionIds.add(record.sessionId);
      }
    };

    // Transcript sources are memoized on their listing: an unchanged listing
    // under the same window and rates yields the same result.
    let memo: { readonly key: string; readonly fingerprint: string } | undefined;
    if (
      index >= SUMMARY_SOURCE_LIMIT ||
      sourceStartedAtMs - context.scanStartedAtMs >= SUMMARY_SCAN_DURATION_MS
    ) {
      nativeStatus = "failed";
      nativeDiagnostic = "usage-summary-scan-limit";
    } else if (source.cursorExport !== undefined) {
      const exportSource = source.cursorExport;
      const read = yield* Effect.promise((signal) =>
        readCursorExportUsage(exportSource, signal, input.timeZone),
      );
      nativeStatus = read.status;
      nativeDiagnostic = read.diagnosticCode;
      tally.transcriptFileCount = read.fileCount;
      tally.parsedFileCount = read.parsedFileCount;
      tally.malformedLineCount = read.malformedCount;
      tally.skippedLineCount = read.skippedCount;
      for (const record of read.records) addRecord(record);
      for (const row of read.imports) {
        if (
          (input.startDate === undefined || row.date >= input.startDate) &&
          row.date <= input.endDate
        )
          imports.push(row);
      }
    } else if (source.unsupportedCode !== undefined) {
      nativeStatus = "unsupported";
      nativeDiagnostic = source.unsupportedCode;
    } else if (source.provider === "opencode" && source.databasePath !== undefined) {
      yield* loadScanCache();
      const root = source.scanRoots[0]!;
      const read = yield* Effect.promise((signal) =>
        readOpenCodeUsage({
          root,
          databasePath: source.databasePath!,
          allowLegacy: source.allowLegacy ?? true,
          cache: scanCache,
          signal,
        }),
      );
      nativeStatus = read.status;
      nativeDiagnostic = read.diagnosticCode;
      tally.transcriptFileCount = read.fileCount;
      tally.parsedFileCount = read.parsedFileCount;
      tally.reusedCacheFileCount = read.reusedCacheFileCount;
      tally.skippedLineCount = read.skippedCount;
      tally.malformedLineCount = read.malformedCount;
      liveFileKeys.push(...read.liveFileKeys);
      // An incomplete walk cannot prove that an unseen history file was deleted.
      if (read.status === "complete") walkedRootKeys.push(usageCacheRootKey(source.provider, root));
      slotAggregator.addFile(read.aggregate);
    } else {
      const listings: Array<{
        readonly rootKey: string;
        readonly listing: UsageTranscriptListing;
      }> = [];
      for (const root of source.scanRoots) {
        const exists = yield* fileSystem
          .exists(root)
          .pipe(Effect.catchCause(() => Effect.succeed(false)));
        if (!exists) continue;
        tally.existingRootCount += 1;
        const listing = yield* Effect.promise((signal) =>
          listUsageTranscriptFiles(root, context.windowStartMs, signal),
        );
        const rootKey = usageCacheRootKey(source.provider, root);
        listings.push({ rootKey, listing });
        if (listing.errorCount === 0) walkedRootKeys.push(rootKey);
        tally.transcriptFileCount += listing.files.length;
        tally.skippedLineCount += listing.skippedEntryCount;
        tally.listingErrorCount += listing.errorCount;
      }
      const files = listings.flatMap(({ rootKey, listing }) =>
        listing.files.map((file) => ({
          file,
          rootKey,
          fileKey: usageCacheFileKey(source.provider, file.path),
        })),
      );
      for (const { fileKey } of files) liveFileKeys.push(fileKey);

      const memoKey = `${plan.sourceId}\0${summaryRequestKey(input)}`;
      const fingerprint = `${pricing.generation}\0${listingFingerprint(tally.existingRootCount, listings)}`;
      const hit = sourceMemos.get(memoKey);
      if (hit !== undefined && hit.fingerprint === fingerprint) {
        sourceMemos.delete(memoKey);
        sourceMemos.set(memoKey, hit);
        const finishedAtMs = yield* Clock.currentTimeMillis;
        return {
          ...hit.scan,
          coverage: {
            ...hit.scan.coverage,
            // Nothing was read: every file's result came from the memo.
            reusedCacheFileCount: hit.scan.coverage.transcriptFileCount,
            parsedFileCount: 0,
            scanStartedAt: iso(sourceStartedAtMs),
            scanFinishedAt: iso(finishedAtMs),
            scanDurationMs: Math.max(0, Math.trunc(finishedAtMs - sourceStartedAtMs)),
          },
          liveFileKeys,
          walkedRootKeys,
        };
      }
      memo = { key: memoKey, fingerprint };

      if (files.length > 0) yield* loadScanCache();
      let parsedBytes = 0;
      let parsedRecords = 0;
      let cachedRecords = 0;
      for (const { file, rootKey, fileKey } of files) {
        const cached = scanCache.get(fileKey);
        if (matchesUsageFileCache(cached, file, source.provider)) {
          if (cachedRecords + cached.aggregate.recordCount > SOURCE_CACHED_RECORDS) {
            tally.budgetLimitedFileCount++;
            continue;
          }
          cachedRecords += cached.aggregate.recordCount;
        } else {
          // Only fresh parses spend the scan budget. Later files may already be
          // cached or small enough to fit.
          const now = yield* Clock.currentTimeMillis;
          if (
            parsedBytes + file.size > SOURCE_SCAN_BYTES ||
            parsedRecords >= SOURCE_SCAN_RECORDS ||
            now - sourceStartedAtMs >= SOURCE_SCAN_DURATION_MS
          ) {
            tally.budgetLimitedFileCount++;
            continue;
          }
          parsedBytes += file.size;
        }
        const read = yield* readFileRecords(file, fileKey, source.provider, rootKey);
        if (read.reused) tally.reusedCacheFileCount += 1;
        else {
          parsedRecords += read.aggregate.recordCount;
          if (!read.failed) tally.parsedFileCount += 1;
        }
        if (read.failed) tally.failedFileCount += 1;
        tally.skippedLineCount += read.skippedLineCount;
        tally.malformedLineCount += read.malformedLineCount;
        slotAggregator.addFile(read.aggregate);
      }
    }

    const slotResult = slotAggregator.finish();
    for (const model of slotResult.recognizedModels) recognizedModels.add(model);
    for (const model of slotResult.unrecognizedModels) unrecognizedModels.add(model);
    for (const sessionId of slotResult.sessionIds) sessionIds.add(sessionId);
    const recordResult = recordAggregator.finish();
    const aggregated = {
      // One kind of source feeds one of the aggregators; the other stays empty.
      buckets: recordResult.buckets.length > 0 ? recordResult.buckets : slotResult.buckets,
      acceptedRecords: recordResult.acceptedRecords + slotResult.acceptedRecords,
    };
    const sourceFinishedAtMs = yield* Clock.currentTimeMillis;
    const incomplete = tally.failedFileCount + tally.budgetLimitedFileCount;
    const status: UsageSourceCoverage["status"] =
      nativeStatus ??
      (tally.existingRootCount === 0
        ? "not-found"
        : incomplete > 0 || tally.listingErrorCount > 0 || tally.malformedLineCount > 0
          ? aggregated.acceptedRecords > 0 || tally.reusedCacheFileCount > 0
            ? "partial"
            : "failed"
          : "complete");
    const diagnosticCode =
      nativeDiagnostic ??
      (status === "not-found"
        ? "transcript-directory-not-found"
        : tally.listingErrorCount > 0
          ? "transcript-list-partial"
          : tally.failedFileCount > 0
            ? "transcript-read-partial"
            : tally.budgetLimitedFileCount > 0
              ? "transcript-scan-budget"
              : tally.malformedLineCount > 0
                ? "transcript-record-invalid"
                : undefined);
    const message = coverageMessage(source, status, diagnosticCode);
    const scan: SourceScan = {
      coverage: {
        sourceId: plan.sourceId,
        provider: source.provider,
        deduplicationKind: plan.deduplicationKind,
        status,
        transcriptFileCount: tally.transcriptFileCount,
        reusedCacheFileCount: tally.reusedCacheFileCount,
        parsedFileCount: tally.parsedFileCount,
        skippedLineCount: tally.skippedLineCount,
        malformedLineCount: tally.malformedLineCount,
        distinctSessionCount: sessionIds.size,
        distinctResponseCount: aggregated.acceptedRecords,
        scanStartedAt: iso(sourceStartedAtMs),
        scanFinishedAt: iso(sourceFinishedAtMs),
        scanDurationMs: Math.max(0, Math.trunc(sourceFinishedAtMs - sourceStartedAtMs)),
        ...(diagnosticCode ? { diagnosticCode } : {}),
        ...(message === undefined ? {} : { message }),
      },
      buckets: aggregated.buckets,
      imports,
      recognizedModels: [...recognizedModels],
      unrecognizedModels: [...unrecognizedModels],
      liveFileKeys,
      walkedRootKeys,
    };
    // Only a complete result is reused; anything partial is retried next time.
    if (memo !== undefined && status === "complete") {
      sourceMemos.delete(memo.key);
      sourceMemos.set(memo.key, {
        fingerprint: memo.fingerprint,
        scan: { ...scan, liveFileKeys: [], walkedRootKeys: [] },
      });
      while (sourceMemos.size > SOURCE_MEMO_LIMIT) {
        const oldest = sourceMemos.keys().next().value;
        if (oldest === undefined) break;
        sourceMemos.delete(oldest);
      }
    }
    return scan;
  });

  const readSummaryUnlocked = Effect.fn("UsageService.readSummaryUnlocked")(function* (
    input: UsageSummaryRequest,
  ) {
    if (input.contractVersion !== USAGE_CONTRACT_VERSION)
      return yield* new UsageReadError({
        reason: "scan-failed",
        detail:
          "Update Ryco on this device and the connected node to use the current usage format.",
      });
    if (
      !isValidCalendarDate(input.endDate) ||
      (input.startDate !== undefined && !isValidCalendarDate(input.startDate))
    ) {
      return yield* new UsageReadError({
        reason: "invalid-window",
        detail: "The requested usage window contains an invalid calendar date.",
      });
    }
    if (input.startDate !== undefined && input.startDate > input.endDate) {
      return yield* new UsageReadError({
        reason: "invalid-window",
        detail: `startDate '${input.startDate}' is after endDate '${input.endDate}'.`,
      });
    }
    try {
      Intl.DateTimeFormat("en-CA", { timeZone: input.timeZone });
    } catch {
      return yield* new UsageReadError({
        reason: "invalid-time-zone",
        detail: `Time zone '${input.timeZone}' is not a recognized IANA time zone.`,
      });
    }

    const scanStartedAtMs = yield* Clock.currentTimeMillis;
    // Pricing is only needed by the aggregators: any download overlaps source discovery.
    const refresh = yield* startRatesRefresh;
    const plans = yield* planSources(yield* resolveTranscriptSources());
    if (refresh !== null && rates.size === 0) {
      const waitedMs = (yield* Clock.currentTimeMillis) - scanStartedAtMs;
      yield* Deferred.await(refresh).pipe(
        Effect.timeoutOption(Duration.millis(Math.max(0, RATES_FIRST_FETCH_WAIT_MS - waitedMs))),
      );
    }
    const context: SummaryContext = {
      input,
      scanStartedAtMs,
      windowStartMs:
        input.startDate === undefined
          ? 0
          : Math.max(0, startOfCalendarDateMs(input.startDate) - MTIME_WINDOW_SLACK_MS),
      pricing: {
        rates,
        generation: ratesGeneration,
        state: ratesState,
        revision: ratesRevisionValue,
        fetchedAtMs: ratesFetchedAtMs,
      },
    };
    const scans = yield* Effect.forEach(plans, (plan, index) => scanSource(plan, index, context), {
      concurrency: SUMMARY_SOURCE_CONCURRENCY,
    });

    const coverage: UsageSourceCoverage[] = [];
    const buckets: UsageDailyBucket[] = [];
    const importedMetrics = new Map<string, UsageImportedMetric>();
    const cursorBuckets = new Map<string, UsageDailyBucket>();
    const liveFileKeys = new Set<string>();
    const walkedRootKeys = new Set<string>();
    const recognizedModels = new Set<string>();
    const unrecognizedModels = new Set<string>();
    for (const [index, scan] of scans.entries()) {
      coverage.push(scan.coverage);
      if (plans[index]!.source.cursorExport === undefined) buckets.push(...scan.buckets);
      else
        for (const bucket of scan.buckets)
          if (bucket.exportRecordId !== undefined) cursorBuckets.set(bucket.exportRecordId, bucket);
      for (const row of scan.imports) importedMetrics.set(row.recordId, row);
      for (const key of scan.liveFileKeys) liveFileKeys.add(key);
      for (const key of scan.walkedRootKeys) walkedRootKeys.add(key);
      for (const model of scan.recognizedModels) recognizedModels.add(model);
      for (const model of scan.unrecognizedModels) unrecognizedModels.add(model);
    }

    // Several instances may explicitly import the same account. Keep one coverage
    // row while retaining every independently read export's diagnostics.
    const cursorCoverage = new Map<string, UsageSourceCoverage>();
    const otherCoverage = coverage.filter(
      (source) => source.provider !== "cursor" || source.deduplicationKind !== "declared",
    );
    for (const source of coverage.filter(
      (source) => source.provider === "cursor" && source.deduplicationKind === "declared",
    )) {
      const previous = cursorCoverage.get(source.sourceId);
      if (previous === undefined) cursorCoverage.set(source.sourceId, source);
      else {
        const diagnosticCode = [
          ...new Set(
            [previous.diagnosticCode, source.diagnosticCode].flatMap(
              (code) => code?.split(",") ?? [],
            ),
          ),
        ]
          .toSorted()
          .join(",");
        cursorCoverage.set(source.sourceId, {
          ...source,
          status:
            previous.status === "partial" || source.status === "partial"
              ? "partial"
              : source.status,
          transcriptFileCount: previous.transcriptFileCount + source.transcriptFileCount,
          parsedFileCount: previous.parsedFileCount + source.parsedFileCount,
          skippedLineCount: previous.skippedLineCount + source.skippedLineCount,
          malformedLineCount: previous.malformedLineCount + source.malformedLineCount,
          scanStartedAt: previous.scanStartedAt,
          scanDurationMs: previous.scanDurationMs + source.scanDurationMs,
          ...(diagnosticCode
            ? {
                diagnosticCode,
                message: `Saved Cursor exports have partial coverage. Billed costs and model costs are separate. Diagnostics: ${diagnosticCode}.`,
              }
            : {}),
        });
      }
    }
    coverage.splice(
      0,
      coverage.length,
      ...otherCoverage,
      ...[...cursorCoverage.values()].map((source) => {
        const events = [...cursorBuckets.values()].filter(
          (bucket) => bucket.sourceId === source.sourceId,
        );
        return Object.assign({}, source, {
          distinctResponseCount: events.length,
          distinctSessionCount: new Set(
            events.flatMap((bucket) =>
              bucket.exportSessionId === undefined ? [] : [bucket.exportSessionId],
            ),
          ).size,
        });
      }),
    );

    // Memoized sources never load the cache; there is nothing to prune then.
    if (store.isLoaded()) {
      pruneUsageScanCache(scanCache, {
        liveFileKeys,
        walkedRootKeys,
        windowStartMs: context.windowStartMs,
        retentionCutoffMs:
          input.startDate === undefined ? 0 : scanStartedAtMs - SCAN_CACHE_RETENTION_MS,
      });
      capUsageScanCache(scanCache, USAGE_SCAN_CACHE_RECORD_LIMIT);
      yield* schedulePersist;
    }

    buckets.push(...cursorBuckets.values());
    buckets.sort(
      (left, right) =>
        left.date.localeCompare(right.date) ||
        left.provider.localeCompare(right.provider) ||
        left.model.localeCompare(right.model) ||
        left.sourceId.localeCompare(right.sourceId),
    );
    const finishedAtMs = yield* Clock.currentTimeMillis;
    const { pricing: snapshot } = context;
    const pricing: UsagePricingStatus = {
      state: snapshot.state,
      recognizedModelCount: recognizedModels.size,
      unrecognizedModelCount: unrecognizedModels.size,
      ...(snapshot.revision === null ? {} : { sourceRevision: snapshot.revision }),
      ...(snapshot.fetchedAtMs === null
        ? {}
        : {
            fetchedAt: iso(snapshot.fetchedAtMs),
            cacheAgeMs: Math.max(0, Math.trunc(finishedAtMs - snapshot.fetchedAtMs)),
          }),
    };
    return {
      contractVersion: USAGE_CONTRACT_VERSION,
      ...(input.startDate === undefined ? {} : { startDate: input.startDate }),
      endDate: input.endDate,
      timeZone: input.timeZone,
      generatedAt: iso(finishedAtMs),
      scanDurationMs: Math.max(0, Math.trunc(finishedAtMs - scanStartedAtMs)),
      buckets,
      imports: [...importedMetrics.values()],
      sources: coverage,
      pricing,
    } satisfies UsageSummary;
  });

  const computeSummary = (input: UsageSummaryRequest) =>
    scanSemaphore
      .withPermits(1)(
        // Mark activity under the lock too, so a waiting idle release sees it.
        Clock.currentTimeMillis.pipe(
          Effect.tap((nowMs) => Effect.sync(() => (lastSummaryAtMs = nowMs))),
          Effect.andThen(readSummaryUnlocked(input)),
        ),
      )
      .pipe(
        Effect.ensuring(noteSummaryActivity),
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.interrupt;
          const failure = Cause.findErrorOption(cause);
          if (failure._tag === "Some" && Schema.is(UsageReadError)(failure.value)) {
            return Effect.fail(failure.value);
          }
          return Effect.fail(
            new UsageReadError({
              reason: "scan-failed",
              detail: "Usage transcripts could not be scanned.",
              cause: Cause.squash(cause),
            }),
          );
        }),
      );

  // Identical requests (several tabs or clients) share one scan. It runs in the
  // service scope and is interrupted only once every caller has gone away (a
  // closed socket, an abandoned request), so a queued scan nobody waits for
  // never runs.
  interface Flight {
    readonly done: Deferred.Deferred<UsageSummary, UsageReadError>;
    fiber: Fiber.Fiber<unknown, unknown> | undefined;
    waiters: number;
  }
  const inflight = new Map<string, Flight>();
  const readSummary = (input: UsageSummaryRequest) =>
    Effect.gen(function* () {
      const key = summaryRequestKey(input);
      let flight = inflight.get(key);
      if (flight === undefined) {
        const started: Flight = {
          done: Deferred.makeUnsafe<UsageSummary, UsageReadError>(),
          fiber: undefined,
          waiters: 0,
        };
        flight = started;
        inflight.set(key, started);
        started.fiber = yield* computeSummary(input).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (inflight.get(key) === started) inflight.delete(key);
            }).pipe(Effect.andThen(Deferred.done(started.done, exit))),
          ),
          Effect.forkIn(serviceScope),
        );
      }
      const joined = flight;
      joined.waiters += 1;
      return yield* Deferred.await(joined.done).pipe(
        Effect.onExit((exit) =>
          Effect.suspend(() => {
            joined.waiters -= 1;
            if (!Exit.hasInterrupts(exit) || joined.waiters > 0 || joined.fiber === undefined)
              return Effect.void;
            if (inflight.get(key) === joined) inflight.delete(key);
            return Effect.forkIn(Fiber.interrupt(joined.fiber), serviceScope).pipe(Effect.asVoid);
          }),
        ),
      );
    });

  return { readSummary } satisfies UsageServiceShape;
});

export const UsageServiceLive = Layer.effect(UsageService, makeUsageService);
