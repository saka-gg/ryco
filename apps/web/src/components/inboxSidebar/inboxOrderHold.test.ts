import type { SidebarThreadSummary } from "@ryco/client-runtime/state/threads";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyInboxOrderHold, captureInboxOrder } from "./inboxOrderHold";
import {
  buildInboxSidebarModel,
  type InboxSidebarModel,
  type InboxSidebarSectionKey,
  type InboxSidebarStatusFilter,
} from "./inboxSidebarModel";

const ENV = EnvironmentId.make("machine-a");
const PROJECT = ProjectId.make("project-a");
const NOW_MS = Date.parse("2026-08-25T10:00:00.000Z");
const HOLD_KEY = "hold";

function thread(id: string, overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make(id),
    environmentId: ENV,
    projectId: PROJECT,
    title: id,
    interactionMode: "default",
    session: null,
    createdAt: "2026-08-25T08:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-08-25T08:00:00.000Z",
    latestTurn: null,
    branch: "main",
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function turn(state: "running" | "completed", at: string): Partial<SidebarThreadSummary> {
  return {
    latestTurn: {
      turnId: TurnId.make(`turn-${at}`),
      state,
      requestedAt: at,
      startedAt: at,
      completedAt: state === "completed" ? at : null,
      assistantMessageId: null,
    },
  };
}

const running = turn("running", "2026-08-25T09:00:00.000Z");
const completedAt = (minute: number) =>
  turn("completed", `2026-08-25T09:${String(minute).padStart(2, "0")}:00.000Z`);
const delegatedFrom = (parent: string) => ({
  lineage: {
    parentThreadId: ThreadId.make(parent),
    rootThreadId: ThreadId.make(parent),
    relationship: "delegated" as const,
  },
});
const focused: Partial<SidebarThreadSummary> = {
  priority: {
    tier: "now",
    confidence: "high",
    reason: "A release decision is waiting on this task.",
    inputFingerprint: "fingerprint" as never,
    batchId: "batch" as never,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    rankedAt: "2026-08-25T09:59:00.000Z",
    usableUntil: "2026-08-25T10:09:00.000Z",
  },
};

function model(
  threads: ReadonlyArray<SidebarThreadSummary>,
  options: { readonly pinned?: ReadonlyArray<string>; readonly aiFocusEnabled?: boolean } = {},
): InboxSidebarModel {
  return buildInboxSidebarModel({
    projects: [
      {
        id: PROJECT,
        environmentId: ENV,
        name: "Ryco",
        cwd: "/repo/ryco",
        defaultModelSelection: null,
        scripts: [],
      },
    ],
    worktrees: [],
    threads,
    environments: [
      {
        environmentId: ENV,
        label: "Studio Mac",
        connectionState: "connected",
        stale: false,
        role: "owner",
        trust: "verified",
        deliveryUnknown: false,
        threadSettlementSupported: true,
        threadSnoozeSupported: true,
        mutationReady: true,
        shellCurrent: true,
      },
    ],
    filters: { query: "", environmentId: null, status: "all" },
    pinnedThreadKeys: new Set((options.pinned ?? []).map((id) => `${ENV}:${id}`)),
    aiFocusEnabled: options.aiFocusEnabled ?? false,
    autoSettleAfterDays: null,
    nowMs: NOW_MS,
  });
}

/** Each section as "key: thread ids". */
function layout(value: InboxSidebarModel): string[] {
  return value.sections.map(
    (section) => `${section.key}: ${section.rows.map((row) => row.threadId).join(" ")}`,
  );
}

function row(value: InboxSidebarModel, id: string) {
  return value.sections.flatMap((section) => section.rows).find((row) => row.threadId === id);
}

function hold(
  before: InboxSidebarModel,
  live: InboxSidebarModel,
  status: InboxSidebarStatusFilter = "all",
): InboxSidebarModel {
  return applyInboxOrderHold(live, captureInboxOrder(before, HOLD_KEY), status);
}

/** The sections a status filter shows, as `layout` writes them. */
function shown(value: InboxSidebarModel, status: InboxSidebarSectionKey): string[] {
  return layout(value).filter((line) => line.startsWith(`${status}: `));
}

describe("captureInboxOrder", () => {
  it("records the key it was captured under", () => {
    expect(captureInboxOrder(model([thread("r1")]), HOLD_KEY).holdKey).toBe(HOLD_KEY);
  });
});

describe("applyInboxOrderHold", () => {
  it("keeps a thread that finishes at its place, showing its live row", () => {
    const before = model([thread("a1", running), thread("a2", running), thread("r1")]);
    const live = model([thread("a1", completedAt(30)), thread("a2", running), thread("r1")]);
    expect(layout(live)).toEqual(["active: a2", "recent: a1 r1"]);

    const held = hold(before, live);
    expect(layout(held)).toEqual(["active: a1 a2", "recent: r1"]);
    expect(row(held, "a1")).toBe(row(live, "a1"));
    expect(row(held, "a1")?.state).toBe("idle");
  });

  it("keeps a section that empties live, with its held rows and title", () => {
    const before = model([thread("a1", running), thread("r1")]);
    const held = hold(before, model([thread("a1", completedAt(30)), thread("r1")]));
    expect(layout(held)).toEqual(["active: a1", "recent: r1"]);
    expect(held.sections[0]?.title).toBe("Active now");
  });

  it("shows a new thread at its live index", () => {
    const before = model([thread("r1", completedAt(20)), thread("r2", completedAt(10))]);
    const live = model([
      thread("r1", completedAt(20)),
      thread("r2", completedAt(30)),
      thread("n1", completedAt(40)),
    ]);
    expect(layout(live)).toEqual(["recent: n1 r2 r1"]);
    expect(layout(hold(before, live))).toEqual(["recent: n1 r1 r2"]);
  });

  it("drops a deleted or archived thread", () => {
    const before = model([thread("r1"), thread("r2"), thread("r3")]);
    const live = model([thread("r1", { archivedAt: "2026-08-25T09:30:00.000Z" }), thread("r3")]);
    expect(layout(hold(before, live))).toEqual(["recent: r3"]);
  });

  it("moves a pin, settle or snooze at once", () => {
    const before = model([thread("a1", running), thread("r1"), thread("r2"), thread("r3")]);
    const live = model(
      [
        thread("a1", completedAt(30)),
        thread("r1"),
        thread("r2", {
          settledOverride: "settled",
          settledAt: "2026-08-25T09:40:00.000Z",
        }),
        thread("r3", {
          snoozedAt: "2026-08-25T09:50:00.000Z",
          snoozedUntil: "2026-08-26T08:00:00.000Z",
        }),
      ],
      { pinned: ["r1"] },
    );
    expect(layout(hold(before, live))).toEqual([
      "pinned: r1",
      "active: a1",
      "snoozed: r3",
      "settled: r2",
    ]);
  });

  it("holds an AI Focus re-rank", () => {
    const before = model([thread("f1", focused), thread("r1")], { aiFocusEnabled: true });
    const live = model([thread("f1"), thread("r1", focused)], { aiFocusEnabled: true });
    expect(layout(before)).toEqual(["focus: f1", "recent: r1"]);
    expect(layout(live)).toEqual(["focus: r1", "recent: f1"]);
    expect(layout(hold(before, live))).toEqual(["focus: f1", "recent: r1"]);
  });

  it("places a section the hold did not show at its own rank", () => {
    const before = model([thread("a1", running), thread("r1")]);
    const live = model([
      thread("a1", completedAt(30)),
      thread("r1"),
      thread("q1", { hasPendingApprovals: true }),
    ]);
    expect(layout(hold(before, live))).toEqual(["active: a1", "needs-input: q1", "recent: r1"]);
  });

  it("shows a row that enters the filtered section at its live index, and keeps one that leaves", () => {
    const before = model([thread("q1", { hasPendingApprovals: true }), thread("r1"), thread("r2")]);
    const live = model([thread("q1"), thread("r1"), thread("r2", { hasPendingApprovals: true })]);
    expect(layout(before)).toEqual(["needs-input: q1", "recent: r1 r2"]);
    expect(layout(live)).toEqual(["needs-input: r2", "recent: q1 r1"]);
    // The whole inbox holds r2 in Recent; filtered to Needs input, it would not show.
    expect(layout(hold(before, live))).toEqual(["needs-input: q1", "recent: r1 r2"]);
    expect(shown(hold(before, live, "needs-input"), "needs-input")).toEqual(["needs-input: r2 q1"]);
  });

  it("shows a row that enters a filtered section the hold did not show", () => {
    const before = model([thread("r1"), thread("r2")]);
    const live = model([thread("r1"), thread("r2", running)]);
    expect(layout(hold(before, live))).toEqual(["recent: r1 r2"]);
    expect(shown(hold(before, live, "active"), "active")).toEqual(["active: r2"]);
  });

  it("orders sections as the inbox does", () => {
    const live = model(
      [
        thread("p1"),
        thread("f1", focused),
        thread("a1", running),
        // A ready plan, unlike an approval, is not in Focus.
        thread("q1", {
          interactionMode: "plan",
          hasActionableProposedPlan: true,
          ...completedAt(5),
        }),
        thread("r1"),
        thread("z1", {
          snoozedAt: "2026-08-25T09:50:00.000Z",
          snoozedUntil: "2026-08-26T08:00:00.000Z",
        }),
        thread("s1", { settledOverride: "settled", settledAt: "2026-08-25T09:40:00.000Z" }),
      ],
      { pinned: ["p1"], aiFocusEnabled: true },
    );
    expect(live.sections.map((section) => section.key)).toEqual([
      "pinned",
      "focus",
      "active",
      "needs-input",
      "recent",
      "snoozed",
      "settled",
    ]);
    // Every section is new to a hold captured on an empty inbox.
    expect(hold(model([]), live)).toBe(live);
  });

  it("returns the live model itself when the hold changes nothing", () => {
    const threads = [thread("a1", running), thread("r1"), thread("r2", completedAt(30))];
    const before = model(threads);
    expect(hold(before, before)).toBe(before);
    const rebuilt = model(threads);
    expect(hold(before, rebuilt)).toBe(rebuilt);
  });

  it("holds a host's delegated children and shows a new child at its live index", () => {
    const before = model([
      thread("host"),
      thread("c1", { ...delegatedFrom("host"), ...completedAt(10) }),
      thread("c2", { ...delegatedFrom("host"), ...running }),
    ]);
    const live = model([
      thread("host"),
      thread("c1", { ...delegatedFrom("host"), ...completedAt(10) }),
      thread("c2", { ...delegatedFrom("host"), ...completedAt(20) }),
      thread("c3", { ...delegatedFrom("host"), ...completedAt(30) }),
    ]);
    const children = (value: InboxSidebarModel) =>
      row(value, "host")?.delegatedChildren.map((child) => child.threadId);
    expect(layout(before)).toEqual(["active: host"]);
    expect(children(before)).toEqual(["c1", "c2"]);
    expect(layout(live)).toEqual(["recent: host"]);
    expect(children(live)).toEqual(["c3", "c2", "c1"]);

    const held = hold(before, live);
    expect(layout(held)).toEqual(["active: host"]);
    expect(children(held)).toEqual(["c3", "c1", "c2"]);
    expect(row(held, "host")?.state).toBe("idle");
    expect(row(held, "host")?.delegatedChildren[2]).toBe(row(live, "host")?.delegatedChildren[1]);
  });
});
