import * as FS from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ServerSettings,
  type StatisticsDailyBucket,
  type StatisticsSnapshot,
} from "@ryco/contracts";
import { Effect, Layer, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  aggregateMachineStatistics,
  attributeMachineSlot,
  machineFolderTitle,
  makeMachineProjectResolver,
  type MachineStatisticsFile,
} from "./machineStatistics.ts";
import { parseClaudeTranscriptLine } from "./claudeTranscript.ts";
import { initialCodexTranscriptState, parseCodexTranscriptLine } from "./codexTranscript.ts";
import { buildUsageFileAggregate } from "./usageFileAggregate.ts";
import {
  anonymizeScanCachedSessionId,
  anonymizeScanCachedUsageRecord,
  deduplicateUsageRecordsWithinFile,
} from "./usageScanCache.ts";
import * as TranscriptReader from "./usageTranscriptReader.ts";
import { UsageService, UsageServiceLive } from "./UsageService.ts";
import type { MachineStatisticsRequest } from "./UsageServiceTag.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/machine", import.meta.url));
const PROJECT_ROOTS = [{ path: "/work/app", projectId: "p1" }];
const RYCO_SESSIONS = { claude: ["ryco-claude-1"], codex: ["codex-ryco-1"] };

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  // Directories a test made unreadable come first, so the trees holding them can be removed.
  for (const root of roots.splice(0)) {
    await FS.chmod(root, 0o700).catch(() => undefined);
    await FS.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

/**
 * Reads a fixture tree the way the usage pipeline does. The pipeline orders files oldest first,
 * so an original session precedes the one that resumed it: outside-1 before outside-2.
 */
async function readFixtureFiles(root: string): Promise<MachineStatisticsFile[]> {
  const files: Array<MachineStatisticsFile & { readonly path: string }> = [];
  for (const [provider, directory] of [
    ["claude", join(root, "claude", "projects")],
    ["codex", join(root, "codex", "sessions")],
  ] as const) {
    const listing = await TranscriptReader.listUsageTranscriptFiles(directory, 0);
    for (const file of listing.files) {
      const read = await TranscriptReader.readUsageTranscript(file.path, provider);
      if (read === null) throw new Error(`unreadable fixture ${file.path}`);
      files.push({
        path: file.path,
        provider,
        aggregate: buildUsageFileAggregate(
          deduplicateUsageRecordsWithinFile(read.records).map(anonymizeScanCachedUsageRecord),
        ),
      });
    }
  }
  return files.toSorted(
    (left, right) =>
      Number(!left.path.includes("outside-1")) - Number(!right.path.includes("outside-1")),
  );
}

const rycoIndex = (sessions: {
  readonly claude: readonly string[];
  readonly codex: readonly string[];
}) => ({
  claude: new Set(sessions.claude.map((id) => anonymizeScanCachedSessionId("claude", id))),
  codex: new Set(sessions.codex.map((id) => anonymizeScanCachedSessionId("codex", id))),
});

function find(
  buckets: readonly StatisticsDailyBucket[],
  match: Partial<StatisticsDailyBucket>,
): StatisticsDailyBucket[] {
  return buckets.filter((bucket) =>
    Object.entries(match).every(
      ([key, value]) => bucket[key as keyof StatisticsDailyBucket] === value,
    ),
  );
}

function sum(buckets: readonly StatisticsDailyBucket[], field: keyof StatisticsDailyBucket) {
  return buckets.reduce((total, bucket) => total + ((bucket[field] as number | undefined) ?? 0), 0);
}

describe("transcript parsing", () => {
  it("reads the session directory and subagent flag of Claude lines, never their content", () => {
    const record = parseClaudeTranscriptLine(
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-10-01T10:00:00.000Z",
        sessionId: "session-a",
        cwd: "/work/app",
        isSidechain: true,
        message: {
          id: "m1",
          model: "claude-opus-5-5",
          content: [{ type: "text", text: "secret prompt text" }],
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      }),
    );
    expect(record).toMatchObject({ cwd: "/work/app", sidechain: true, sessionId: "session-a" });
    expect(JSON.stringify(record)).not.toContain("secret");
  });

  it("carries a Codex session's directory, client and spawning parent onto its usage", () => {
    const state = initialCodexTranscriptState();
    // A spawned thread's first second repeats its parent's context (fork copies): skip past it.
    const line = (type: string, payload: object, timestamp = "2026-10-01T10:00:00.000Z") =>
      JSON.stringify({ timestamp, type, payload });
    parseCodexTranscriptLine(
      line("session_meta", {
        id: "child",
        cwd: "/work/app",
        originator: "ryco_desktop",
        source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } },
      }),
      state,
    );
    parseCodexTranscriptLine(
      line("turn_context", { model: "gpt-5.5", cwd: "/work/app/pkg" }),
      state,
    );
    const record = parseCodexTranscriptLine(
      line(
        "event_msg",
        {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 },
          },
        },
        "2026-10-01T10:00:05.000Z",
      ),
      state,
    );
    expect(record).toMatchObject({
      sessionId: "child",
      ownerSessionId: "parent",
      sidechain: true,
      rycoClient: true,
      cwd: "/work/app/pkg",
    });
  });
});

