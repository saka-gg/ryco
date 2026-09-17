import { describe, expect, it } from "vite-plus/test";
import {
  ContextHandoffId,
  EnvironmentId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  TurnId,
} from "@ryco/contracts";
import { type ContextHandoffTimelineEntry, type WorkLogEntry } from "../../session-logic";
import { emptyAgentPanelModel } from "../../threadWorkspaceViewModel";
import { type TurnDiffSummary } from "../../types";
import {
  buildTimelineStableState,
  buildTimelineStreamingState,
  computeStableMessagesTimelineRows,
  computeMessageDurationStart,
  deriveMessagesTimelineRows,
  deriveRevertTurnCountByUserMessageId,
  deriveTimelineMinimapItems,
  deriveUndoTurnCountByTurnId,
  isErroredWorkEntry,
  isTimelineScrolledToEnd,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapHitStripWidth,
  resolveTimelineMinimapIndexFromPointer,
  resolveTimelineMinimapInteractiveWidth,
  resolveTimelineMinimapTopPercent,
  type TimelineStableState,
  type TimelineStreamingState,
} from "./MessagesTimeline.logic";

function makeWorkEntry(overrides: Partial<WorkLogEntry> = {}): WorkLogEntry {
  return {
    id: "entry-1",
    createdAt: "2026-01-01T00:00:00Z",
    label: "Bash",
    tone: "tool",
    ...overrides,
  };
}

function makeContextHandoffMarker(
  overrides: Partial<ContextHandoffTimelineEntry> = {},
): ContextHandoffTimelineEntry {
  return {
    id: "context-handoff:activity-1",
    activityId: "activity-1",
    handoffId: ContextHandoffId.make("handoff-1"),
    createdAt: "2026-01-01T00:00:02Z",
    turnId: TurnId.make("turn-target"),
    status: "consumed",
    targetMessageId: MessageId.make("message-target"),
    targetTurnId: TurnId.make("turn-target"),
    sources: [
      {
        providerInstanceId: ProviderInstanceId.make("codex_work"),
        driverKind: ProviderDriverKind.make("codex"),
        providerDisplayName: "Codex Work",
        modelSlug: "gpt-5.6",
        modelDisplayName: "GPT-5.6",
      },
    ],
    target: {
      providerInstanceId: ProviderInstanceId.make("claude_work"),
      driverKind: ProviderDriverKind.make("claudeAgent"),
      providerDisplayName: "Claude Work",
      modelSlug: "claude-fable-5",
      modelDisplayName: "Claude Fable 5",
    },
    ...overrides,
  };
}

