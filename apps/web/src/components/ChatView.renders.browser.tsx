// Render cost of a streamed reply in the full chat route. Only the message
// leaf that shows the growing text may follow the stream; the chat view, its
// route parent, the header and the timeline owner re-render on structural
// changes only (a new row, the stream ending).
import "../index.css";

import {
  EventId,
  type MessageId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type TurnId,
} from "@ryco/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { isMacPlatform } from "../lib/utils";
import { useStore } from "../store";
import {
  COMPOSER_STASH_KEYBINDING,
  DEFAULT_VIEWPORT,
  LOCAL_ENVIRONMENT_ID,
  NOW_ISO,
  THREAD_ID,
  createShortTranscriptSnapshot,
  mountChatView,
  nextFrame,
  setupChatViewBrowserSuite,
  waitForLayout,
} from "./ChatView.browser.helpers";

// Hoisted per suite: a mock registered from the shared helpers runs after this file's static imports.
vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

// Every instrumented component calls `usePerfMark(label)` once per render.
const renderCounts = vi.hoisted(() => new Map<string, number>());
vi.mock("../perf/tabSwitchInstrumentation", async (original) => {
  const actual = await original<typeof import("../perf/tabSwitchInstrumentation")>();
  return {
    ...actual,
    usePerfMark: (label: string) => {
      renderCounts.set(label, (renderCounts.get(label) ?? 0) + 1);
    },
  };
});

type SnapshotThread = OrchestrationReadModel["threads"][number];

const TURN_ID = "turn-streamed-reply" as TurnId;
const STREAM_MESSAGE_ID = "msg-assistant-streamed-reply" as MessageId;
const TURN_STARTED_MS = Date.parse(NOW_ISO) + 60_000;
const STREAM_STARTED_AT = new Date(TURN_STARTED_MS + 1_000).toISOString();
const COUNTED_LABELS = [
  "ChatView",
  "ChatThreadRouteView",
  "MessagesTimeline",
  "ChatHeader",
  "ChatMarkdown",
] as const;
/**
 * Renders one structural change (a new row, the end of a stream) may cost. A
 * structural commit is followed today by one nested commit, while the
 * transcript list lays the change out, that renders the chat view once more;
 * so the budget is two. One render per streamed delta would blow it at once.
 */
const RENDERS_PER_STRUCTURAL_CHANGE = 2;

/**
 * The fixture thread in the middle of a running turn. The turn already names
 * the reply it streams, as the shell lists it once the reply starts, so a
 * shell upsert during the stream differs from the stored thread only in its
 * `updatedAt` (the server re-reads the thread row after every event).
 */
function createStreamingSnapshot(options: { withToolStep?: boolean } = {}): OrchestrationReadModel {
  const snapshot = createShortTranscriptSnapshot();
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id !== THREAD_ID
        ? thread
        : {
            ...thread,
            latestTurn: {
              turnId: TURN_ID,
              state: "running",
              requestedAt: new Date(TURN_STARTED_MS).toISOString(),
              startedAt: new Date(TURN_STARTED_MS).toISOString(),
              completedAt: null,
              assistantMessageId: STREAM_MESSAGE_ID,
            },
            session: { ...thread.session!, status: "running", activeTurnId: TURN_ID },
            activities: options.withToolStep
              ? [
                  {
                    id: EventId.make("activity-streamed-reply-tool"),
                    tone: "tool",
                    kind: "tool.completed",
                    summary: "Ran command",
                    payload: {
                      itemType: "command_execution",
                      status: "completed",
                      title: "Ran command",
                      detail: "bun run typecheck",
                    },
                    turnId: TURN_ID,
                    createdAt: new Date(TURN_STARTED_MS + 500).toISOString(),
                  },
                ]
              : [],
          },
    ),
  } as OrchestrationReadModel;
}

let nextSequence = 1_000;

function occurredAt(index: number): string {
  return new Date(TURN_STARTED_MS + 1_000 + index * 32).toISOString();
}

/** One `thread.message-sent` delta of the streamed reply, applied as the detail stream does. */
function applyReplyDelta(
  index: number,
  text: string,
  streaming = true,
  messageId: MessageId = STREAM_MESSAGE_ID,
): void {
  nextSequence += 1;
  const at = occurredAt(index);
  useStore.getState().applyOrchestrationEvents(
    [
      {
        sequence: nextSequence,
        eventId: EventId.make(`streamed-reply-${nextSequence}`),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: at,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: THREAD_ID,
          messageId,
          role: "assistant",
          text,
          turnId: TURN_ID,
          streaming,
          createdAt: STREAM_STARTED_AT,
          updatedAt: at,
        },
      } as unknown as OrchestrationEvent,
    ],
    LOCAL_ENVIRONMENT_ID,
  );
}

