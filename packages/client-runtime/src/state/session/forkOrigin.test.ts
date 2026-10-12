import {
  EventId,
  MessageId,
  TurnId,
  type OrchestrationThreadActivity,
  type ThreadForkedActivityPayload,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ChatMessage } from "../threads/types.ts";
import {
  FORK_HANDOFF_COPY,
  forkHandoffAccessibleLabel,
  forkHandoffEndpointLabels,
  forkHandoffHeadline,
  forkHandoffRetryHint,
  isCwdRelocationHandoff,
  isForkHandoff,
  isModelChangeHandoff,
  resolvePendingComposerHandoff,
  toContextHandoffTimelineEntry,
} from "./contextHandoff.ts";
import {
  FORK_ORIGIN_COPY,
  forkBoundaryTurnId,
  forkOriginAccessibleLabel,
  forkOriginCheckoutLine,
  forkOriginHeadline,
  forkOriginProviderLine,
  forkTimelineBand,
  forkTimelineInheritedPrefix,
  toForkOriginTimelineEntry,
  type ForkOriginTimelineEntry,
} from "./forkOrigin.ts";
import {
  deriveThreadActivityViewModel,
  deriveTimelineEntries,
  deriveWorkLogEntries,
} from "./session-logic.ts";

const FORKED_AT = "2026-10-11T12:00:00.000Z";

function forkedPayload(overrides: Partial<ThreadForkedActivityPayload> = {}): unknown {
  return {
    schemaVersion: 1,
    sourceThreadId: "source-thread",
    sourceMessageId: "source-reply",
    sourceTurnId: "source-turn",
    sourceTitle: "Refactor auth",
    inheritedMessageCount: 2,
    providerContext: "native",
    checkout: { kind: "current-checkout", worktreePath: null, branch: "main" },
    notices: [],
    ...overrides,
  };
}

function activity(
  id: string,
  kind: string,
  payload: unknown,
  createdAt = FORKED_AT,
  turnId: string | null = null,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    kind,
    summary: kind,
    tone: kind.startsWith("tool.") ? "tool" : "info",
    payload,
    turnId: turnId ? TurnId.make(turnId) : null,
    createdAt,
  };
}

const forkedActivity = (overrides: Partial<ThreadForkedActivityPayload> = {}) =>
  activity("fork-thread:forked", "thread.forked", forkedPayload(overrides));

function entry(overrides: Partial<ThreadForkedActivityPayload> = {}): ForkOriginTimelineEntry {
  const decoded = toForkOriginTimelineEntry(forkedActivity(overrides));
  if (!decoded) throw new Error("fixture did not decode");
  return decoded;
}

describe("toForkOriginTimelineEntry", () => {
  it("decodes the provenance activity into a divider", () => {
    expect(entry({ providerContext: "handoff", handoffReason: "no-native-session" })).toEqual({
      id: "fork-origin:fork-thread:forked",
      activityId: "fork-thread:forked",
      createdAt: FORKED_AT,
      inheritedItemIdPrefix: "fork-thread:inherited:",
      sourceThreadId: "source-thread",
      sourceMessageId: "source-reply",
      sourceTurnId: "source-turn",
      sourceTitle: "Refactor auth",
      inheritedMessageCount: 2,
      providerContext: "handoff",
      handoffReason: "no-native-session",
      checkout: { kind: "current-checkout", worktreePath: null, branch: "main" },
      notices: [],
    });
  });

  it("ignores other kinds and payloads it cannot read", () => {
    expect(toForkOriginTimelineEntry(activity("a", "tool.completed", forkedPayload()))).toBeNull();
    expect(
      toForkOriginTimelineEntry(activity("b", "thread.forked", { schemaVersion: 9 })),
    ).toBeNull();
  });

  it("keeps the divider's identity while its activity record is unchanged", () => {
    const record = forkedActivity();
    const other = activity("tool", "tool.completed", {}, FORKED_AT, "source-turn");
    expect(toForkOriginTimelineEntry(record)).toBe(toForkOriginTimelineEntry(record));
    expect(deriveThreadActivityViewModel([record], null).forkOriginEntries[0]).toBe(
      deriveThreadActivityViewModel([record, other], null).forkOriginEntries[0],
    );
  });
});