describe("timeline minimap", () => {
  it("maps marker geometry and pointer positions deterministically", () => {
    expect(resolveTimelineMinimapHeightStyle(5)).toBe("min(32px, calc(100vh - 18rem))");
    expect(resolveTimelineMinimapTopPercent(2, 5)).toBe(50);
    expect(resolveTimelineMinimapTopPercent(99, 5)).toBe(100);
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 101,
        railTop: 100,
        railHeight: 500,
        pointerY: 350,
      }),
    ).toBe(50);
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 101,
        railTop: 100,
        railHeight: 500,
        pointerY: 999,
      }),
    ).toBe(100);
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 0,
        railTop: 100,
        railHeight: 500,
        pointerY: 350,
      }),
    ).toBeNull();
  });

  it("caps the collapsed hit strip to the safe content gutter", () => {
    expect(resolveTimelineMinimapHasPersistentGutter(863)).toBe(false);
    expect(resolveTimelineMinimapHasPersistentGutter(864)).toBe(true);
    expect(resolveTimelineMinimapHitStripWidth(768)).toBe(0);
    expect(resolveTimelineMinimapHitStripWidth(820)).toBe(14);
    expect(resolveTimelineMinimapHitStripWidth(872)).toBe(40);
    expect(resolveTimelineMinimapHitStripWidth(Number.NaN)).toBe(0);
    expect(resolveTimelineMinimapInteractiveWidth(14, false)).toBe(14);
    expect(resolveTimelineMinimapInteractiveWidth(14, true)).toBe("22rem");
  });

  it("derives one item per user row with displayed prompt and final assistant response", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-row-1",
          kind: "message",
          createdAt: "2026-07-24T12:00:00.000Z",
          message: {
            id: MessageId.make("user-1"),
            role: "user",
            text: [
              "Investigate   the failure",
              "",
              "<terminal_context>",
              "- Terminal 1 lines 1-1:",
              "  1 | bun test",
              "</terminal_context>",
            ].join("\n"),
            createdAt: "2026-07-24T12:00:00.000Z",
            streaming: false,
          },
        },
        {
          id: "assistant-row-1",
          kind: "message",
          createdAt: "2026-07-24T12:00:01.000Z",
          message: {
            id: MessageId.make("assistant-1"),
            role: "assistant",
            text: "First status",
            createdAt: "2026-07-24T12:00:01.000Z",
            streaming: false,
          },
        },
        {
          id: "assistant-row-2",
          kind: "message",
          createdAt: "2026-07-24T12:00:02.000Z",
          message: {
            id: MessageId.make("assistant-2"),
            role: "assistant",
            text: "  Final   response  ",
            createdAt: "2026-07-24T12:00:02.000Z",
            streaming: false,
          },
        },
        {
          id: "user-row-2",
          kind: "message",
          createdAt: "2026-07-24T12:00:03.000Z",
          message: {
            id: MessageId.make("user-2"),
            role: "user",
            text: "Next request",
            createdAt: "2026-07-24T12:00:03.000Z",
            streaming: false,
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(deriveTimelineMinimapItems(rows)).toEqual([
      {
        id: "user-row-1",
        rowIndex: 0,
        userText: "Investigate the failure",
        assistantText: "Final response",
      },
      {
        id: "user-row-2",
        rowIndex: 3,
        userText: "Next request",
        assistantText: null,
      },
    ]);
  });
});

describe("isTimelineScrolledToEnd", () => {
  it("counts a transcript that cannot scroll as being at the end", () => {
    expect(isTimelineScrolledToEnd({ scrollTop: 0, scrollHeight: 400, clientHeight: 800 })).toBe(
      true,
    );
    expect(isTimelineScrolledToEnd({ scrollTop: 0, scrollHeight: 800, clientHeight: 800 })).toBe(
      true,
    );
  });

  it("tolerates sub-pixel content overflow", () => {
    expect(isTimelineScrolledToEnd({ scrollTop: 0, scrollHeight: 800.6, clientHeight: 800 })).toBe(
      true,
    );
  });

  it("reports away-from-end once the user scrolls past the pin threshold", () => {
    // 800px viewport pins within 80px of the bottom.
    expect(
      isTimelineScrolledToEnd({ scrollTop: 1100, scrollHeight: 2000, clientHeight: 800 }),
    ).toBe(false);
    expect(
      isTimelineScrolledToEnd({ scrollTop: 1121, scrollHeight: 2000, clientHeight: 800 }),
    ).toBe(true);
  });

  it("treats a scrolled-to-bottom transcript as being at the end", () => {
    expect(
      isTimelineScrolledToEnd({ scrollTop: 1200, scrollHeight: 2000, clientHeight: 800 }),
    ).toBe(true);
  });

  it("stays at the end for an unmeasured or non-finite viewport", () => {
    expect(isTimelineScrolledToEnd({ scrollTop: 0, scrollHeight: 2000, clientHeight: 0 })).toBe(
      true,
    );
    expect(
      isTimelineScrolledToEnd({ scrollTop: Number.NaN, scrollHeight: 2000, clientHeight: 800 }),
    ).toBe(true);
  });
});

