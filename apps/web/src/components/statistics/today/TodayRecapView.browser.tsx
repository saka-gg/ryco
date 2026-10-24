import "../../../index.css";
import type {
  DailyRecapDigestInput,
  MergedDailyRecap,
  MergedDailyRecapThread,
  ReadyDailyRecap,
} from "@ryco/client-runtime/state/dailyRecap";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type DailyRecapSnapshot,
  type UsageCalendarDate,
} from "@ryco/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { parseStatisticsSearch } from "../statisticsSearch";
import { TodayRecapView, type TodayRecapViewProps } from "./TodayRecapView";
import type { DailyRecapNodeView } from "./useDailyRecap";

const MAC = EnvironmentId.make("mac");
const LINUX = EnvironmentId.make("linux");
const LABELS: Record<string, string> = { [MAC]: "Mac Studio", [LINUX]: "Linux box" };
const TODAY = "2026-10-24" as UsageCalendarDate;
const UPDATED_AT_MS = Date.parse("2026-10-24T12:00:00.000Z");
const emptySection = { totalThreads: 0, threads: [], truncated: false };

function thread(id: string, environmentId = MAC): MergedDailyRecapThread {
  return {
    threadId: ThreadId.make(id),
    threadTitle: `Chat ${id}`,
    projectId: ProjectId.make("ryco"),
    projectTitle: "ryco",
    lastActivityAt: "2026-10-24T10:00:00.000Z",
    environmentId,
    environmentLabel: LABELS[environmentId] ?? environmentId,
  };
}

function recap(overrides: Partial<MergedDailyRecap> = {}): MergedDailyRecap {
  return {
    date: TODAY,
    timeZone: "UTC",
    counts: { completedTurns: 0, failedTurns: 0, interruptedTurns: 0 },
    completed: emptySection,
    failed: emptySection,
    activity: { agentMs: 0, projects: [] },
    activityMissing: [],
    updatedAtMs: UPDATED_AT_MS,
    ...overrides,
  };
}

const busyDay = recap({
  counts: { completedTurns: 34, failedTurns: 3, interruptedTurns: 0 },
  completed: { totalThreads: 2, threads: [thread("one"), thread("two")], truncated: false },
  failed: { totalThreads: 1, threads: [thread("three")], truncated: false },
  activity: {
    agentMs: 4 * 3_600_000 + 12 * 60_000,
    projects: [
      {
        projectId: ProjectId.make("ryco"),
        projectTitle: "ryco",
        turns: 30,
        agentMs: 3_600_000,
        environmentId: MAC,
        environmentLabel: "Mac Studio",
      },
    ],
  },
});

const usage: DailyRecapDigestInput["usage"] = {
  today: {
    tokens: 41_000_000,
    costUsd: 12.4,
    costPartial: false,
    topModel: { provider: "claude", model: "claude-opus-5-5", share: 0.8 },
  },
  yesterday: { tokens: 30_000_000, costUsd: null, costPartial: false, topModel: null },
};

function snapshot(): DailyRecapSnapshot {
  return {
    date: TODAY,
    timeZone: "UTC",
    generatedAt: "2026-10-24T12:00:00.000Z",
    from: "2026-10-24T00:00:00.000Z",
    to: "2026-10-25T00:00:00.000Z",
    counts: { completedTurns: 0, failedTurns: 0, interruptedTurns: 0 },
    completed: emptySection,
    failed: emptySection,
    needsAttention: emptySection,
  };
}

function ready(environmentId: EnvironmentId): ReadyDailyRecap {
  return {
    environmentId,
    label: LABELS[environmentId] ?? environmentId,
    requestedAtMs: UPDATED_AT_MS,
    status: "ready",
    snapshot: snapshot(),
  };
}

function readyNode(environmentId: EnvironmentId): DailyRecapNodeView {
  const result = ready(environmentId);
  return { environmentId, label: result.label, result, recap: result, stale: false };
}

function issueNode(
  environmentId: EnvironmentId,
  status: "offline" | "unsupported",
): DailyRecapNodeView {
  const label = LABELS[environmentId] ?? environmentId;
  return {
    environmentId,
    label,
    result: { environmentId, label, requestedAtMs: UPDATED_AT_MS, status },
    recap: undefined,
    stale: false,
  };
}

function props(overrides: Partial<TodayRecapViewProps> = {}): TodayRecapViewProps {
  return {
    search: parseStatisticsSearch({ view: "today" }),
    onSearchChange: () => {},
    recap: {
      today: busyDay,
      yesterday: recap({ counts: { completedTurns: 42, failedTurns: 0, interruptedTurns: 0 } }),
      nodes: [readyNode(MAC)],
      availableEnvironments: [{ environmentId: MAC, label: "Mac Studio" }],
      connecting: false,
      loading: false,
      refreshing: false,
    },
    usage,
    tasks: { dueToday: 2, overdue: 1 },
    waitingThreads: 2,
    hosted: false,
    projectLabel: (item) => item.projectTitle,
    onRefresh: () => {},
    onOpenThread: () => {},
    onOpenTasks: () => {},
    ...overrides,
  };
}

function Harness(initial: TodayRecapViewProps) {
  const [search, setSearch] = useState(initial.search);
  return (
    <div style={{ width: 1100 }}>
      <TodayRecapView {...initial} search={search} onSearchChange={setSearch} />
    </div>
  );
}

