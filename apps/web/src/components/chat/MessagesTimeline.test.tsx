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
    // Without a recorded reason a handoff is a model change, rendered as before.
    expect(markup).toContain('data-context-handoff-reason="model-change"');
    expect(markup).not.toContain("data-context-handoff-retry-hint");
  });

  it("renders a folder relocation as a fresh session, not as a model transition", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const sameModel = makeContextHandoffMarker().target;
    const consumed = makeContextHandoffMarker({
      id: "context-handoff:relocated",
      handoffId: ContextHandoffId.make("handoff-relocated"),
      reason: "cwd-relocation",
      sources: [sameModel],
      target: sameModel,
    });
    const failed = makeContextHandoffMarker({
      id: "context-handoff:relocation-failed",
      handoffId: ContextHandoffId.make("handoff-relocation-failed"),
      reason: "cwd-relocation",
      status: "failed",
      error: "The fresh session could not start.",
      sources: [sameModel],
      target: sameModel,
    });
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[consumed, failed].map((marker) => ({
          id: marker.id,
          kind: "context-handoff" as const,
          createdAt: marker.createdAt,
          marker,
        }))}
      />,
    );

    expect(markup.match(/data-context-handoff-reason="cwd-relocation"/g)).toHaveLength(2);
    expect(markup).toContain("Continued in a fresh session in the new folder");
    expect(markup).toContain(
      "Fresh session in the new folder. Failed: The fresh session could not start. Send your message again to retry",
    );
    expect(markup).toContain("data-context-handoff-retry-hint");
    expect(markup).toContain("Send your message again to retry.");
    expect(markup).toContain("lucide-folder-input");
    // No `<model> → <model>` transition and no "Context handoff from" label.
    expect(markup).not.toContain("lucide-arrow-right");
    expect(markup).not.toContain("lucide-arrow-left-right");
    expect(markup).not.toContain("Context handoff from");
    expect(markup).not.toContain("Fable 5");
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

  describe("HTML renders", () => {
    const htmlRenderAttachment = {
      type: "file" as const,
      id: "thread-1-abc-html",
      name: "Chart.html",
      mimeType: "text/html",
      sizeBytes: 64,
      htmlRender: { title: "Chart", height: 420 },
    };
    const page = '<p id="chart">Chart</p><a href="https://example.com">Source</a>';

    async function renderTimeline(message: {
      id: string;
      text: string;
      attachments: Array<typeof htmlRenderAttachment>;
    }) {
      const { __rememberHtmlRenderSourceForTests } = await import("./useHtmlRenderSource");
      __rememberHtmlRenderSourceForTests(
        {
          environmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
          threadId: "thread-1" as never,
          messageId: MessageId.make(message.id),
          attachmentId: htmlRenderAttachment.id,
        },
        page,
      );
      const { MessagesTimeline } = await import("./MessagesTimeline");
      return renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          timelineEntries={[
            {
              id: `${message.id}-entry`,
              kind: "message",
              createdAt: "2026-09-04T12:00:03.000Z",
              message: {
                id: MessageId.make(message.id),
                role: "assistant",
                text: message.text,
                turnId: TurnId.make("turn-render"),
                createdAt: "2026-09-04T12:00:03.000Z",
                completedAt: "2026-09-04T12:00:03.000Z",
                streaming: false,
                attachments: message.attachments,
              },
            },
          ]}
        />,
      );
    }

    it("shows a render-only message as its page in a sandboxed srcdoc frame", async () => {
      const markup = await renderTimeline({
        id: "render",
        text: " ",
        attachments: [htmlRenderAttachment],
      });
      expect(markup).toContain('data-timeline-row-kind="html-render"');
      expect(markup).not.toContain('data-message-role="assistant"');
      expect(markup.match(/<iframe/g)).toHaveLength(1);
      expect(markup).toContain('sandbox="allow-scripts allow-forms"');
      expect(markup).not.toContain("allow-same-origin");
      expect(markup).not.toContain("allow-popups");
      expect(markup).toContain('referrerPolicy="no-referrer"');
      expect(markup).toContain('title="Chart"');
      // The page travels as escaped srcdoc, never as a URL.
      expect(markup).toContain('srcDoc="&lt;p id=&quot;chart&quot;&gt;Chart&lt;/p&gt;');
      expect(markup).not.toMatch(/<iframe[^>]*\ssrc="/);
      expect(markup).toContain('name="ryco-theme:{');
      // The box reserves the page's height before it loads.
      expect(markup).toContain("height:420px");
      expect(markup).not.toContain("(empty response)");
      expect(markup).not.toContain('download="Chart.html"');
    });

    it("ends the turn's reply with a card per page, thumbnail in the reader's appearance", async () => {
      const { MessagesTimeline } = await import("./MessagesTimeline");
      const turnId = TurnId.make("turn-render");
      const light = "data:image/webp;base64,TElHSFQ=";
      const dark = "data:image/webp;base64,REFSSw==";
      const markup = renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          latestTurn={{
            turnId,
            state: "completed",
            startedAt: "2026-09-04T12:00:00.000Z",
            completedAt: "2026-09-04T12:00:06.000Z",
          }}
          timelineEntries={[
            {
              id: "render-entry",
              kind: "message",
              createdAt: "2026-09-04T12:00:03.000Z",
              message: {
                id: MessageId.make("render"),
                role: "assistant",
                text: " ",
                turnId,
                createdAt: "2026-09-04T12:00:03.000Z",
                completedAt: "2026-09-04T12:00:03.000Z",
                streaming: false,
                attachments: [
                  {
                    ...htmlRenderAttachment,
                    htmlRender: { title: "Chart", height: 420, thumbnails: { light, dark } },
                  },
                  {
                    ...htmlRenderAttachment,
                    id: "thread-1-def-html",
                    htmlRender: { title: "Mockup", height: 300 },
                  },
                ],
              },
            },
            {
              id: "reply-entry",
              kind: "message",
              createdAt: "2026-09-04T12:00:05.000Z",
              message: {
                id: MessageId.make("reply"),
                role: "assistant",
                text: "Revenue doubled.",
                turnId,
                createdAt: "2026-09-04T12:00:05.000Z",
                completedAt: "2026-09-04T12:00:05.000Z",
                streaming: false,
              },
            },
          ]}
        />,
      );
      const reply = markup.slice(markup.indexOf('data-message-id="reply"'));
      expect(reply).toContain("Revenue doubled.");
      const cards = reply.match(/<button[^>]*data-html-render-card=""[^>]*>[\s\S]*?<\/button>/g)!;
      expect(cards).toHaveLength(2);
      expect(cards[0]).toContain('aria-label="Open Chart"');
      // Explicit size (no layout shift), decorative, decoded off the main thread.
      expect(cards[0]).toMatch(
        new RegExp(
          `<img src="${light.replace(/[+/]/g, "\\$&")}" alt="" width="72" height="45" loading="lazy" decoding="async"`,
        ),
      );
      expect(cards[0]).not.toContain(dark);
      // No thumbnail stored: a placeholder icon instead of an image.
      expect(cards[1]).toContain('aria-label="Open Mockup"');
      expect(cards[1]).not.toContain("<img");
      expect(cards[1]).toContain("<svg");
      // Each page itself still shows above the reply, once.
      expect(markup.match(/data-html-render-frame=""/g)).toHaveLength(2);
      expect(markup.indexOf("data-html-render-frame")).toBeLessThan(
        markup.indexOf('data-message-id="reply"'),
      );
    });

    it("shows a render beside text as its page, not as an .html file row", async () => {
      const markup = await renderTimeline({
        id: "mixed",
        text: "Here is the chart.",
        attachments: [htmlRenderAttachment],
      });
      expect(markup).toContain('data-message-role="assistant"');
      expect(markup).toContain("Here is the chart.");
      expect(markup).toContain('sandbox="allow-scripts allow-forms"');
      expect(markup).not.toContain('download="Chart.html"');
      expect(markup).not.toContain("Text preview");
    });
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