describe("isErroredWorkEntry", () => {
  it("returns true when tone is error", () => {
    expect(isErroredWorkEntry(makeWorkEntry({ tone: "error" }))).toBe(true);
  });

  it("returns true when exitCode is non-zero", () => {
    expect(isErroredWorkEntry(makeWorkEntry({ tone: "tool", exitCode: 1 }))).toBe(true);
  });

  it("returns false when tone is non-error and exitCode is zero", () => {
    expect(isErroredWorkEntry(makeWorkEntry({ tone: "tool", exitCode: 0 }))).toBe(false);
  });

  it("returns false when tone is non-error and exitCode is undefined", () => {
    expect(isErroredWorkEntry(makeWorkEntry({ tone: "tool" }))).toBe(false);
  });
});

describe("computeMessageDurationStart", () => {
  it("returns message createdAt when there is no preceding user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:05Z",
        completedAt: "2026-01-01T00:00:10Z",
      },
    ]);
    expect(result).toEqual(new Map([["a1", "2026-01-01T00:00:05Z"]]));
  });

  it("uses the user message createdAt for the first assistant response", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("uses the previous assistant completedAt for subsequent assistant responses", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:30Z"],
      ]),
    );
  });

  it("does not advance the boundary for a streaming message without completedAt", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:30Z" },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("resets the boundary on a new user message", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
      { id: "u2", role: "user", createdAt: "2026-01-01T00:01:00Z" },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:01:20Z",
        completedAt: "2026-01-01T00:01:20Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["u2", "2026-01-01T00:01:00Z"],
        ["a2", "2026-01-01T00:01:00Z"],
      ]),
    );
  });

  it("handles system messages without affecting the boundary", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "s1", role: "system", createdAt: "2026-01-01T00:00:01Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["s1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("returns empty map for empty input", () => {
    expect(computeMessageDurationStart([])).toEqual(new Map());
  });
});

describe("normalizeCompactToolLabel", () => {
  it("removes trailing completion wording from command labels", () => {
    expect(normalizeCompactToolLabel("Ran command complete")).toBe("Ran command");
  });

  it("removes trailing completion wording from other labels", () => {
    expect(normalizeCompactToolLabel("Read file completed")).toBe("Read file");
  });
});

describe("resolveAssistantMessageCopyState", () => {
  it("returns enabled copy state for completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Ship it",
        streaming: false,
      }),
    ).toEqual({
      text: "Ship it",
      visible: true,
    });
  });

  it("hides copy while an assistant message is still streaming", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Still streaming",
        streaming: true,
      }),
    ).toEqual({
      text: "Still streaming",
      visible: false,
    });
  });

  it("hides copy for empty completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "   ",
        streaming: false,
      }),
    ).toEqual({
      text: null,
      visible: false,
    });
  });

  it("hides copy for non-terminal assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: false,
        text: "Interim thought",
        streaming: false,
      }),
    ).toEqual({
      text: "Interim thought",
      visible: false,
    });
  });
});

