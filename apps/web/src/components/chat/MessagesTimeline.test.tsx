import {
  ContextHandoffId,
  EnvironmentId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  TurnId,
} from "@ryco/contracts";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { LegendListRef } from "@legendapp/list/react";
import type { ContextHandoffTimelineEntry } from "../../session-logic";

vi.mock("@legendapp/list/react", async () => {
  const React = await import("react");

  const LegendList = React.forwardRef(function MockLegendList(
    props: {
      data: Array<{ id: string }>;
      keyExtractor: (item: { id: string }) => string;
      renderItem: (args: { item: { id: string } }) => React.ReactNode;
      ListHeaderComponent?: React.ReactNode;
      ListFooterComponent?: React.ReactNode;
    },
    _ref: React.ForwardedRef<LegendListRef>,
  ) {
    return (
      <div data-testid="legend-list">
        {props.ListHeaderComponent}
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  });

  return { LegendList };
});

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

beforeAll(() => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
});

const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-local");

function makeContextHandoffMarker(
  overrides: Partial<ContextHandoffTimelineEntry> = {},
): ContextHandoffTimelineEntry {
  return {
    id: "context-handoff:activity-1",
    activityId: "activity-1",
    handoffId: ContextHandoffId.make("handoff-1"),
    createdAt: "2026-03-17T19:12:28.000Z",
    turnId: TurnId.make("turn-target"),
    status: "consumed",
    targetMessageId: MessageId.make("message-target"),
    targetTurnId: TurnId.make("turn-target"),
    sources: [
      {
        providerInstanceId: ProviderInstanceId.make("codex_work"),
        driverKind: ProviderDriverKind.make("codex"),
        providerDisplayName: "Codex Work",
        providerAccentColor: "#4f46e5",
        modelSlug: "gpt-5.6-sol",
        modelDisplayName: "GPT-5.6 Sol",
      },
    ],
    target: {
      providerInstanceId: ProviderInstanceId.make("claude_work"),
      driverKind: ProviderDriverKind.make("claudeAgent"),
      providerDisplayName: "Claude Work",
      modelSlug: "claude-fable-5",
      modelDisplayName: "Fable 5",
    },
    ...overrides,
  };
}

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnId: null,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    turnDiffSummaryByAssistantMessageId: new Map(),
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    onUndoTurn: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    onIsAtEndChange: () => {},
  };
}