describe("fork-origin copy", () => {
  it("names the source and how the provider continues", () => {
    expect(forkOriginHeadline(entry())).toBe("Forked from “Refactor auth”");
    expect(forkOriginProviderLine(entry())).toBe(FORK_ORIGIN_COPY.native);
    expect(
      forkOriginProviderLine(
        entry({ providerContext: "handoff", handoffReason: "provider-unsupported" }),
      ),
    ).toBe(`This provider can't copy its session. ${FORK_ORIGIN_COPY.handoff}`);
    expect(forkOriginProviderLine(entry({ providerContext: "handoff" }))).toBe(
      FORK_ORIGIN_COPY.handoff,
    );
  });

  it("describes each checkout without claiming file parity it does not have", () => {
    expect(forkOriginCheckoutLine(entry())).toBe(
      "Shares the original's checkout on main. Files weren't copied or rewound.",
    );
    expect(
      forkOriginCheckoutLine(
        entry({ checkout: { kind: "current-checkout", worktreePath: "/w/a", branch: "feat" } }),
      ),
    ).toBe("Shares the original's worktree on feat. Files weren't copied or rewound.");
    expect(
      forkOriginCheckoutLine(
        entry({ checkout: { kind: "current-checkout", worktreePath: null, branch: null } }),
      ),
    ).toBe("Shares the original's folder. Files weren't copied or rewound.");
    const worktree = {
      kind: "new-worktree" as const,
      worktreeId: "worktree-fork" as never,
      worktreePath: "/w/fork",
      branch: "ryco/fork-1a2b3c4d",
      baseRef: "main",
    };
    expect(forkOriginCheckoutLine(entry({ checkout: { ...worktree, start: "checkpoint" } }))).toBe(
      "New worktree on ryco/fork-1a2b3c4d, from this turn's saved checkpoint.",
    );
    expect(forkOriginCheckoutLine(entry({ checkout: { ...worktree, start: "base-ref" } }))).toBe(
      "New worktree on ryco/fork-1a2b3c4d, from main. Files may differ from this point in the conversation.",
    );
    expect(
      forkOriginCheckoutLine(entry({ checkout: { kind: "new-chat", folder: "/chats/fork" } })),
    ).toBe(FORK_ORIGIN_COPY.newChat);
  });

  it("reads the whole divider as sentences, including server notices", () => {
    expect(forkOriginAccessibleLabel(entry({ notices: ["2 attachments weren't copied."] }))).toBe(
      "Forked from “Refactor auth”. Continues an independent copy of the provider's session from this point. Shares the original's checkout on main. Files weren't copied or rewound. 2 attachments weren't copied",
    );
  });
});