describe("deriveMessagesTimelineRows", () => {
  it("only enables assistant copy for the terminal assistant message in a turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-1-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Write a poem",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "I should ground this first.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            completedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Here is the poem.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            completedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      turnFoldExpandedById: { "turn-fold:settled:turn-1": true },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows).toHaveLength(2);
    expect(assistantRows[0]?.showAssistantCopyButton).toBe(false);
    expect(assistantRows[1]?.showAssistantCopyButton).toBe(true);
  });

  it("starts a running turn expanded and replaces the standalone working row", () => {
    const turnId = TurnId.make("turn-1");
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Inspect it",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:05Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "Looking through the timeline.",
            turnId,
            createdAt: "2026-01-01T00:00:05Z",
            streaming: true,
          },
        },
        {
          id: "work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:07Z",
          entry: makeWorkEntry({ id: "work-1", turnId }),
        },
      ],
      latestTurn: {
        turnId,
        state: "running",
        startedAt: "2026-01-01T00:00:01Z",
        completedAt: null,
      },
      runningTurnId: turnId,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:01Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["message", "turn-fold", "message", "work"]);
    expect(rows[1]).toEqual(
      expect.objectContaining({
        kind: "turn-fold",
        foldId: "turn-fold:running:turn-1",
        status: "running",
        durationStart: "2026-01-01T00:00:01Z",
        expanded: true,
      }),
    );
    expect(rows.some((row) => row.kind === "working")).toBe(false);
  });

  it("keeps a user-collapsed running turn closed as new activity arrives", () => {
    const turnId = TurnId.make("turn-1");
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:05Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "Looking.",
            turnId,
            createdAt: "2026-01-01T00:00:05Z",
            streaming: true,
          },
        },
        {
          id: "new-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:08Z",
          entry: makeWorkEntry({ id: "work-new", turnId }),
        },
      ],
      latestTurn: {
        turnId,
        state: "running",
        startedAt: "2026-01-01T00:00:01Z",
        completedAt: null,
      },
      runningTurnId: turnId,
      turnFoldExpandedById: { "turn-fold:running:turn-1": false },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:01Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows).toEqual([
      expect.objectContaining({
        kind: "turn-fold",
        foldId: "turn-fold:running:turn-1",
        expanded: false,
      }),
    ]);
  });

  it("automatically collapses a settled turn and leaves its final response visible", () => {
    const turnId = TurnId.make("turn-1");
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Build it",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:05Z",
          message: {
            id: "assistant-commentary" as never,
            role: "assistant",
            text: "Checking.",
            turnId,
            createdAt: "2026-01-01T00:00:05Z",
            completedAt: "2026-01-01T00:00:06Z",
            streaming: false,
          },
        },
        {
          id: "work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:10Z",
          entry: makeWorkEntry({ id: "work-1", turnId }),
        },
        {
          id: "final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:39Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Done",
            turnId,
            createdAt: "2026-01-01T00:00:39Z",
            completedAt: "2026-01-01T00:00:40Z",
            streaming: false,
          },
        },
      ],
      latestTurn: {
        turnId,
        state: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:40Z",
      },
      runningTurnId: null,
      turnFoldExpandedById: { "turn-fold:running:turn-1": true },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:settled:turn-1",
      "final-entry",
    ]);
    expect(rows[1]).toEqual(
      expect.objectContaining({
        kind: "turn-fold",
        label: "Worked for 40s",
        expanded: false,
      }),
    );
  });

  it("shows one summary and reveals all tool calls only when expanded", () => {
    const timelineEntries = [
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:01Z",
        entry: makeWorkEntry({ id: "work-1", createdAt: "2026-01-01T00:00:01Z" }),
      },
      {
        id: "work-entry-2",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:02Z",
        entry: makeWorkEntry({ id: "work-2", createdAt: "2026-01-01T00:00:02Z" }),
      },
    ];
    const baseInput = {
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    };

    // The disclosure leads the group, so the recap reads as the heading of the
    // run it folds and expanding it reveals the rows directly beneath.
    const collapsed = deriveMessagesTimelineRows(baseInput);
    expect(collapsed.map((row) => row.id)).toEqual(["work-toggle:work-entry-1"]);
    expect(collapsed[0]).toEqual(
      expect.objectContaining({
        kind: "work-toggle",
        hiddenCount: 2,
        onlyToolEntries: true,
        expanded: false,
      }),
    );

    const expanded = deriveMessagesTimelineRows({
      ...baseInput,
      workGroupExpandedById: { "work-group:work-entry-1": true },
    });
    expect(expanded.map((row) => row.id)).toEqual(["work-toggle:work-entry-1", "work-1", "work-2"]);
  });

  it("keeps the plain count when a folded run hides a failure", () => {
    const timelineEntries = [
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:01Z",
        entry: makeWorkEntry({
          id: "work-1",
          createdAt: "2026-01-01T00:00:01Z",
          command: "bun typecheck",
        }),
      },
      {
        id: "work-entry-2",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:02Z",
        entry: makeWorkEntry({
          id: "work-2",
          createdAt: "2026-01-01T00:00:02Z",
          command: "bun lint",
        }),
      },
      {
        id: "work-entry-3",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:03Z",
        entry: makeWorkEntry({ id: "work-3", createdAt: "2026-01-01T00:00:03Z", tone: "error" }),
      },
      {
        id: "work-entry-4",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:04Z",
        entry: makeWorkEntry({ id: "work-4", createdAt: "2026-01-01T00:00:04Z" }),
      },
    ];

    const rows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    // "Ran 2 commands" would account for only the two tool rows and quietly
    // conceal the failed one until the group was expanded.
    const toggle = rows.find((row) => row.kind === "work-toggle");
    expect(toggle?.kind === "work-toggle" ? toggle.summary : undefined).toBeNull();
  });

  it("recaps a folded run of tool calls by category", () => {
    const timelineEntries = [
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:01Z",
        entry: makeWorkEntry({
          id: "work-1",
          createdAt: "2026-01-01T00:00:01Z",
          command: "bun typecheck",
        }),
      },
      {
        id: "work-entry-2",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:02Z",
        entry: makeWorkEntry({
          id: "work-2",
          createdAt: "2026-01-01T00:00:02Z",
          command: "cat src/app.ts",
        }),
      },
      {
        id: "work-entry-3",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:03Z",
        entry: makeWorkEntry({ id: "work-3", createdAt: "2026-01-01T00:00:03Z" }),
      },
    ];

    const rows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const toggle = rows.find((row) => row.kind === "work-toggle");
    expect(toggle?.kind === "work-toggle" ? toggle.summary?.label : null).toBe(
      "Ran 1 command, Read 1 file, 1 other tool call",
    );
  });

  it("uses authoritative timing and a stopped label for an interrupted turn", () => {
    const turnId = TurnId.make("turn-interrupted");
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: makeWorkEntry({ id: "work-1", turnId }),
        },
      ],
      latestTurn: {
        turnId,
        state: "interrupted",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:47Z",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows).toEqual([
      expect.objectContaining({
        kind: "turn-fold",
        label: "You stopped after 47s",
        expanded: false,
      }),
    ]);
  });

  it("keeps the previous turn settled while a newly sent message awaits its turn id", () => {
    const previousTurnId = TurnId.make("turn-previous");
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "previous-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: makeWorkEntry({ id: "work-previous", turnId: previousTurnId }),
        },
        {
          id: "new-user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:00Z",
          message: {
            id: "user-new" as never,
            role: "user",
            text: "Do the next thing",
            turnId: null,
            createdAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
      ],
      latestTurn: {
        turnId: previousTurnId,
        state: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:10Z",
      },
      runningTurnId: null,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["turn-fold", "message", "working"]);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        foldId: "turn-fold:settled:turn-previous",
        expanded: false,
      }),
    );
  });

  it("projects assistant diff summaries and user revert counts onto the affected rows", () => {
    const assistantTurnDiffSummary = {
      turnId: "turn-1" as never,
      completedAt: "2026-01-01T00:00:30Z",
      assistantMessageId: "assistant-1" as never,
      checkpointTurnCount: 2,
      files: [{ path: "src/index.ts", additions: 3, deletions: 1 }],
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Do the thing",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "Done",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            completedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map([
        ["assistant-1" as never, assistantTurnDiffSummary],
      ]),
      revertTurnCountByUserMessageId: new Map([["user-1" as never, 1]]),
    });

    const userRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "user",
    );
    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(userRow?.revertTurnCount).toBe(1);
    expect(assistantRow?.assistantTurnDiffSummary).toBe(assistantTurnDiffSummary);
  });

  it("keeps context handoffs as dedicated rows outside work groups and turn folds", () => {
    const marker = makeContextHandoffMarker();
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-before",
          kind: "work",
          createdAt: "2026-01-01T00:00:01Z",
          entry: makeWorkEntry({ id: "work-before", createdAt: "2026-01-01T00:00:01Z" }),
        },
        {
          id: marker.id,
          kind: "context-handoff",
          createdAt: marker.createdAt,
          marker,
        },
        {
          id: "work-after",
          kind: "work",
          createdAt: "2026-01-01T00:00:03Z",
          entry: makeWorkEntry({ id: "work-after", createdAt: "2026-01-01T00:00:03Z" }),
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["work", "context-handoff", "work"]);
    expect(rows[1]).toEqual({
      kind: "context-handoff",
      id: marker.id,
      createdAt: marker.createdAt,
      marker,
    });
    expect(deriveTimelineMinimapItems(rows)).toEqual([]);
  });
});