/**
 * The shell stream's re-read of the thread row: the same thread with the
 * row's newer `updatedAt`, which need not match the detail event's time.
 */
function applyShellUpsert(thread: SnapshotThread, index: number): void {
  nextSequence += 1;
  useStore.getState().applyShellEvents(
    [
      {
        kind: "thread-upserted",
        sequence: nextSequence,
        thread: {
          id: thread.id,
          projectId: thread.projectId,
          title: thread.title,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          latestTurn: thread.latestTurn,
          createdAt: thread.createdAt,
          updatedAt: new Date(Date.parse(occurredAt(index)) + 7).toISOString(),
          archivedAt: thread.archivedAt,
          settledOverride: thread.settledOverride,
          settledAt: thread.settledAt,
          session: thread.session,
          latestUserMessageAt:
            thread.messages.findLast((message) => message.role === "user")?.createdAt ?? null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        },
      } as unknown as Parameters<ReturnType<typeof useStore.getState>["applyShellEvents"]>[0][0],
    ],
    LOCAL_ENVIRONMENT_ID,
  );
}

function readRenderCounts(): Record<(typeof COUNTED_LABELS)[number], number> {
  return Object.fromEntries(
    COUNTED_LABELS.map((label) => [label, renderCounts.get(label) ?? 0]),
  ) as Record<(typeof COUNTED_LABELS)[number], number>;
}

function rendersSince(
  baseline: Record<(typeof COUNTED_LABELS)[number], number>,
): Record<(typeof COUNTED_LABELS)[number], number> {
  const current = readRenderCounts();
  return Object.fromEntries(
    COUNTED_LABELS.map((label) => [label, current[label] - baseline[label]]),
  ) as Record<(typeof COUNTED_LABELS)[number], number>;
}

/** Mount-time work (row measurement, motion gates, idle preloads) settles before counting. */
async function waitForQuiescence(): Promise<void> {
  let last = -1;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    const current = COUNTED_LABELS.reduce((sum, label) => sum + (renderCounts.get(label) ?? 0), 0);
    if (current === last) return;
    last = current;
  }
  throw new Error("The chat view never stopped rendering.");
}

function expectStructuralRendersOnly(
  renders: Record<(typeof COUNTED_LABELS)[number], number>,
  structuralChanges: number,
): void {
  const summary = JSON.stringify(renders);
  const budget = structuralChanges * RENDERS_PER_STRUCTURAL_CHANGE;
  expect(renders.ChatView, summary).toBeLessThanOrEqual(budget);
  expect(renders.ChatThreadRouteView, summary).toBeLessThanOrEqual(budget);
  expect(renders.MessagesTimeline, summary).toBeLessThanOrEqual(budget);
  expect(renders.ChatHeader, summary).toBeLessThanOrEqual(budget);
}

function snapshotThread(snapshot: OrchestrationReadModel): SnapshotThread {
  return snapshot.threads.find((thread) => thread.id === THREAD_ID)!;
}

function transcriptText(): string {
  return document.body.textContent ?? "";
}