describe("fork-origin in the timeline", () => {
  const inherited: ChatMessage[] = [
    {
      id: MessageId.make("fork-thread:inherited:user-1"),
      role: "user",
      text: "Do it",
      turnId: TurnId.make("source-turn"),
      createdAt: "2026-10-11T11:00:00.000Z",
      streaming: false,
    },
    {
      id: MessageId.make("fork-thread:inherited:source-reply"),
      role: "assistant",
      text: "Done",
      turnId: TurnId.make("source-turn"),
      createdAt: "2026-10-11T11:01:00.000Z",
      streaming: false,
    },
  ];
  const own: ChatMessage = {
    id: MessageId.make("own-1"),
    role: "user",
    text: "Next",
    createdAt: "2026-10-11T12:05:00.000Z",
    streaming: false,
  };

  it("projects the divider instead of a work entry, even before the fork's first turn", () => {
    const activities = [
      activity(
        "fork-thread:inherited:tool-1",
        "tool.completed",
        {},
        "2026-10-11T11:00:30.000Z",
        "source-turn",
      ),
      forkedActivity(),
    ];
    const viewModel = deriveThreadActivityViewModel(activities, null);
    expect(viewModel.forkOriginEntries.map((marker) => marker.id)).toEqual([
      "fork-origin:fork-thread:forked",
    ]);
    expect(viewModel.workLogEntries.map((work) => work.id)).toEqual([
      "fork-thread:inherited:tool-1",
    ]);
    expect(deriveWorkLogEntries(activities, undefined).map((work) => work.id)).toEqual([
      "fork-thread:inherited:tool-1",
    ]);
  });

  it("renders inherited tool rows as the source did with the boundary turn as its latest", () => {
    const earlierTool = activity(
      "fork-thread:inherited:tool-earlier",
      "tool.completed",
      {},
      "2026-10-11T10:00:30.000Z",
      "earlier-turn",
    );
    const boundaryTool = activity(
      "fork-thread:inherited:tool-boundary",
      "tool.completed",
      {},
      "2026-10-11T11:00:30.000Z",
      "source-turn",
    );
    const activities = [earlierTool, boundaryTool, forkedActivity()];
    expect(forkBoundaryTurnId(activities)).toBe("source-turn");
    // No turn of its own yet: only the boundary turn keeps its tool rows, as on the source.
    expect(
      deriveThreadActivityViewModel(activities, null).workLogEntries.map((work) => work.id),
    ).toEqual(["fork-thread:inherited:tool-boundary"]);
    expect(
      deriveThreadActivityViewModel(activities, undefined).workLogEntries.map((work) => work.id),
    ).toEqual(["fork-thread:inherited:tool-boundary"]);
    // Once the fork runs its own turn, that turn is the latest and inherited tools fold away.
    const ownTool = activity("own-tool", "tool.completed", {}, "2026-10-11T12:10:00.000Z", "own");
    expect(
      deriveThreadActivityViewModel(
        [...activities, ownTool],
        TurnId.make("own"),
      ).workLogEntries.map((work) => work.id),
    ).toEqual(["own-tool"]);
  });

  it("leaves threads that are not forks unfiltered without a latest turn", () => {
    const tool = activity("tool-1", "tool.completed", {}, FORKED_AT, "some-turn");
    expect(forkBoundaryTurnId([tool])).toBeNull();
    expect(
      deriveThreadActivityViewModel([tool], null).workLogEntries.map((work) => work.id),
    ).toEqual(["tool-1"]);
  });

  it("sits after the inherited history and before the fork's own messages", () => {
    const timeline = deriveTimelineEntries([...inherited, own], [], [], [], [], [entry()]);
    expect(timeline.map((row) => `${row.kind}:${row.id}`)).toEqual([
      "message:fork-thread:inherited:user-1",
      "message:fork-thread:inherited:source-reply",
      "fork-origin:fork-origin:fork-thread:forked",
      "message:own-1",
    ]);
  });

  it("keeps a lagging client's message below the divider", () => {
    // Stamped by a client clock behind the node: earlier than the inherited reply.
    const lagging = { ...own, createdAt: "2026-10-11T11:00:30.000Z" };
    const timeline = deriveTimelineEntries([...inherited, lagging], [], [], [], [], [entry()]);
    expect(timeline.map((row) => row.id)).toEqual([
      "fork-thread:inherited:user-1",
      "fork-thread:inherited:source-reply",
      "fork-origin:fork-thread:forked",
      "own-1",
    ]);
  });
});