describe("attribution", () => {
  const ryco = rycoIndex(RYCO_SESSIONS);
  const slot = (overrides: Partial<Parameters<typeof attributeMachineSlot>[1]> = {}) => ({
    sessionId: "",
    ownerSessionId: "",
    sidechain: false,
    rycoClient: false,
    ...overrides,
  });
  const claudeRyco = anonymizeScanCachedSessionId("claude", "ryco-claude-1");
  const codexRyco = anonymizeScanCachedSessionId("codex", "codex-ryco-1");

  it("leaves a Ryco session's main work to Ryco's records and counts its subagents for Ryco", () => {
    expect(attributeMachineSlot("claude", slot({ sessionId: claudeRyco }), ryco)).toBe("ryco");
    expect(
      attributeMachineSlot("claude", slot({ sessionId: claudeRyco, sidechain: true }), ryco),
    ).toBe("ryco-subagent");
    expect(
      attributeMachineSlot(
        "codex",
        slot({ sessionId: "child", ownerSessionId: codexRyco, sidechain: true }),
        ryco,
      ),
    ).toBe("ryco-subagent");
    // A session Ryco's client started whose thread is gone: its usage is in Ryco's rollups.
    expect(attributeMachineSlot("codex", slot({ sessionId: "gone", rycoClient: true }), ryco)).toBe(
      "ryco",
    );
  });

  it("counts everything else as outside, including another session's subagents", () => {
    expect(attributeMachineSlot("claude", slot({ sessionId: "other" }), ryco)).toBe("outside");
    expect(
      attributeMachineSlot("claude", slot({ sessionId: "other", sidechain: true }), ryco),
    ).toBe("outside");
    // Ids are per provider: a Codex id never marks a Claude session.
    expect(attributeMachineSlot("claude", slot({ sessionId: codexRyco }), ryco)).toBe("outside");
  });

  it("places directories in the project holding them, else in their folder", () => {
    const resolve = makeMachineProjectResolver(
      [
        { path: "/work/app/", projectId: "p1" },
        { path: "/work/app/nested", projectId: "p2", deleted: true },
        { path: "/home/me", projectId: "chats" },
        { path: "/home/me/.ryco/worktrees/x_app/feature", projectId: "p1" },
      ],
      "/home/me",
    );
    expect(resolve("/work/app")).toEqual({ projectId: "p1" });
    expect(resolve("/work/app/src")).toEqual({ projectId: "p1" });
    expect(resolve("/work/app/nested/deep")).toEqual({ projectId: "p2" });
    expect(resolve("/work/application")).toEqual({
      projectId: "folder:application",
      folderTitle: "application",
    });
    expect(resolve("/home/me/.ryco/worktrees/x_app/feature/apps")).toEqual({ projectId: "p1" });
    // A project at the home directory claims only sessions run right there.
    expect(resolve("/home/me")).toEqual({ projectId: "chats" });
    expect(resolve("/home/me/code/tool")).toEqual({
      projectId: "folder:tool",
      folderTitle: "tool",
    });
    expect(resolve("")).toEqual({
      projectId: "folder:Unknown folder",
      folderTitle: "Unknown folder",
    });
    expect(machineFolderTitle("/repo/tool/.claude/worktrees/feature-x")).toBe("tool");
  });
});