describe("Today recap", () => {
  it("tells the day, shows its tiles and opens a listed chat", async () => {
    const onOpenThread = vi.fn();
    const onOpenTasks = vi.fn();
    await render(<Harness {...props({ onOpenThread, onOpenTasks })} />);

    await expect
      .element(page.getByText(/You finished/))
      .toHaveTextContent(
        [
          "You finished 34 turns in 2 chats. 3 failed.",
          "Most of it went into ryco. Agents ran for 4h 12m.",
          "Providers recorded 41M tokens, mostly Claude Opus 5.5.",
          "2 chats are waiting on you.",
          "2 tasks are due today, 1 overdue.",
        ].join(" "),
      );
    for (const label of ["Finished", "Agent time", "Top project", "Provider tokens", "Yesterday"]) {
      await expect.element(page.getByText(label, { exact: true })).toBeInTheDocument();
    }
    await expect.element(page.getByText("Tasks", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("Mostly Claude Opus 5.5 · $12.40")).toBeInTheDocument();
    await expect.element(page.getByText("From Mac Studio.")).toBeInTheDocument();

    await page.getByRole("button", { name: /Chat three/ }).click();
    expect(onOpenThread).toHaveBeenCalledWith(MAC, ThreadId.make("three"));
    await page.getByRole("button", { name: "Open tasks" }).click();
    expect(onOpenTasks).toHaveBeenCalledTimes(1);
    // One device: its name is not repeated on every row.
    await expect
      .element(page.getByRole("button", { name: /Chat one/ }))
      .toMatchTextContent(/^Chat oneryco · \d/);
  });

  it("names a device without agent time and leaves its tiles out", async () => {
    await render(
      <Harness
        {...props({
          recap: {
            ...props().recap,
            today: { ...busyDay, activity: null, activityMissing: [MAC] },
          },
        })}
      />,
    );

    await expect.element(page.getByText("Finished", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("Agent time", { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText("Top project", { exact: true })).not.toBeInTheDocument();
    await expect
      .element(page.getByText("Mac Studio needs a Ryco update for agent time and projects."))
      .toBeInTheDocument();
  });

  it("names the devices missing from the recap and their place on each row", async () => {
    await render(
      <Harness
        {...props({
          recap: {
            ...props().recap,
            today: {
              ...busyDay,
              completed: {
                totalThreads: 2,
                threads: [thread("one"), thread("four", LINUX)],
                truncated: false,
              },
            },
            nodes: [
              readyNode(MAC),
              readyNode(LINUX),
              issueNode(EnvironmentId.make("laptop"), "offline"),
              issueNode(EnvironmentId.make("server"), "unsupported"),
            ],
          },
          hosted: true,
        })}
      />,
    );

    await expect.element(page.getByText("From Mac Studio and Linux box.")).toBeInTheDocument();
    await expect.element(page.getByText("laptop is offline.")).toBeInTheDocument();
    await expect
      .element(page.getByText("server needs a Ryco update for the recap."))
      .toBeInTheDocument();
    await expect.element(page.getByText("Includes connected devices only.")).toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: /Chat four/ }))
      .toMatchTextContent("ryco · Linux box · ");
  });

  it("tells yesterday on a day with nothing finished yet", async () => {
    await render(
      <Harness
        {...props({
          recap: { ...props().recap, today: recap() },
          usage: null,
          tasks: null,
          waitingThreads: 0,
        })}
      />,
    );

    await expect
      .element(page.getByText("Nothing finished yet today. Yesterday you finished 42 turns."))
      .toBeInTheDocument();
    await expect.element(page.getByText("No chat finished a turn yet.")).toBeInTheDocument();
    await expect.element(page.getByText("No failed turns.")).toBeInTheDocument();
  });

  it("offers to try again when no device answered", async () => {
    const onRefresh = vi.fn();
    await render(
      <Harness
        {...props({
          recap: {
            ...props().recap,
            today: null,
            yesterday: null,
            nodes: [issueNode(MAC, "offline")],
          },
          onRefresh,
        })}
      />,
    );

    await expect.element(page.getByText("Couldn’t load today’s recap")).toBeInTheDocument();
    await expect.element(page.getByText("Mac Studio is offline.")).toBeInTheDocument();
    await page.getByRole("button", { name: "Try again" }).click();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("says when no device is connected", async () => {
    await render(
      <Harness
        {...props({
          recap: {
            ...props().recap,
            today: null,
            yesterday: null,
            nodes: [],
            availableEnvironments: [],
          },
        })}
      />,
    );

    await expect.element(page.getByText("No devices are connected")).toBeInTheDocument();
    await expect.element(page.getByLabelText("Recap environment")).not.toBeInTheDocument();
  });

  it("keeps the device choice when the chosen device is not connected", async () => {
    await render(
      <Harness
        {...props({
          search: parseStatisticsSearch({ view: "today", environmentIds: [LINUX] }),
          recap: { ...props().recap, today: null, yesterday: null, nodes: [] },
        })}
      />,
    );

    await expect.element(page.getByText("The selected device isn’t connected")).toBeInTheDocument();
    await expect.element(page.getByLabelText("Recap environment")).toBeInTheDocument();
  });

  it("lists eight chats until asked for all, and counts the ones left unlisted", async () => {
    const threads = Array.from({ length: 10 }, (_, index) => thread(`row-${index}`));
    await render(
      <Harness
        {...props({
          recap: {
            ...props().recap,
            today: { ...busyDay, completed: { totalThreads: 13, threads, truncated: true } },
          },
        })}
      />,
    );

    await expect.element(page.getByRole("button", { name: /Chat row-7/ })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: /Chat row-8/ })).not.toBeInTheDocument();
    await expect.element(page.getByText("3 more not shown")).toBeInTheDocument();
    await page.getByRole("button", { name: "Show all" }).click();
    await expect.element(page.getByRole("button", { name: /Chat row-9/ })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Show all" })).not.toBeInTheDocument();
  });
});