describe("fork timeline bands", () => {
  it("orders inherited history, the divider and the fork's own items", () => {
    const prefix = forkTimelineInheritedPrefix([entry()]);
    expect(prefix).toBe("fork-thread:inherited:");
    expect(forkTimelineBand({ kind: "work", id: "fork-thread:inherited:tool-1" }, prefix)).toBe(0);
    expect(
      forkTimelineBand({ kind: "fork-origin", id: "fork-origin:fork-thread:forked" }, prefix),
    ).toBe(1);
    expect(forkTimelineBand({ kind: "message", id: "own-1" }, prefix)).toBe(2);
    // A fork of a fork inherits under its own id only.
    expect(forkTimelineBand({ kind: "message", id: "other-fork:inherited:m" }, prefix)).toBe(2);
  });

  it("leaves threads that are not forks in one chronological band", () => {
    expect(forkTimelineInheritedPrefix([])).toBeNull();
    expect(forkTimelineBand({ kind: "message", id: "own-1" }, null)).toBe(0);
  });
});

function handoffActivity(
  status: "consumed" | "failed" | "delivery-uncertain",
  overrides: Record<string, unknown> = {},
) {
  return activity("handoff", "context-handoff", {
    schemaVersion: 1,
    handoffId: "handoff-1",
    mode: "full-context-fresh-session",
    reason: "fork",
    targetMessageId: "own-1",
    sourceSelection: { instanceId: "opencode", model: "m" },
    targetSelection: { instanceId: "opencode", model: "m" },
    sources: [{ providerInstanceId: "opencode", driverKind: "opencode", modelSlug: "m" }],
    target: { providerInstanceId: "opencode", driverKind: "opencode", modelSlug: "m" },
    contextVersion: 1,
    contextDigest: "a".repeat(64),
    status,
    ...(status === "consumed" ? {} : { error: "Provider exited" }),
    ...overrides,
  });
}

describe("pending composer handoff", () => {
  const modelChange = { source: "Codex", target: "Claude" };
  const handoffFork = forkedActivity({
    providerContext: "handoff",
    handoffReason: "provider-unsupported",
  });

  it("puts a fork's owed handoff before a model change", () => {
    expect(
      resolvePendingComposerHandoff({ activities: [handoffFork], modelChange: () => modelChange }),
    ).toEqual({ kind: "fork" });
  });

  it("falls back to the model change once nothing is owed", () => {
    expect(
      resolvePendingComposerHandoff({
        activities: [handoffFork, handoffActivity("consumed")],
        modelChange: () => modelChange,
      }),
    ).toEqual({ kind: "model-change", ...modelChange });
    expect(
      resolvePendingComposerHandoff({ activities: [forkedActivity()], modelChange: () => null }),
    ).toBeNull();
    // A composer that shows no handoff chips passes no activities.
    expect(
      resolvePendingComposerHandoff({ activities: null, modelChange: () => modelChange }),
    ).toEqual({ kind: "model-change", ...modelChange });
  });
});