describe("aggregation over fixture transcripts", () => {
  it("counts each response once and Ryco's sessions once, attributed to Ryco", async () => {
    const files = await readFixtureFiles(FIXTURES);
    const result = aggregateMachineStatistics({
      files,
      ryco: rycoIndex(RYCO_SESSIONS),
      resolveProject: makeMachineProjectResolver(PROJECT_ROOTS, "/home/nobody"),
    });
    const outside = find(result.buckets, { source: "outside" });
    const subagents = find(result.buckets, { source: "ryco-subagent" });

    // outside-1 (inside the project): o1 + o2; its malformed line is skipped.
    expect(find(outside, { projectId: ProjectId.make("p1"), model: "claude-opus-5-5" })).toEqual([
      expect.objectContaining({
        date: "2026-10-01",
        provider: "claudeAgent",
        inputTokens: 66,
        cachedInputTokens: 50,
        cacheWriteInputTokens: 10,
        outputTokens: 24,
        totalTokens: 90,
      }),
    ]);
    // outside-2 resumed outside-1 and forked a Ryco session: only its own o3 is new.
    expect(
      find(outside, { projectId: ProjectId.make("folder:tool"), model: "claude-opus-5-5" }),
    ).toEqual([
      expect.objectContaining({
        date: "2026-10-02",
        inputTokens: 15,
        outputTokens: 5,
        totalTokens: 20,
      }),
    ]);
    // A Claude Code worktree counts as its repository's folder; an unknown model stays a bucket.
    expect(find(outside, { model: "mystery-model-x" })).toEqual([
      expect.objectContaining({ projectId: "folder:tool", inputTokens: 7, outputTokens: 3 }),
    ]);
    // Codex outside: codex-out-1 (two responses) and codex-out-2 (its truncated tail skipped).
    expect(find(outside, { provider: "codex" })).toEqual([
      expect.objectContaining({
        projectId: "folder:other",
        model: "gpt-5.5",
        inputTokens: 1400,
        cachedInputTokens: 900,
        outputTokens: 80,
        reasoningTokens: 5,
        totalTokens: 1480,
      }),
    ]);
    // Ryco's subagents: the Claude sidechain and the thread Ryco's Codex thread spawned.
    expect(find(subagents, { provider: "claudeAgent" })).toEqual([
      expect.objectContaining({
        projectId: "p1",
        inputTokens: 33,
        outputTokens: 4,
        totalTokens: 37,
      }),
    ]);
    expect(find(subagents, { provider: "codex" })).toEqual([
      expect.objectContaining({
        projectId: "p1",
        inputTokens: 300,
        outputTokens: 20,
        totalTokens: 320,
      }),
    ]);
    // Ryco's own main sessions (m1, m2, codex-ryco-1) and the deleted Ryco Codex thread.
    expect(sum(result.buckets, "totalTokens")).toBe(90 + 20 + 10 + 1480 + 37 + 320);
    expect(result.rycoResponseCount).toBe(4);
    // o1 copied into outside-2, and m1 copied from the Ryco session.
    expect(result.duplicateResponseCount).toBe(2);
    expect(result.outsideSessionCount).toBe(5);
    expect(result.folders.map((folder) => folder.title)).toEqual(["other", "tool"]);
    expect(result.folders.every((folder) => folder.kind === "folder")).toBe(true);
  });

  it("does not depend on file order: Ryco's responses claim their keys first", async () => {
    const files = await readFixtureFiles(FIXTURES);
    const run = (ordered: readonly MachineStatisticsFile[]) =>
      aggregateMachineStatistics({
        files: ordered,
        ryco: rycoIndex(RYCO_SESSIONS),
        resolveProject: () => ({ projectId: "any" }),
      });
    const forward = run(files);
    const reversed = run(files.toReversed());
    for (const source of ["outside", "ryco-subagent"] as const)
      expect(sum(find(reversed.buckets, { source }), "totalTokens")).toBe(
        sum(find(forward.buckets, { source }), "totalTokens"),
      );
    expect(reversed.rycoResponseCount).toBe(forward.rycoResponseCount);
    expect(reversed.duplicateResponseCount).toBe(forward.duplicateResponseCount);
  });

  it("counts a session as outside when Ryco does not know it", async () => {
    const files = await readFixtureFiles(FIXTURES);
    const result = aggregateMachineStatistics({
      files,
      ryco: rycoIndex({ claude: [], codex: [] }),
      resolveProject: () => ({ projectId: "any" }),
    });
    // The Claude session now counts outside (m1 once, m2, s1); Codex sessions Ryco's client
    // started still belong to Ryco.
    expect(
      sum(find(result.buckets, { source: "outside", provider: "claudeAgent" }), "totalTokens"),
    ).toBe(90 + 20 + 10 + 135 + 208 + 37);
    expect(result.rycoResponseCount).toBe(2);
  });
});

