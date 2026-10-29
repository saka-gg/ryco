import type { SidebarThreadSummary } from "@ryco/client-runtime/state/threads";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildInboxAttentionCandidates,
  stepInboxAttention,
  type InboxAttentionInput,
  type InboxAttentionPress,
} from "./inboxAttention";
import type { InboxSidebarEnvironment } from "./inboxSidebarModel";

const ENV = EnvironmentId.make("machine-a");
const PROJECT = ProjectId.make("project-a");
const NOW_MS = Date.parse("2026-08-25T10:00:00.000Z");

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

/** A turn that ended (or started) at 09:MM. */
function turn(state: "running" | "completed" | "error", minute: number) {
  const at = `2026-08-25T09:${String(minute).padStart(2, "0")}:00.000Z`;
  return {
    latestTurn: {
      turnId: TurnId.make(`turn-${minute}`),
      state,
      requestedAt: at,
      startedAt: at,
      completedAt: state === "running" ? null : at,
      assistantMessageId: null,
    },
  } satisfies Partial<SidebarThreadSummary>;
}

const approval = { hasPendingApprovals: true } as const;
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

function environment(
  environmentId: EnvironmentId,
  overrides: Partial<InboxSidebarEnvironment> = {},
): InboxSidebarEnvironment {
  return {
    environmentId,
    label: environmentId,
    connectionState: "connected",
    stale: false,
    role: "owner",
    trust: "verified",
    deliveryUnknown: false,
    threadSettlementSupported: true,
    threadSnoozeSupported: true,
    mutationReady: true,
    shellCurrent: true,
    ...overrides,
  };
}

function inbox(
  threads: ReadonlyArray<SidebarThreadSummary>,
  options: Partial<InboxAttentionInput> = {},
): InboxAttentionInput {
  const environmentIds = new Set(threads.map((entry) => entry.environmentId));
  return {
    projects: [...environmentIds].map((environmentId) => ({
      id: PROJECT,
      environmentId,
      name: "Ryco",
      cwd: "/repo/ryco",
      defaultModelSelection: null,
      scripts: [],
    })),
    worktrees: [],
    threads,
    environments: [...environmentIds].map((environmentId) => environment(environmentId)),
    autoSettleAfterDays: null,
    lastVisitedAtByKey: {},
    nowMs: NOW_MS,
    ...options,
  };
}

const key = (id: string) => `${ENV}:${id}`;

/** The thread ids a walk from no open thread visits, in order. */
function walkOrder(input: InboxAttentionInput): string[] {
  const walk = stepInboxAttention(input, {
    routeThreadKey: null,
    direction: "next",
    previous: null,
  });
  return (walk?.orderedKeys ?? []).map((entry) => entry.slice(entry.indexOf(":") + 1));
}

describe("buildInboxAttentionCandidates", () => {
  it("walks waiting threads, then unseen failures, then unseen results, newest first", () => {
    const input = inbox(
      [
        thread("working", turn("running", 50)),
        thread("seen", turn("completed", 40)),
        thread("done-old", turn("completed", 10)),
        thread("done-new", turn("completed", 30)),
        thread("failed", turn("error", 5)),
        thread("plan", {
          interactionMode: "plan",
          hasActionableProposedPlan: true,
          ...turn("completed", 20),
        }),
        thread("question", { hasPendingUserInput: true }),
        thread("approval", approval),
      ],
      { lastVisitedAtByKey: { [key("seen")]: "2026-08-25T09:45:00.000Z" } },
    );
    expect(walkOrder(input)).toEqual([
      "approval",
      "question",
      "plan",
      "failed",
      "done-new",
      "done-old",
    ]);
  });

  it("skips settled and snoozed threads", () => {
    const input = inbox([
      thread("settled", {
        ...turn("completed", 10),
        settledOverride: "settled",
        settledAt: "2026-08-25T09:40:00.000Z",
      }),
      thread("snoozed", {
        ...turn("completed", 30),
        snoozedAt: "2026-08-25T09:50:00.000Z",
        snoozedUntil: "2026-08-26T08:00:00.000Z",
      }),
      thread("done", turn("completed", 20)),
    ]);
    expect(walkOrder(input)).toEqual(["done"]);
  });

  it("never stops on a machine that is offline or not current yet", () => {
    const offline = EnvironmentId.make("machine-offline");
    const cached = EnvironmentId.make("machine-cached");
    const input = inbox(
      [
        thread("here", turn("completed", 10)),
        thread("away", { ...approval, environmentId: offline }),
        thread("stale", { ...approval, environmentId: cached }),
      ],
      {
        environments: [
          environment(ENV),
          environment(offline, { connectionState: "offline" }),
          environment(cached, { stale: true }),
        ],
      },
    );
    expect(walkOrder(input)).toEqual(["here"]);
  });

  it("keeps an unseen failure while its machine connects", () => {
    const input = inbox([thread("failed", turn("error", 5))], {
      environments: [environment(ENV, { connectionState: "connecting" })],
    });
    expect(buildInboxAttentionCandidates(input)).toMatchObject([
      { key: key("failed"), reason: "failed" },
    ]);
  });

  it("stops at a sub-agent's approval, not at its host or at its returned result", () => {
    const input = inbox([
      thread("host", turn("completed", 30)),
      thread("asking", { ...delegatedFrom("host"), ...approval }),
      thread("returned", { ...delegatedFrom("host"), ...turn("completed", 20) }),
    ]);
    expect(walkOrder(input)).toEqual(["asking", "host"]);
  });

  it("puts Focus rows first, in Focus order, only with AI Focus on", () => {
    const threads = [
      thread("newer", turn("completed", 30)),
      thread("ranked", { ...turn("completed", 10), ...focused }),
    ];
    expect(walkOrder(inbox(threads))).toEqual(["newer", "ranked"]);
    expect(buildInboxAttentionCandidates(inbox(threads)).map((entry) => entry.focusIndex)).toEqual([
      null,
      null,
    ]);
    expect(walkOrder(inbox(threads, { aiFocusEnabled: true }))).toEqual(["ranked", "newer"]);
  });
});

describe("stepInboxAttention", () => {
  it("goes on from the last press's target until the route gets there", () => {
    const input = inbox([
      thread("first", approval),
      thread("second", { hasPendingUserInput: true }),
    ]);
    const step = (previous: InboxAttentionPress | null) =>
      stepInboxAttention(input, { routeThreadKey: null, direction: "next", previous });

    const first = step(null);
    expect(first?.targetKey).toBe(key("first"));
    // A second press before the route reached "first" does not open it again.
    expect(step({ walk: first!, navigating: true })?.targetKey).toBe(key("second"));
    // Once the route moved on, the open thread is where the walk starts.
    expect(step({ walk: first!, navigating: false })?.targetKey).toBe(key("first"));
  });

  it("returns null when no other thread needs the user", () => {
    const input = inbox([thread("only", approval), thread("idle")]);
    expect(
      stepInboxAttention(input, {
        routeThreadKey: key("only"),
        direction: "next",
        previous: null,
      }),
    ).toBeNull();
  });
});