describe("fork context handoff copy", () => {
  it("tells forks apart from relocations and model changes", () => {
    expect(isForkHandoff({ reason: "fork" })).toBe(true);
    expect(isCwdRelocationHandoff({ reason: "fork" })).toBe(false);
    expect(isModelChangeHandoff({ reason: "fork" })).toBe(false);
    expect(isModelChangeHandoff({ reason: "cwd-relocation" })).toBe(false);
    expect(isModelChangeHandoff({ reason: "model-change" })).toBe(true);
    expect(isModelChangeHandoff({})).toBe(true);
  });

  it("counts a fork handoff that also switched provider as a model change", () => {
    const claude = { providerInstanceId: "claude", driverKind: "claudeAgent", modelSlug: "sonnet" };
    const opencode = { providerInstanceId: "opencode", driverKind: "opencode", modelSlug: "m" };
    const switched = handoffActivity("consumed", {
      targetSelection: { instanceId: "claude", model: "sonnet" },
      sources: [opencode],
      target: claude,
    });
    const marker = toContextHandoffTimelineEntry(switched);
    expect(marker).toMatchObject({ reason: "fork", changedFrom: opencode, target: claude });
    expect(isForkHandoff(marker!)).toBe(true);
    expect(isModelChangeHandoff(marker!)).toBe(true);
    // The activity payload (as the inbox reads it) answers the same.
    expect(isModelChangeHandoff(switched.payload as never)).toBe(true);
    // Same provider instance: only the delivery, no transition.
    const same = toContextHandoffTimelineEntry(handoffActivity("consumed"));
    expect(same).not.toHaveProperty("changedFrom");
    expect(isModelChangeHandoff(same!)).toBe(false);
    expect(isModelChangeHandoff(handoffActivity("consumed").payload as never)).toBe(false);
  });

  it("names the model a fork handoff switched from", () => {
    expect(forkHandoffHeadline("consumed", "Claude Sonnet", "OpenCode M")).toBe(
      "Sent the inherited conversation to a fresh Claude Sonnet session, switching from OpenCode M",
    );
    expect(forkHandoffHeadline("failed", "Claude Sonnet", "OpenCode M")).toBe(
      `${FORK_HANDOFF_COPY.failed}, switching from OpenCode M`,
    );
    expect(
      forkHandoffAccessibleLabel(
        { status: "consumed", reason: "fork" },
        "Claude Sonnet",
        "OpenCode M",
      ),
    ).toBe(
      "Sent the inherited conversation to a fresh Claude Sonnet session, switching from OpenCode M",
    );
  });

  it("names the fresh session's model, and both ends with their provider when it switched", () => {
    const labelers = {
      endpoint: (endpoint: { readonly providerInstanceId: string; readonly modelSlug: string }) =>
        `${endpoint.providerInstanceId}/${endpoint.modelSlug}`,
      model: (endpoint: { readonly modelSlug: string }) => endpoint.modelSlug,
    };
    const same = toContextHandoffTimelineEntry(handoffActivity("consumed"))!;
    expect(forkHandoffEndpointLabels(same, labelers)).toEqual({ target: "m", source: null });

    const switched = toContextHandoffTimelineEntry(
      handoffActivity("consumed", {
        targetSelection: { instanceId: "claude", model: "sonnet" },
        target: { providerInstanceId: "claude", driverKind: "claudeAgent", modelSlug: "sonnet" },
      }),
    )!;
    // The provider is what changed: the target names it too, as the source does.
    expect(forkHandoffEndpointLabels(switched, labelers)).toEqual({
      target: "claude/sonnet",
      source: "opencode/m",
    });
  });

  it("reads as delivering the inherited conversation, naming the model when known", () => {
    expect(forkHandoffHeadline("consumed")).toBe(FORK_HANDOFF_COPY.continued);
    expect(forkHandoffHeadline("consumed", "OpenCode Sonnet")).toBe(
      "Sent the inherited conversation to a fresh OpenCode Sonnet session",
    );
    expect(forkHandoffHeadline("failed", "OpenCode Sonnet")).toBe(FORK_HANDOFF_COPY.failed);
    expect(forkHandoffHeadline("delivery-uncertain")).toBe(FORK_HANDOFF_COPY.uncertain);
  });

  it("offers a retry hint for any delivery that did not complete", () => {
    expect(forkHandoffRetryHint({ status: "consumed", reason: "fork" })).toBeNull();
    expect(forkHandoffRetryHint({ status: "failed", reason: "fork" })).toBe(
      FORK_HANDOFF_COPY.retryHint,
    );
    expect(forkHandoffRetryHint({ status: "delivery-uncertain", reason: "fork" })).toBe(
      FORK_HANDOFF_COPY.retryHint,
    );
    expect(forkHandoffRetryHint({ status: "failed", reason: "model-change" })).toBeNull();
    expect(
      forkHandoffAccessibleLabel({ status: "failed", reason: "fork", error: "Provider exited" }),
    ).toBe(
      "Couldn't send the inherited conversation to a fresh session. Failed: Provider exited. Send your message again to retry",
    );
  });
});