describe("MessagesTimeline", () => {
  it("renders the desktop minimap only after a second user message is present", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const firstUserEntry = {
      id: "user-row-1",
      kind: "message" as const,
      createdAt: "2026-07-24T12:00:00.000Z",
      message: {
        id: MessageId.make("user-1"),
        role: "user" as const,
        text: "First request",
        createdAt: "2026-07-24T12:00:00.000Z",
        streaming: false,
      },
    };
    const secondUserEntry = {
      id: "user-row-2",
      kind: "message" as const,
      createdAt: "2026-07-24T12:00:02.000Z",
      message: {
        id: MessageId.make("user-2"),
        role: "user" as const,
        text: "Second request",
        createdAt: "2026-07-24T12:00:02.000Z",
        streaming: false,
      },
    };

    const singleMessageMarkup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={[firstUserEntry]} />,
    );
    const twoMessageMarkup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={[firstUserEntry, secondUserEntry]} />,
    );

    expect(singleMessageMarkup).not.toContain('data-testid="timeline-minimap"');
    expect(twoMessageMarkup).toContain('data-testid="timeline-minimap"');
    expect(twoMessageMarkup).toContain('aria-label="Jump to message: User message"');
    expect(twoMessageMarkup).toContain("[@media(pointer:fine)]:block");
    expect(twoMessageMarkup.match(/data-minimap-strip=/g)).toHaveLength(2);
  }, 15_000);

  it("renders inline terminal labels with the composer chip UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-2"),
              role: "user",
              text: [
                "yoo what's @terminal-1:1-5 mean",
                "",
                "<terminal_context>",
                "- Terminal 1 lines 1-5:",
                "  1 | julius@mac effect-http-ws-cli % bun i",
                "  2 | bun install v1.3.9 (cf6cdbbb)",
                "</terminal_context>",
              ].join("\n"),
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("yoo what&#x27;s ");
  }, 20_000);

  it("renders context compaction entries as timeline markers", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "context-compaction",
            createdAt: "2026-03-17T19:12:28.000Z",
            marker: {
              id: "context-compaction:work-1",
              activityId: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Context compacted",
              turnId: null,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Context compacted");
    expect(markup).not.toContain("Work log");
  });

  it("renders an accessible persisted context handoff with multiple and unknown providers", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const marker = makeContextHandoffMarker({
      sources: [
        ...makeContextHandoffMarker().sources,
        {
          providerInstanceId: ProviderInstanceId.make("local_provider"),
          driverKind: ProviderDriverKind.make("localProvider"),
          providerDisplayName: "Local Provider",
          modelSlug: "a-very-long-model-slug-for-responsive-overflow-testing",
          modelDisplayName: "A Very Long Local Model Label That Must Truncate Responsively",
        },
      ],
    });
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: marker.id,
            kind: "context-handoff",
            createdAt: marker.createdAt,
            marker,
          },
        ]}
      />,
    );

    expect(markup).toContain('data-timeline-row-kind="context-handoff"');
    expect(markup).toContain('data-context-handoff-status="consumed"');
    expect(markup).toContain('data-context-handoff-source-count="2"');
    expect(markup).toContain("Context handoff from Codex Work GPT-5.6 Sol, Local Provider");
    expect(markup).toContain("to Claude Work Fable 5. Completed");
    expect(markup).toContain("A Very Long Local Model Label That Must Truncate Responsively");
    expect(markup).toContain(">LP<");
    expect(markup).toContain("lucide-arrow-left-right");
    expect(markup).toContain("lucide-arrow-right");
    expect(markup).not.toContain("Work log");
    expect(markup).not.toContain("data-message-id");
    expect(markup).not.toContain('data-testid="timeline-minimap"');
  });

  it("renders failed and delivery-uncertain handoffs with explicit status semantics", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const failed = makeContextHandoffMarker({
      id: "context-handoff:failed",
      handoffId: ContextHandoffId.make("handoff-failed"),
      status: "failed",
      error: "Target runtime could not start",
    });
    const uncertain = makeContextHandoffMarker({
      id: "context-handoff:uncertain",
      handoffId: ContextHandoffId.make("handoff-uncertain"),
      status: "delivery-uncertain",
      error: "Acceptance could not be proven",
    });
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[failed, uncertain].map((marker) => ({
          id: marker.id,
          kind: "context-handoff" as const,
          createdAt: marker.createdAt,
          marker,
        }))}
      />,
    );

    expect(markup).toContain('data-context-handoff-status="failed"');
    expect(markup).toContain('data-context-handoff-status="delivery-uncertain"');
    expect(markup).toContain("Failed: Target runtime could not start");
    expect(markup).toContain("Delivery uncertain: Acceptance could not be proven");
    expect(markup).toContain("lucide-circle-alert");
    expect(markup).toContain("lucide-circle-question-mark");
  });

  it("formats changed file paths from the workspace root", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Updated files",
              tone: "tool",
              changedFiles: ["C:/Users/mike/dev-stuff/ryco/apps/web/src/session-logic.ts"],
            },
          },
        ]}
        workspaceRoot="C:/Users/mike/dev-stuff/ryco"
      />,
    );

    expect(markup).toContain("ryco/apps/web/src/session-logic.ts");
    expect(markup).not.toContain("C:/Users/mike/dev-stuff/ryco/apps/web/src/session-logic.ts");
  });

  it("labels the changed-files diff button as close for the open turn", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const assistantMessageId = MessageId.make("assistant-1");
    const turnId = TurnId.make("turn-1");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "Done",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
              turnId,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId,
                completedAt: "2026-03-17T19:12:30.000Z",
                files: [{ path: "src/index.ts", additions: 2, deletions: 1 }],
              },
            ],
          ])
        }
        openDiffTurnId={turnId}
      />,
    );

    expect(markup).toContain("Close diff");
    expect(markup).not.toContain("View diff");
  });

  it("renders assistant image, video, audio and document deliveries without an empty-response placeholder", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "delivered",
            kind: "message",
            createdAt: "2026-09-07T12:00:00Z",
            message: {
              id: MessageId.make("delivered"),
              role: "assistant",
              text: "",
              streaming: false,
              createdAt: "2026-09-07T12:00:00Z",
              attachments: [
                {
                  type: "image",
                  id: "image",
                  name: "result.png",
                  mimeType: "image/png",
                  sizeBytes: 30,
                  previewUrl: "/attachments/image",
                },
                {
                  type: "file",
                  id: "video",
                  name: "clip.mp4",
                  mimeType: "video/mp4",
                  sizeBytes: 30,
                  previewUrl: "/attachments/video",
                },
                {
                  type: "file",
                  id: "audio",
                  name: "voice.mp3",
                  mimeType: "audio/mpeg",
                  sizeBytes: 30,
                  previewUrl: "/attachments/audio",
                },
                {
                  type: "file",
                  id: "pdf",
                  name: "report.pdf",
                  mimeType: "application/pdf",
                  sizeBytes: 30,
                  previewUrl: "/attachments/pdf",
                },
              ],
            },
          },
        ]}
      />,
    );
    expect(markup).toContain("<img");
    expect(markup).toContain("<video");
    expect(markup).toContain("<audio");
    expect(markup).toContain('aria-label="Play voice.mp3"');
    expect(markup).toContain('download="report.pdf"');
    expect(markup).not.toContain("(empty response)");
    expect(markup).not.toContain("autoPlay");
  });

  it("renders file attachments as download rows and unknown attachments inert", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-07-24T12:00:00.000Z",
            message: {
              id: MessageId.make("user-1"),
              role: "user",
              text: "See attachments",
              createdAt: "2026-07-24T12:00:00.000Z",
              streaming: false,
              attachments: [
                {
                  type: "file",
                  id: "file-1",
                  name: "report.pdf",
                  mimeType: "application/pdf",
                  sizeBytes: 2048,
                  previewUrl: "http://localhost:0/attachments/file-1",
                },
                {
                  type: "file",
                  id: "file-2",
                  name: "orphan.bin",
                  mimeType: "application/octet-stream",
                  sizeBytes: 8,
                },
                {
                  type: "vendorX/telemetry",
                  name: "opaque-blob",
                  sizeBytes: 16,
                },
              ],
            },
          },
        ]}
      />,
    );

    expect(markup).toContain('href="http://localhost:0/attachments/file-1?download=report.pdf"');
    expect(markup).toContain('download="report.pdf"');
    expect(markup).toContain("report.pdf");
    expect(markup).toContain("2 KB");
    expect(markup).not.toContain('download="orphan.bin"');
    expect(markup).toContain("orphan.bin");
    expect(markup).toContain("opaque-blob");
    expect(markup).not.toContain("Preview unavailable");
  });

  it("pre-sizes image slots for attachments with dimensions and leaves unknown-size images unchanged", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-07-24T12:00:00.000Z",
            message: {
              id: MessageId.make("user-1"),
              role: "user",
              text: "See images",
              createdAt: "2026-07-24T12:00:00.000Z",
              streaming: false,
              attachments: [
                {
                  type: "image",
                  id: "image-1",
                  name: "chart.png",
                  mimeType: "image/png",
                  sizeBytes: 1024,
                  previewUrl: "http://localhost:0/attachments/image-1",
                  width: 640,
                  height: 480,
                },
                {
                  type: "image",
                  id: "image-2",
                  name: "unknown-size.png",
                  mimeType: "image/png",
                  sizeBytes: 512,
                  previewUrl: "http://localhost:0/attachments/image-2",
                },
              ],
            },
          },
        ]}
      />,
    );

    const imageTags = markup.match(/<img\b[^>]*>/g) ?? [];
    expect(imageTags).toHaveLength(2);
    expect(imageTags[0]).toContain('src="http://localhost:0/attachments/image-1"');
    expect(imageTags[0]).toContain('width="640"');
    expect(imageTags[0]).toContain('height="480"');
    expect(imageTags[1]).toContain('src="http://localhost:0/attachments/image-2"');
    expect(imageTags[1]).not.toContain("width=");
    expect(markup).toContain('aria-label="Preview chart.png"');
    expect(markup).toContain('aria-label="Preview unknown-size.png"');
  });

  it("renders received video file attachments inline with a download affordance and keeps other files as rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-07-24T12:00:00.000Z",
            message: {
              id: MessageId.make("user-1"),
              role: "user",
              text: "See media",
              createdAt: "2026-07-24T12:00:00.000Z",
              streaming: false,
              attachments: [
                {
                  type: "file",
                  id: "video-1",
                  name: "clip.mp4",
                  mimeType: "video/mp4",
                  sizeBytes: 8192,
                  previewUrl: "http://localhost:0/attachments/video-1",
                  width: 1920,
                  height: 1080,
                },
                {
                  type: "file",
                  id: "video-2",
                  name: "stream.mov",
                  mimeType: "video/quicktime",
                  sizeBytes: 4096,
                  previewUrl: "http://localhost:0/attachments/video-2",
                },
                {
                  type: "file",
                  id: "doc-1",
                  name: "notes.pdf",
                  mimeType: "application/pdf",
                  sizeBytes: 2048,
                  previewUrl: "http://localhost:0/attachments/doc-1",
                },
                {
                  type: "vendorX/telemetry",
                  name: "opaque-blob",
                  sizeBytes: 16,
                },
              ],
            },
          },
        ]}
      />,
    );

    const videoTags = markup.match(/<video\b[^>]*>/g) ?? [];
    expect(videoTags).toHaveLength(2);
    expect(videoTags[0]).toContain('src="http://localhost:0/attachments/video-1"');
    expect(videoTags[0]).toContain('width="1920"');
    expect(videoTags[0]).toContain('playsInline=""');
    expect(videoTags[0]).toContain("aspect-ratio:1920 / 1080");
    expect(videoTags[0]).toContain('height="1080"');
    expect(videoTags[1]).toContain('src="http://localhost:0/attachments/video-2"');
    expect(videoTags[1]).not.toContain("width=");
    expect(videoTags[1]).toContain("aspect-ratio:16 / 9");
    expect(markup).toContain('preload="metadata"');
    expect(markup).toContain('download="clip.mp4"');
    expect(markup).toContain('download="stream.mov"');
    expect(markup).toContain('href="http://localhost:0/attachments/doc-1?download=notes.pdf"');
    expect(markup).toContain('download="notes.pdf"');
    expect(markup).toContain("opaque-blob");
    expect(markup).not.toContain('download="opaque-blob"');
  });
});