// The service: the background read, the per-file cache, the merge and pricing.

function testLayer(root: string, settings: () => ServerSettings, rates: unknown) {
  return UsageServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        ServerConfig.layerTest(root, join(root, "state")).pipe(Layer.provide(NodeServices.layer)),
        Layer.succeed(ServerSettingsService, {
          withSettingsSnapshot: (effect) => effect,
          start: Effect.void,
          ready: Effect.void,
          getSettings: Effect.sync(settings),
          updateSettings: () => Effect.sync(settings),
          streamChanges: Stream.empty,
        }),
        Layer.succeed(ServerEnvironment, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("fixture")),
          getDescriptor: Effect.die("unused"),
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(rates))),
          ),
        ),
      ),
    ),
  );
}

const RATES = {
  "claude-opus-5-5": {
    input_cost_per_token: 0.000005,
    output_cost_per_token: 0.000025,
    cache_read_input_token_cost: 0.0000005,
    cache_creation_input_token_cost: 0.00000625,
  },
  "gpt-5.5": {
    input_cost_per_token: 0.000002,
    output_cost_per_token: 0.000016,
    cache_read_input_token_cost: 0.0000002,
  },
};

const EMPTY_SNAPSHOT: StatisticsSnapshot = {
  generatedAt: "2026-10-03T00:00:00.000Z",
  projects: [{ id: ProjectId.make("p1"), title: "App" }],
  models: [],
  dailyBuckets: [],
  worktrees: { created: 0, archived: 0, active: 0, openPrs: 0 },
  totals: {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    turns: 0,
    activeMs: 0,
    toolUses: 0,
    filesChanged: 0,
    additions: 0,
    deletions: 0,
    commits: 0,
    pushes: 0,
    threads: 0,
    projects: 1,
  },
  recentPullRequests: [],
};

async function copyFixtures(): Promise<string> {
  const root = await FS.mkdtemp(join(tmpdir(), "ryco-machine-statistics-"));
  roots.push(root);
  await FS.cp(FIXTURES, root, { recursive: true });
  // Files are taken oldest first: the original session (outside-1) is older than the session
  // that resumed it, whatever order the copy wrote them in.
  const resumedAt = new Date("2026-10-03T00:00:00.000Z");
  for (const entry of await FS.readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const at = entry.name === "outside-1.jsonl" ? new Date("2026-10-02T00:00:00.000Z") : resumedAt;
    await FS.utimes(join(entry.parentPath, entry.name), at, at);
  }
  return root;
}

function fixtureSettings(root: string, overrides: Partial<ServerSettings> = {}): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {},
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      claudeAgent: {
        ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
        homePath: join(root, "claude"),
      },
      codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, homePath: join(root, "codex") },
    },
    ...overrides,
  };
}

const REQUEST: MachineStatisticsRequest = {
  rycoSessionIds: RYCO_SESSIONS,
  projectRoots: PROJECT_ROOTS,
  maxWaitMs: 30_000,
};

const outsideTotal = (snapshot: StatisticsSnapshot) =>
  sum(find(snapshot.dailyBuckets, { source: "outside" }), "totalTokens");

const claudeLine = (id: string, input: number, output: number, timestamp: string) =>
  `${JSON.stringify({
    type: "assistant",
    timestamp,
    sessionId: "outside-2",
    cwd: "/elsewhere/tool",
    requestId: `req-${id}`,
    message: {
      id,
      model: "claude-opus-5-5",
      usage: { input_tokens: input, output_tokens: output },
    },
  })}\n`;

