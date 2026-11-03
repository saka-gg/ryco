import {
  EnvironmentId,
  ProjectId,
  USAGE_CONTRACT_VERSION,
  type UsageCalendarDate,
  type UsageDailyBucket,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { MergedUsageBucket, UsageEnvironmentResult } from "../../usage/merge.ts";
import {
  buildDailyRecapDigest,
  buildDailyRecapTiles,
  summarizeRecapUsage,
  summarizeUsageDay,
  type DailyRecapDigestInput,
  type DailyRecapFormat,
  type DailyRecapPart,
  type DailyRecapUsageDay,
} from "./digest.ts";
import type { MergedDailyRecap } from "./merge.ts";

const node = EnvironmentId.make("synthetic-node");
const today = "2026-10-23" as UsageCalendarDate;
const yesterday = "2026-10-22" as UsageCalendarDate;

const format: DailyRecapFormat = {
  integer: (value) => value.toLocaleString("en-US"),
  duration: (ms) => `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`,
  compact: (value) => `${value / 1_000_000}M`,
  model: (model) => `Model ${model}`,
  cost: (usd) => `$${usd.toFixed(2)}`,
};

function project(title: string, turns: number) {
  return {
    projectId: ProjectId.make(title),
    projectTitle: title,
    turns,
    agentMs: turns * 60_000,
    environmentId: node,
    environmentLabel: "Synthetic node",
  };
}

function recap(
  counts: Partial<MergedDailyRecap["counts"]> = {},
  overrides: Partial<MergedDailyRecap> = {},
): MergedDailyRecap {
  const emptySection = { totalThreads: 0, threads: [], truncated: false };
  return {
    date: today,
    timeZone: "Europe/Berlin",
    counts: { completedTurns: 0, failedTurns: 0, interruptedTurns: 0, ...counts },
    completed: emptySection,
    failed: emptySection,
    activity: { agentMs: 0, projects: [] },
    activityMissing: [],
    updatedAtMs: 0,
    ...overrides,
  };
}

const busyDay = recap(
  { completedTurns: 34, failedTurns: 3, interruptedTurns: 1 },
  {
    completed: { totalThreads: 12, threads: [], truncated: true },
    activity: {
      agentMs: 4 * 3_600_000 + 12 * 60_000,
      projects: [project("ryco", 30), project("hub", 4)],
    },
  },
);

function usageDay(
  tokens: number,
  share = 0.8,
  costUsd: number | null = 12.4,
  costPartial = false,
): DailyRecapUsageDay {
  return {
    tokens,
    costUsd,
    costPartial,
    topModel: tokens > 0 ? { provider: "claude", model: "opus", share } : null,
  };
}

function input(overrides: Partial<DailyRecapDigestInput> = {}): DailyRecapDigestInput {
  return {
    today: busyDay,
    yesterday: recap(
      { completedTurns: 42 },
      { activity: { agentMs: 3 * 3_600_000 + 5 * 60_000, projects: [] } },
    ),
    usage: { today: usageDay(41_000_000), yesterday: usageDay(30_000_000) },
    tasks: { dueToday: 2, overdue: 1 },
    waitingThreads: 2,
    ...overrides,
  };
}

const plain = (parts: readonly DailyRecapPart[]) => parts.map((part) => part.text).join("");

function digest(overrides: Partial<DailyRecapDigestInput> = {}) {
  return buildDailyRecapDigest(input(overrides), format).map((sentence) => ({
    id: sentence.id,
    text: plain(sentence.parts),
  }));
}

function tiles(overrides: Partial<DailyRecapDigestInput> = {}) {
  return buildDailyRecapTiles(input(overrides), format).map((tile) => ({
    id: tile.id,
    label: tile.label,
    value: tile.value,
    detail: plain(tile.detail),
  }));
}

describe("the daily recap digest", () => {
  it("tells a full day in order", () => {
    expect(digest()).toEqual([
      { id: "finished", text: "You finished 34 turns in 12 chats. 3 failed." },
      { id: "work", text: "Most of it went into ryco. Agents ran for 4h 12m." },
      { id: "usage", text: "Providers recorded 41M tokens, mostly Model opus." },
      { id: "waiting", text: "2 chats are waiting on you." },
      { id: "tasks", text: "2 tasks are due today, 1 overdue." },
    ]);
  });

  it("marks only failures in the bad tone", () => {
    const toned = buildDailyRecapDigest(input(), format).flatMap((sentence) =>
      sentence.parts.filter((part) => part.kind === "strong" && part.tone === "bad"),
    );
    expect(toned.map((part) => part.text)).toEqual(["3 failed", "1 overdue"]);
  });

  it("uses singular words for one", () => {
    expect(
      digest({
        today: recap(
          { completedTurns: 1, failedTurns: 1 },
          { completed: { totalThreads: 1, threads: [], truncated: false } },
        ),
        usage: null,
        tasks: { dueToday: 1, overdue: 0 },
        waitingThreads: 1,
      }),
    ).toEqual([
      { id: "finished", text: "You finished 1 turn in 1 chat. 1 failed." },
      { id: "waiting", text: "1 chat is waiting on you." },
      { id: "tasks", text: "1 task is due today." },
    ]);
  });

  it("tells failures and overdue tasks on their own", () => {
    expect(
      digest({
        today: recap({ failedTurns: 2 }),
        usage: null,
        tasks: { dueToday: 0, overdue: 3 },
        waitingThreads: 0,
      }),
    ).toEqual([
      { id: "finished", text: "2 turns failed today." },
      { id: "tasks", text: "3 tasks are overdue." },
    ]);
  });

  it("claims most of the work or tokens only when it is", () => {
    expect(
      digest({
        today: recap(
          { completedTurns: 10 },
          {
            completed: { totalThreads: 4, threads: [], truncated: false },
            activity: { agentMs: 0, projects: [project("ryco", 5), project("hub", 3)] },
          },
        ),
        usage: { today: usageDay(1_000_000, 0.4), yesterday: usageDay(0) },
        tasks: null,
        waitingThreads: 0,
      }),
    ).toEqual([
      { id: "finished", text: "You finished 10 turns in 4 chats." },
      { id: "work", text: "Your busiest project was ryco." },
      { id: "usage", text: "Providers recorded 1M tokens, led by Model opus." },
    ]);
  });

  it("leaves out agent time and projects that a node did not report", () => {
    const sentences = digest({ today: { ...busyDay, activity: null, activityMissing: [node] } });
    expect(sentences.map((sentence) => sentence.id)).toEqual([
      "finished",
      "usage",
      "waiting",
      "tasks",
    ]);
  });

  it("does not mention less than a second of agent time", () => {
    const sentences = digest({
      today: { ...busyDay, activity: { agentMs: 999, projects: [] } },
    });
    expect(sentences.map((sentence) => sentence.id)).not.toContain("work");
  });

  it("tells yesterday instead on a day with nothing finished yet", () => {
    expect(
      digest({
        today: recap(),
        usage: null,
        tasks: { dueToday: 0, overdue: 0 },
        waitingThreads: 0,
      }),
    ).toEqual([
      { id: "yesterday", text: "Nothing finished yet today. Yesterday you finished 42 turns." },
    ]);
  });

  it("opens with yesterday on a day whose turns were all stopped", () => {
    const stoppedDay = recap(
      { interruptedTurns: 2 },
      { activity: { agentMs: 120_000, projects: [project("billing-api", 2)] } },
    );
    expect(
      digest({
        today: stoppedDay,
        usage: { today: usageDay(1_000_000), yesterday: usageDay(0) },
        tasks: null,
        waitingThreads: 0,
      }),
    ).toEqual([
      { id: "yesterday", text: "Nothing finished yet today. Yesterday you finished 42 turns." },
      { id: "work", text: "Your busiest project today was billing-api. Agents ran for 0h 2m." },
      { id: "usage", text: "Providers recorded 1M tokens, mostly Model opus." },
    ]);
    expect(
      digest({ today: stoppedDay, yesterday: null, usage: null, tasks: null, waitingThreads: 0 }),
    ).toEqual([
      { id: "work", text: "Your busiest project today was billing-api. Agents ran for 0h 2m." },
    ]);
  });

  it("is empty when nothing happened today or yesterday", () => {
    expect(
      digest({ today: recap(), yesterday: recap(), usage: null, tasks: null, waitingThreads: 0 }),
    ).toEqual([]);
  });
});

describe("the daily recap tiles", () => {
  it("lists every tile in reading order", () => {
    expect(tiles()).toEqual([
      { id: "finished", label: "Finished", value: "34 turns", detail: "In 12 chats · 3 failed" },
      { id: "agent-time", label: "Agent time", value: "4h 12m", detail: "Summed across chats" },
      { id: "top-project", label: "Top project", value: "ryco", detail: "Then hub" },
      {
        id: "provider-tokens",
        label: "Provider tokens",
        value: "41M",
        detail: "Mostly Model opus · $12.40",
      },
      { id: "yesterday", label: "Yesterday", value: "42 turns", detail: "30M tokens · 3h 5m" },
      { id: "tasks", label: "Tasks", value: "2 due", detail: "1 overdue" },
    ]);
  });

  it("marks failures and overdue tasks in the bad tone", () => {
    const toned = buildDailyRecapTiles(input(), format).flatMap((tile) =>
      tile.detail.filter((part) => part.kind === "strong" && part.tone === "bad"),
    );
    expect(toned.map((part) => part.text)).toEqual(["3 failed", "1 overdue"]);
  });

  it("shows only the tiles that have data", () => {
    expect(
      tiles({
        today: recap(
          { completedTurns: 1 },
          {
            completed: { totalThreads: 1, threads: [], truncated: false },
            activity: null,
            activityMissing: [node],
          },
        ),
        yesterday: null,
        usage: null,
        tasks: { dueToday: 0, overdue: 0 },
      }),
    ).toEqual([{ id: "finished", label: "Finished", value: "1 turn", detail: "In 1 chat" }]);
    expect(
      tiles({
        today: recap(),
        yesterday: recap(),
        usage: { today: usageDay(0), yesterday: usageDay(0) },
        tasks: { dueToday: 0, overdue: 2 },
      }),
    ).toEqual([{ id: "tasks", label: "Tasks", value: "2 overdue", detail: "" }]);
  });

  it("names a lone project's turns and leaves out an unknown cost", () => {
    const byId = new Map(
      tiles({
        today: {
          ...busyDay,
          activity: { agentMs: 60_000, projects: [project("ryco", 1)] },
        },
        usage: { today: usageDay(2_000_000, 0.5, null), yesterday: usageDay(0) },
      }).map((tile) => [tile.id, tile]),
    );
    expect(byId.get("top-project")?.detail).toBe("1 turn");
    expect(byId.get("provider-tokens")?.detail).toBe("Led by Model opus");
    expect(byId.get("yesterday")?.detail).toBe("3h 5m");
  });

  it("gives a partly priced day's cost as a floor", () => {
    const providerTokens = tiles({
      usage: { today: usageDay(2_000_000, 0.8, 9.1, true), yesterday: usageDay(0) },
    }).find((tile) => tile.id === "provider-tokens");
    expect(providerTokens?.detail).toBe("Mostly Model opus · at least $9.10");
  });

  it("tells failures alone on a day with nothing finished", () => {
    expect(tiles({ today: recap({ failedTurns: 2 }) })[0]).toEqual({
      id: "finished",
      label: "Finished",
      value: "0 turns",
      detail: "2 failed",
    });
  });
});

function bucket(
  date: UsageCalendarDate,
  model: string,
  totalTokens: number,
  estimatedCostUsd?: number,
): MergedUsageBucket {
  return {
    date,
    provider: model.startsWith("gpt") ? "codex" : "claude",
    model,
    tokens: {
      uncachedInputTokens: totalTokens,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
      totalTokens,
    },
    responseCount: 1,
    sessionCount: 1,
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
    pricedTokenCount: estimatedCostUsd === undefined ? 0 : totalTokens,
    unpricedTokenCount: estimatedCostUsd === undefined ? totalTokens : 0,
    costSource: estimatedCostUsd === undefined ? "unpriced" : "provider-reported",
    sourceIds: ["source"],
  };
}

describe("summarizing a day of provider usage", () => {
  it("counts only that day and ranks models by tokens, not cost", () => {
    expect(
      summarizeUsageDay(
        [
          bucket(today, "opus", 600, 1),
          bucket(today, "gpt-5", 300, 9),
          bucket(today, "opus", 100),
          bucket(yesterday, "gpt-5", 5_000, 50),
        ],
        today,
      ),
    ).toEqual({
      tokens: 1_000,
      costUsd: 10,
      costPartial: true,
      topModel: { provider: "claude", model: "opus", share: 0.7 },
    });
    expect(summarizeUsageDay([bucket(today, "opus", 600, 1)], today).costPartial).toBe(false);
  });

  it("has no cost when nothing is priced and no model without tokens", () => {
    expect(summarizeUsageDay([bucket(today, "opus", 10)], today).costUsd).toBeNull();
    expect(summarizeUsageDay([bucket(today, "opus", 10)], today).costPartial).toBe(false);
    expect(summarizeUsageDay([bucket(yesterday, "opus", 10)], today)).toEqual({
      tokens: 0,
      costUsd: null,
      costPartial: false,
      topModel: null,
    });
  });
});

/** A device's Usage answer: one source, its tokens per day, unpriced. */
function usageEnvironment(
  environmentId: EnvironmentId,
  sourceId: string,
  tokensByDate: Readonly<Record<string, number>>,
): UsageEnvironmentResult {
  return {
    environmentId,
    label: environmentId,
    status: "complete",
    summary: {
      contractVersion: USAGE_CONTRACT_VERSION,
      startDate: "2026-10-17",
      endDate: today,
      timeZone: "Europe/Berlin",
      generatedAt: "2026-10-23T12:00:00.000Z",
      scanDurationMs: 1,
      sources: [
        {
          sourceId,
          provider: "claude",
          deduplicationKind: "physical",
          status: "complete",
          transcriptFileCount: 1,
          reusedCacheFileCount: 0,
          parsedFileCount: 1,
          skippedLineCount: 0,
          malformedLineCount: 0,
          distinctSessionCount: 1,
          distinctResponseCount: 1,
          scanStartedAt: "2026-10-23T12:00:00.000Z",
          scanFinishedAt: "2026-10-23T12:00:00.001Z",
          scanDurationMs: 1,
        },
      ],
      buckets: Object.entries(tokensByDate).map(([date, totalTokens]): UsageDailyBucket => ({
        sourceId,
        date: date as UsageCalendarDate,
        provider: "claude",
        model: "opus",
        tokens: {
          uncachedInputTokens: totalTokens,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          outputTokens: 0,
          totalTokens,
        },
        responseCount: 1,
        sessionCount: 1,
        pricedTokenCount: 0,
        unpricedTokenCount: totalTokens,
        costSource: "unpriced",
      })),
      pricing: { state: "live", recognizedModelCount: 0, unrecognizedModelCount: 1 },
    },
  };
}

describe("the provider usage of the recap's devices", () => {
  const mac = EnvironmentId.make("mac");
  const build = EnvironmentId.make("build");
  const buildUsage = usageEnvironment(build, "build-claude", {
    [today]: 5_000_000,
    [yesterday]: 1_000_000,
  });
  const environments = [
    usageEnvironment(mac, "mac-claude", { [today]: 10_000_000, [yesterday]: 4_000_000 }),
    buildUsage,
  ];

  it("counts only the devices in the recap", () => {
    const usage = summarizeRecapUsage(environments, [mac], today);
    expect(usage?.today.tokens).toBe(10_000_000);
    expect(usage?.yesterday.tokens).toBe(4_000_000);
    expect(summarizeRecapUsage(environments, [mac, build], today)?.today.tokens).toBe(15_000_000);
  });

  it("has no usage when no device in the recap has any", () => {
    expect(summarizeRecapUsage(environments, [], today)).toBeNull();
    expect(summarizeRecapUsage([buildUsage], [mac], today)).toBeNull();
  });
});