describe("ChatView render cost while a reply streams", () => {
  setupChatViewBrowserSuite();

  afterEach(() => {
    renderCounts.clear();
  });

  it("streams a reply through the message leaf without re-rendering the chat view", async () => {
    const snapshot = createStreamingSnapshot();
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      await waitForQuiescence();
      const baseline = readRenderCounts();

      for (let index = 0; index < 40; index += 1) {
        applyReplyDelta(index, `chunk-${index} lorem ipsum. `);
        // The shell stream re-reads the thread row at most every 250 ms.
        if (index % 8 === 7) applyShellUpsert(snapshotThread(snapshot), index);
        await nextFrame();
        if (index === 20) {
          // The leaf follows the live text while the chat view holds the structure.
          await vi.waitFor(() => expect(transcriptText()).toContain("chunk-20 lorem ipsum."));
        }
      }
      applyReplyDelta(40, "", false);
      await waitForLayout();
      await vi.waitFor(() => expect(transcriptText()).toContain("chunk-39 lorem ipsum."));

      const renders = rendersSince(baseline);
      // The first chunk adds the reply's row; the last event ends its stream.
      expectStructuralRendersOnly(renders, 2);
      // The leaf did follow the stream.
      expect(renders.ChatMarkdown, JSON.stringify(renders)).toBeGreaterThanOrEqual(10);
    } finally {
      await mounted.cleanup();
    }
  });

  it("releases paragraphs without re-rendering the chat view", async () => {
    const snapshot = createStreamingSnapshot();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
      // Paragraph delivery (the default): whole blocks, no smoothing.
      configureFixture: (fixture) => {
        fixture.serverConfig = {
          ...fixture.serverConfig,
          environment: {
            ...fixture.serverConfig.environment,
            capabilities: {
              ...fixture.serverConfig.environment.capabilities,
              responseStreamingModes: true,
            },
          },
          settings: { ...fixture.serverConfig.settings, responseStreamingMode: "paragraph" },
        };
      },
    });
    try {
      await waitForQuiescence();
      const baseline = readRenderCounts();

      for (let index = 0; index < 5; index += 1) {
        applyReplyDelta(
          index,
          `Paragraph ${index} first line.\nParagraph ${index} second line.\n\n`,
        );
        applyShellUpsert(snapshotThread(snapshot), index);
        await waitForLayout();
      }
      await vi.waitFor(() => expect(transcriptText()).toContain("Paragraph 4 second line."));
      applyReplyDelta(5, "", false);
      await waitForLayout();

      const renders = rendersSince(baseline);
      expectStructuralRendersOnly(renders, 2);
      expect(renders.ChatMarkdown, JSON.stringify(renders)).toBeGreaterThanOrEqual(5);
    } finally {
      await mounted.cleanup();
    }
  });

  it("streams a live chapter's paragraph through the same leaf", async () => {
    const snapshot = createStreamingSnapshot({ withToolStep: true });
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    try {
      await expect.element(page.getByText("bun run typecheck").first()).toBeInTheDocument();
      await waitForQuiescence();
      const baseline = readRenderCounts();

      for (let index = 0; index < 24; index += 1) {
        applyReplyDelta(index, `step-${index} dolor sit. `);
        if (index % 8 === 7) applyShellUpsert(snapshotThread(snapshot), index);
        await nextFrame();
      }
      await vi.waitFor(() =>
        expect(
          document.querySelector('section[data-chapter-status="active"]')?.textContent ?? "",
        ).toContain("step-23 dolor sit."),
      );

      const renders = rendersSince(baseline);
      // No stream end yet: the first chunk is the only structural change.
      expectStructuralRendersOnly(renders, 1);
      expect(renders.ChatMarkdown, JSON.stringify(renders)).toBeGreaterThanOrEqual(10);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a folded chapter's title live while its paragraph still streams", async () => {
    const snapshot = createStreamingSnapshot({ withToolStep: true });
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    const nextParagraphId = "msg-assistant-next-paragraph" as MessageId;
    const foldedTitle = () =>
      document.querySelector(
        `section[data-message-id="${STREAM_MESSAGE_ID}"][data-chapter-open="false"]`,
      )?.textContent ?? "";
    try {
      await expect.element(page.getByText("bun run typecheck").first()).toBeInTheDocument();
      await waitForQuiescence();

      applyReplyDelta(0, "Planning the change");
      await nextFrame();
      // A newer paragraph opens the next chapter, which folds this one.
      applyReplyDelta(1, "Next paragraph.", true, nextParagraphId);
      await vi.waitFor(() => expect(foldedTitle()).toContain("Planning the change"));
      // The folded paragraph streams on. Its first delta names it the turn's
      // reply again (structure); the next one changes only text, so the chat
      // view holds and only the title's own read can follow it.
      applyReplyDelta(2, " carefully");
      await vi.waitFor(() => expect(foldedTitle()).toContain("Planning the change carefully"));
      applyReplyDelta(3, " and slowly");
      await vi.waitFor(() =>
        expect(foldedTitle()).toContain("Planning the change carefully and slowly"),
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("follows streamed text in thread search while the bar is open", async () => {
    const snapshot = createStreamingSnapshot();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
      configureFixture: (fixture) => {
        fixture.serverConfig = {
          ...fixture.serverConfig,
          keybindings: [
            {
              ...COMPOSER_STASH_KEYBINDING,
              command: "thread.find",
              shortcut: { ...COMPOSER_STASH_KEYBINDING.shortcut, key: "f" },
            },
          ],
        };
      },
    });
    try {
      await waitForQuiescence();
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "f",
          code: "KeyF",
          metaKey: isMacPlatform(navigator.platform),
          ctrlKey: !isMacPlatform(navigator.platform),
          bubbles: true,
          cancelable: true,
        }),
      );
      const input = page.getByLabelText("Find in thread");
      await expect.element(input).toBeVisible();
      await userEvent.fill(input, "zebra");
      await expect.element(page.getByText("No results")).toBeVisible();

      for (let index = 0; index < 34; index += 1) {
        applyReplyDelta(index, index === 30 ? "a zebra crossing. " : `chunk-${index} lorem. `);
        await nextFrame();
      }
      // The match is counted while the reply still streams.
      await expect.element(page.getByText("1 / 1")).toBeVisible();
      applyReplyDelta(34, "", false);
      await waitForLayout();
      await expect.element(page.getByText("1 / 1")).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });
});