describe("UsageService.machineStatistics", () => {
  it("reads the session files once, then reuses, resumes and re-reads them as they change", async () => {
    const root = await copyFixtures();
    const settings = fixtureSettings(root);
    const resumes = vi.spyOn(TranscriptReader, "resumeUsageTranscript");
    const resumed = join(root, "claude/projects/-elsewhere-tool/outside-2-resumed.jsonl");
    // MACHINE_READ_REUSE_MS keeps a read for 15 s: step past it between rounds.
    let nowMs = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const later = () => (nowMs += 20_000);

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* UsageService;
        const cold = yield* service.machineStatistics(EMPTY_SNAPSHOT, REQUEST);
        expect(cold.scope).toBe("machine");
        expect(cold.machine).toMatchObject({
          state: "ready",
          fileCount: 10,
          parsedFileCount: 10,
          reusedFileCount: 0,
          malformedLineCount: 1,
          duplicateResponseCount: 2,
          rycoResponseCount: 4,
          outsideSessionCount: 5,
        });
        expect(outsideTotal(cold)).toBe(90 + 20 + 10 + 1480);
        expect(cold.projects.map((project) => project.id)).toEqual([
          "p1",
          "folder:other",
          "folder:tool",
        ]);
        expect(cold.models).toEqual(
          expect.arrayContaining([
            { model: "claude-opus-5-5", provider: "claudeAgent" },
            { model: "gpt-5.5", provider: "codex" },
          ]),
        );

        // Unchanged: only the file with a malformed line is read again.
        later();
        const warm = yield* service.machineStatistics(EMPTY_SNAPSHOT, REQUEST);
        expect(warm.machine).toMatchObject({ parsedFileCount: 1, reusedFileCount: 9 });
        expect(outsideTotal(warm)).toBe(outsideTotal(cold));

        // Appended: read from where it stopped.
        yield* Effect.promise(() =>
          FS.appendFile(resumed, claudeLine("o4", 100, 50, "2026-10-02T23:55:00.000Z")),
        );
        later();
        const appended = yield* service.machineStatistics(EMPTY_SNAPSHOT, REQUEST);
        expect(resumes).toHaveBeenCalledTimes(1);
        expect(appended.machine).toMatchObject({ parsedFileCount: 2, reusedFileCount: 8 });
        expect(outsideTotal(appended)).toBe(outsideTotal(cold) + 150);

        // Rewritten (same length, different bytes before the old end): read from the start.
        const rewritten = (yield* Effect.promise(() => FS.readFile(resumed, "utf8"))).replace(
          '"output_tokens":50',
          '"output_tokens":60',
        );
        yield* Effect.promise(() => FS.writeFile(resumed, rewritten));
        later();
        const reread = yield* service.machineStatistics(EMPTY_SNAPSHOT, REQUEST);
        expect(outsideTotal(reread)).toBe(outsideTotal(cold) + 160);

        // Deleted: its usage is gone.
        yield* Effect.promise(() => FS.rm(resumed));
        later();
        const deleted = yield* service.machineStatistics(EMPTY_SNAPSHOT, REQUEST);
        expect(deleted.machine?.fileCount).toBe(9);
        // outside-1's o1 is no longer a duplicate; o3, o4 and the m1 copy left with the file.
        expect(outsideTotal(deleted)).toBe(90 + 10 + 1480);
        expect(deleted.machine?.duplicateResponseCount).toBe(0);
      }).pipe(Effect.provide(testLayer(root, () => settings, RATES)), Effect.scoped),
    );

    // A new process resumes a grown file from the persisted offset.
    {
      resumes.mockClear();
      const second = join(root, "claude/projects/-work-app-sub/outside-3b.jsonl");
      await FS.writeFile(second, claudeLine("p1", 1, 1, "2026-10-03T08:00:00.000Z"));
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* (yield* UsageService).machineStatistics(EMPTY_SNAPSHOT, REQUEST);
        }).pipe(Effect.provide(testLayer(root, () => settings, RATES)), Effect.scoped),
      );
      await FS.appendFile(second, claudeLine("p2", 2, 2, "2026-10-03T08:01:00.000Z"));
      later();
      await Effect.runPromise(
        Effect.gen(function* () {
          const next = yield* (yield* UsageService).machineStatistics(EMPTY_SNAPSHOT, REQUEST);
          expect(resumes).toHaveBeenCalledTimes(1);
          expect(next.machine).toMatchObject({ parsedFileCount: 2 });
          expect(outsideTotal(next)).toBe(90 + 10 + 1480 + 2 + 4);
        }).pipe(Effect.provide(testLayer(root, () => settings, RATES)), Effect.scoped),
      );
    }
  }, 30_000);

  it("prices session-file usage with Statistics' rules and leaves unknown models unpriced", async () => {
    const root = await copyFixtures();
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* UsageService;
        const priced = yield* service.priceStatistics(
          yield* service.machineStatistics(EMPTY_SNAPSHOT, REQUEST),
        );
        const opus = find(priced.dailyBuckets, {
          source: "outside",
          projectId: ProjectId.make("p1"),
          model: "claude-opus-5-5",
        })[0]!;
        // Uncached 6, cache reads 50, cache writes 10, output 24.
        expect(opus.costUsd).toBeCloseTo(6 * 5e-6 + 50 * 5e-7 + 10 * 6.25e-6 + 24 * 25e-6, 12);
        expect(find(priced.dailyBuckets, { model: "mystery-model-x" })[0]?.costUsd).toBeUndefined();
        expect(priced.pricing).toBe("live");
      }).pipe(Effect.provide(testLayer(root, () => fixtureSettings(root), RATES)), Effect.scoped),
    );
  });

  it("survives vanished files and unreadable directories, and honors the setting", async () => {
    const root = await copyFixtures();
    let settings = fixtureSettings(root);
    const blocked = join(root, "claude/projects/-elsewhere-tool");
    await FS.chmod(blocked, 0o000);
    roots.unshift(blocked);
    const listing = TranscriptReader.listUsageTranscriptFiles;
    vi.spyOn(TranscriptReader, "listUsageTranscriptFiles").mockImplementation(
      async (directory, modifiedAfterMs, signal) => {
        const listed = await listing(directory, modifiedAfterMs, signal);
        return {
          ...listed,
          files: [
            ...listed.files,
            { path: join(directory, "vanished.jsonl"), size: 10, mtimeMs: 1, fingerprint: "1:2:3" },
          ],
        };
      },
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* UsageService;
        const snapshot = yield* service.machineStatistics(EMPTY_SNAPSHOT, REQUEST);
        expect(snapshot.machine?.state).toBe("ready");
        expect(snapshot.machine?.failedFileCount).toBe(2);
        expect(snapshot.machine?.unreadableDirectoryCount).toBeGreaterThan(0);
        // Everything readable still counts (outside-2's directory is unreadable).
        expect(outsideTotal(snapshot)).toBe(90 + 10 + 1480);

        settings = fixtureSettings(root, { statisticsOutsideSessions: false });
        const disabled = yield* service.machineStatistics(EMPTY_SNAPSHOT, REQUEST);
        expect(disabled.machine?.state).toBe("disabled");
        expect(disabled.dailyBuckets).toEqual([]);
      }).pipe(Effect.provide(testLayer(root, () => settings, RATES)), Effect.scoped),
    );
  });

  it("answers at once with progress while a cold read runs", async () => {
    const root = await copyFixtures();
    const read = TranscriptReader.listUsageTranscriptFiles;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(TranscriptReader, "listUsageTranscriptFiles").mockImplementation(async (...args) => {
      await gate;
      return read(...args);
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* UsageService;
        const first = yield* service.machineStatistics(EMPTY_SNAPSHOT, {
          ...REQUEST,
          maxWaitMs: 0,
        });
        expect(first.machine?.state).toBe("reading");
        expect(first.machine?.progress).toBeDefined();
        expect(first.dailyBuckets).toEqual([]);
        release();
        const done = yield* service.machineStatistics(EMPTY_SNAPSHOT, REQUEST);
        expect(done.machine?.state).toBe("ready");
        expect(outsideTotal(done)).toBe(90 + 20 + 10 + 1480);
      }).pipe(Effect.provide(testLayer(root, () => fixtureSettings(root), RATES)), Effect.scoped),
    );
  });
});