describe("deriveUndoTurnCountByTurnId", () => {
  const summary = (
    turnId: string,
    overrides: Partial<Record<keyof TurnDiffSummary, unknown>> = {},
  ): TurnDiffSummary =>
    ({
      turnId: TurnId.make(turnId),
      completedAt: "2026-01-01T00:00:10Z",
      files: [{ path: "src/app.ts", additions: 2, deletions: 1 }],
      checkpointRef: "checkpoint-abc",
      checkpointTurnCount: 3,
      ...overrides,
    }) as TurnDiffSummary;

  it("targets the turn before the one being undone", () => {
    const result = deriveUndoTurnCountByTurnId({
      turnDiffSummaries: [summary("turn-1")],
      inferredCheckpointTurnCountByTurnId: {},
    });
    expect(result.get(TurnId.make("turn-1"))).toBe(2);
  });

  it("falls back to the inferred checkpoint count", () => {
    const result = deriveUndoTurnCountByTurnId({
      turnDiffSummaries: [summary("turn-1", { checkpointTurnCount: undefined })],
      inferredCheckpointTurnCountByTurnId: { [TurnId.make("turn-1")]: 5 },
    });
    expect(result.get(TurnId.make("turn-1"))).toBe(4);
  });

  it("skips turns with nothing restorable", () => {
    const result = deriveUndoTurnCountByTurnId({
      turnDiffSummaries: [
        summary("missing", { status: "missing" }),
        summary("errored", { status: "error" }),
        // A reported provider diff is not a checkpoint we can roll back to.
        summary("provider", { checkpointRef: "provider-diff:xyz" }),
        summary("uncaptured", { checkpointRef: undefined }),
        summary("empty", { files: [] }),
        summary("no-count", { checkpointTurnCount: undefined }),
      ],
      inferredCheckpointTurnCountByTurnId: {},
    });
    expect(result.size).toBe(0);
  });
});

describe("deriveRevertTurnCountByUserMessageId", () => {
  it("projects the first assistant diff summary after each user message", () => {
    const result = deriveRevertTurnCountByUserMessageId({
      timelineEntries: [
        {
          id: "user-1-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Do the first thing",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "work-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: makeWorkEntry({ id: "work-1", createdAt: "2026-01-01T00:00:05Z" }),
        },
        {
          id: "assistant-1-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "Done",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            streaming: false,
          },
        },
        {
          id: "user-2-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "user-2" as never,
            role: "user",
            text: "Do the second thing",
            turnId: null,
            createdAt: "2026-01-01T00:00:20Z",
            streaming: false,
          },
        },
        {
          id: "assistant-2-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:30Z",
          message: {
            id: "assistant-2" as never,
            role: "assistant",
            text: "Done again",
            turnId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      turnDiffSummaryByAssistantMessageId: new Map([
        [
          "assistant-1" as never,
          {
            turnId: "turn-1" as never,
            completedAt: "2026-01-01T00:00:11Z",
            checkpointTurnCount: 3,
            files: [],
          },
        ],
        [
          "assistant-2" as never,
          {
            turnId: "turn-2" as never,
            completedAt: "2026-01-01T00:00:31Z",
            files: [],
          },
        ],
      ]),
      inferredCheckpointTurnCountByTurnId: {},
    });

    expect(result).toEqual(new Map([["user-1" as never, 2]]));
  });
});

describe("computeStableMessagesTimelineRows", () => {
  it("preserves a context handoff row while its marker identity is unchanged", () => {
    const marker = makeContextHandoffMarker();
    const row = {
      kind: "context-handoff" as const,
      id: marker.id,
      createdAt: marker.createdAt,
      marker,
    };
    const initial = computeStableMessagesTimelineRows([row], { byId: new Map(), result: [] });
    const stable = computeStableMessagesTimelineRows([{ ...row }], initial);

    expect(stable).toBe(initial);
    expect(stable.result[0]).toBe(initial.result[0]);
  });

  it("returns the previous result when row order and content are unchanged", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
      createdAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const initial = computeStableMessagesTimelineRows(rows, {
      byId: new Map(),
      result: [],
    });

    const repeated = computeStableMessagesTimelineRows(rows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result).toBe(initial.result);
  });

  it("returns a new result when row order changes without content changes", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
      createdAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const firstRows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });

    const reordered = computeStableMessagesTimelineRows([firstRows[1]!, firstRows[0]!], initial);

    expect(reordered).not.toBe(initial);
    expect(reordered.result).toEqual([initial.result[1], initial.result[0]]);
  });

  it("preserves unchanged grouped work rows when grouping arrays are rebuilt", () => {
    const firstWorkEntry = makeWorkEntry({
      id: "work-1",
      createdAt: "2026-01-01T00:00:00Z",
      label: "Read file",
      detail: "src/index.ts",
      changedFiles: ["src/index.ts"],
      changedFileStats: [{ path: "src/index.ts", additions: 4, deletions: 1 }],
    });
    const secondWorkEntry = makeWorkEntry({
      id: "work-2",
      createdAt: "2026-01-01T00:00:01Z",
      label: "Ran command",
      command: "bun lint",
      exitCode: 0,
    });
    const timelineEntries = [
      {
        id: "work-1",
        kind: "work" as const,
        createdAt: firstWorkEntry.createdAt,
        entry: firstWorkEntry,
      },
      {
        id: "work-2",
        kind: "work" as const,
        createdAt: secondWorkEntry.createdAt,
        entry: secondWorkEntry,
      },
    ];
    const firstRows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });
    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });
    const nextRows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          ...timelineEntries[0]!,
          entry: {
            ...firstWorkEntry,
            changedFiles: [...(firstWorkEntry.changedFiles ?? [])],
            changedFileStats: [...(firstWorkEntry.changedFileStats ?? [])],
          },
        },
        {
          ...timelineEntries[1]!,
          entry: { ...secondWorkEntry },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const stable = computeStableMessagesTimelineRows(nextRows, initial);

    expect(stable).toBe(initial);
    expect(stable.result[0]).toBe(initial.result[0]);
  });

  it("preserves unchanged message rows when equal message objects are recreated", () => {
    const initialUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "Start",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      streaming: false,
      attachments: [
        {
          type: "image" as const,
          id: "attachment-1",
          name: "screen.png",
          mimeType: "image/png",
          sizeBytes: 42,
          previewUrl: "blob:screen",
        },
      ],
    };
    const initialAssistantMessage = {
      id: "assistant-1" as never,
      role: "assistant" as const,
      text: "Working",
      turnId: "turn-1" as never,
      createdAt: "2026-01-01T00:00:01Z",
      streaming: true,
    };
    const firstRows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-1-entry",
          kind: "message",
          createdAt: initialUserMessage.createdAt,
          message: initialUserMessage,
        },
        {
          id: "assistant-1-entry",
          kind: "message",
          createdAt: initialAssistantMessage.createdAt,
          message: initialAssistantMessage,
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });
    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });

    const nextRows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-1-entry",
          kind: "message",
          createdAt: initialUserMessage.createdAt,
          message: {
            ...initialUserMessage,
            attachments: initialUserMessage.attachments.map((attachment) => ({
              type: attachment.type,
              id: attachment.id,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
              previewUrl: attachment.previewUrl,
            })),
          },
        },
        {
          id: "assistant-1-entry",
          kind: "message",
          createdAt: initialAssistantMessage.createdAt,
          message: { ...initialAssistantMessage, text: "Working." },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const stable = computeStableMessagesTimelineRows(nextRows, initial);

    expect(stable.result[0]).toBe(initial.result[0]);
    expect(stable.result[1]).not.toBe(initial.result[1]);
  });
});

describe("timeline context split", () => {
  const STREAMING_KEYS = [
    "activeTurnInProgress",
    "activeTurnId",
    "isWorking",
    "isRevertingCheckpoint",
    "openDiffTurnId",
    "agentPanelModel",
  ];
  const STABLE_KEYS = [
    "timestampFormat",
    "routeThreadKey",
    "markdownCwd",
    "resolvedTheme",
    "workspaceRoot",
    "skills",
    "activeThreadEnvironmentId",
    "highlightedMessageId",
    "threadMessageSearchQuery",
    "threadMessageSearchOccurrencesByMessageId",
    "activeThreadMessageSearchOccurrence",
    "onRevertUserMessage",
    "onUndoTurn",
    "onImageExpand",
    "onOpenTurnDiff",
    "onCloseDiff",
    "onOpenAgents",
    "onOpenMessageActions",
  ];

  function makeCombinedInput(): TimelineStreamingState & TimelineStableState {
    return {
      activeTurnInProgress: true,
      activeTurnId: TurnId.make("turn-1"),
      isWorking: true,
      isRevertingCheckpoint: false,
      openDiffTurnId: null,
      agentPanelModel: emptyAgentPanelModel(),
      timestampFormat: "locale",
      routeThreadKey: "environment-local:thread-1",
      markdownCwd: "/repo",
      resolvedTheme: "light",
      workspaceRoot: "/repo",
      skills: [],
      activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
      highlightedMessageId: null,
      threadMessageSearchQuery: "",
      threadMessageSearchOccurrencesByMessageId: new Map(),
      activeThreadMessageSearchOccurrence: null,
      onRevertUserMessage: () => {},
      onUndoTurn: () => {},
      onImageExpand: () => {},
      onOpenTurnDiff: () => {},
      onCloseDiff: () => {},
      onOpenAgents: () => {},
      onOpenMessageActions: () => {},
    };
  }

  it("copies only the streaming-frequent fields into the streaming context", () => {
    const result = buildTimelineStreamingState(makeCombinedInput());
    expect(Object.keys(result).toSorted()).toEqual(STREAMING_KEYS.toSorted());
  });

  it("copies only the stable fields into the stable context", () => {
    const result = buildTimelineStableState(makeCombinedInput());
    expect(Object.keys(result).toSorted()).toEqual(STABLE_KEYS.toSorted());
  });

  it("partitions every shared field into exactly one context", () => {
    const overlap = STREAMING_KEYS.filter((key) => STABLE_KEYS.includes(key));
    expect(overlap).toEqual([]);
    expect([...STREAMING_KEYS, ...STABLE_KEYS].toSorted()).toEqual(
      Object.keys(makeCombinedInput()).toSorted(),
    );
  });

  it("preserves field values and callback identity", () => {
    const input = makeCombinedInput();
    const streaming = buildTimelineStreamingState(input);
    const stable = buildTimelineStableState(input);

    expect(streaming.isWorking).toBe(true);
    expect(stable.routeThreadKey).toBe("environment-local:thread-1");
    expect(stable.onCloseDiff).toBe(input.onCloseDiff);
  });
});
