import "../../index.css";

import {
  ContextHandoffId,
  EnvironmentId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  TurnId,
} from "@ryco/contracts";
import { createRef } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import type { ContextHandoffTimelineEntry } from "../../session-logic";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { cdpSession } from "../../../test/browserPointer";

const scrollToEndSpy = vi.fn();
const scrollToIndexSpy = vi.fn();
type MockListenerType = "totalSize" | "headerSize" | "footerSize";
interface MockLegendListState {
  isAtEnd: boolean;
  scroll?: number;
  scrollLength?: number;
  listen?: (type: MockListenerType, callback: () => void) => () => void;
  positionAtIndex?: (index: number) => number | undefined;
  sizeAtIndex?: (index: number) => number | undefined;
}
const getStateSpy = vi.fn<() => MockLegendListState>(() => ({
  isAtEnd: true,
  listen: mockListen,
}));

// The timeline reads bottom-ness off the live scroller, so the mock hands it a
// detached element whose scroll metrics each test controls.
let scrollableNode: HTMLElement | null = null;
let latestLegendOnScroll: (() => void) | null = null;
const sizeListeners = new Set<() => void>();

function setScrollMetrics(metrics: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): HTMLElement {
  const node = document.createElement("div");
  Object.defineProperty(node, "scrollTop", { value: metrics.scrollTop, configurable: true });
  Object.defineProperty(node, "scrollHeight", { value: metrics.scrollHeight, configurable: true });
  Object.defineProperty(node, "clientHeight", { value: metrics.clientHeight, configurable: true });
  scrollableNode = node;
  return node;
}

function mockListen(type: MockListenerType, callback: () => void): () => void {
  if (type === "totalSize") {
    sizeListeners.add(callback);
  }
  return () => {
    sizeListeners.delete(callback);
  };
}

vi.mock("@legendapp/list/react", async () => {
  const React = await import("react");

  const LegendList = React.forwardRef(function MockLegendList(
    props: {
      data: Array<{ id: string }>;
      keyExtractor: (item: { id: string }) => string;
      renderItem: (args: { item: { id: string } }) => React.ReactNode;
      ListHeaderComponent?: React.ReactNode;
      ListFooterComponent?: React.ReactNode;
      className?: string;
      onScroll?: () => void;
      maintainScrollAtEnd?: boolean;
    },
    ref: React.ForwardedRef<LegendListRef>,
  ) {
    latestLegendOnScroll = props.onScroll ?? null;
    React.useImperativeHandle(
      ref,
      () =>
        ({
          scrollToEnd: scrollToEndSpy,
          scrollToIndex: scrollToIndexSpy,
          getState: getStateSpy,
          getScrollableNode: () => scrollableNode,
        }) as unknown as LegendListRef,
    );

    React.useEffect(() => {
      props.onScroll?.();
    }, [props]);

    return (
      <div
        className={props.className}
        data-testid="legend-list"
        data-maintain-scroll-at-end={String(props.maintainScrollAtEnd)}
      >
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

import { MessagesTimeline } from "./MessagesTimeline";
import { useUiStateStore } from "~/uiStateStore";

const THINKING_ENTRIES = [
  {
    id: "work-1",
    kind: "work" as const,
    createdAt: "2026-04-13T12:00:00.000Z",
    entry: {
      id: "work-1",
      createdAt: "2026-04-13T12:00:00.000Z",
      label: "thinking",
      detail: "Inspecting repository state",
      tone: "thinking" as const,
    },
  },
];

function makeContextHandoffMarker(
  overrides: Partial<ContextHandoffTimelineEntry> = {},
): ContextHandoffTimelineEntry {
  return {
    id: "context-handoff:activity-1",
    activityId: "activity-1",
    handoffId: ContextHandoffId.make("handoff-1"),
    createdAt: "2026-04-13T12:00:00.000Z",
    turnId: TurnId.make("turn-target"),
    status: "delivery-uncertain",
    targetMessageId: MessageId.make("message-target"),
    targetTurnId: TurnId.make("turn-target"),
    sources: [
      {
        providerInstanceId: ProviderInstanceId.make("codex_work"),
        driverKind: ProviderDriverKind.make("codex"),
        providerDisplayName: "Codex Work",
        modelSlug: "gpt-5.6-sol",
        modelDisplayName: "GPT-5.6 Sol",
      },
      {
        providerInstanceId: ProviderInstanceId.make("local_provider"),
        driverKind: ProviderDriverKind.make("localProvider"),
        providerDisplayName: "Local Provider",
        modelSlug: "a-very-long-local-model-label-for-overflow-testing",
        modelDisplayName: "A Very Long Local Model Label For Overflow Testing",
      },
    ],
    target: {
      providerInstanceId: ProviderInstanceId.make("claude_work"),
      driverKind: ProviderDriverKind.make("claudeAgent"),
      providerDisplayName: "Claude Work",
      modelSlug: "claude-fable-5",
      modelDisplayName: "Fable 5",
    },
    error: "Acceptance could not be proven after reconnect",
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
    onOpenTurnDiff: vi.fn(),
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: vi.fn(),
    onUndoTurn: vi.fn(),
    isRevertingCheckpoint: false,
    onImageExpand: vi.fn(),
    activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
    markdownCwd: undefined,
    resolvedTheme: "dark" as const,
    timestampFormat: "24-hour" as const,
    workspaceRoot: undefined,
    onIsAtEndChange: vi.fn(),
  };
}

describe("MessagesTimeline", () => {
  afterEach(() => {
    scrollToEndSpy.mockReset();
    scrollToIndexSpy.mockReset();
    getStateSpy.mockReset();
    getStateSpy.mockReturnValue({ isAtEnd: true, listen: mockListen });
    scrollableNode = null;
    latestLegendOnScroll = null;
    sizeListeners.clear();
    vi.restoreAllMocks();
    useUiStateStore.setState({
      threadTurnFoldExpandedById: {},
      threadWorkGroupExpandedById: {},
      threadWorkEntryExpandedById: {},
    });
    document.body.innerHTML = "";
  });

  it("keeps a multi-source handoff accessible and contained across narrow light and dark layouts", async () => {
    const marker = makeContextHandoffMarker();
    const timelineEntries = [
      {
        id: marker.id,
        kind: "context-handoff" as const,
        createdAt: marker.createdAt,
        marker,
      },
    ];
    const screen = await render(
      <div style={{ width: 320 }}>
        <MessagesTimeline {...buildProps()} timelineEntries={timelineEntries} />
      </div>,
    );

    try {
      const status = page.getByRole("status", {
        name: /Context handoff from Codex Work GPT-5.6 Sol, Local Provider .* to Claude Work Fable 5\. Delivery uncertain: Acceptance could not be proven after reconnect/,
      });
      await expect.element(status).toBeVisible();
      await expect.element(page.getByText("Delivery uncertain")).toBeVisible();

      const markerElement = status.element();
      expect(markerElement.dataset.contextHandoffSourceCount).toBe("2");
      expect(markerElement.scrollWidth).toBeLessThanOrEqual(markerElement.clientWidth);

      document.documentElement.classList.add("dark");
      await screen.rerender(
        <div style={{ width: 320 }}>
          <MessagesTimeline
            {...buildProps()}
            resolvedTheme="dark"
            timelineEntries={timelineEntries}
          />
        </div>,
      );
      await expect.element(status).toBeVisible();

      document.documentElement.classList.remove("dark");
      await screen.rerender(
        <div style={{ width: 320 }}>
          <MessagesTimeline
            {...buildProps()}
            resolvedTheme="light"
            timelineEntries={timelineEntries}
          />
        </div>,
      );
      await expect.element(status).toBeVisible();
    } finally {
      document.documentElement.classList.remove("dark");
      await screen.unmount();
    }
  });

  it("opens inspection from a keyboard-accessible divider using friendly model names", async () => {
    const marker = makeContextHandoffMarker({ status: "consumed" });
    const onInspectContextHandoff = vi.fn();
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        onInspectContextHandoff={onInspectContextHandoff}
        timelineEntries={[
          {
            id: marker.id,
            kind: "context-handoff" as const,
            createdAt: marker.createdAt,
            marker,
          },
        ]}
      />,
    );

    try {
      const divider = page.getByRole("button", {
        name: /Context handoff from Codex Work GPT-5.6 Sol, Local Provider .* to Claude Work Fable 5\. Completed/,
      });
      await expect.element(divider).toBeVisible();
      const dividerElement = divider.element();
      expect(dividerElement.textContent).toContain("Fable 5");
      expect(dividerElement.textContent).not.toContain("claude-fable-5");
      const timelineRow = dividerElement.closest<HTMLElement>(
        '[data-timeline-row-kind="context-handoff"]',
      );
      expect(timelineRow).not.toBeNull();
      const dividerRect = dividerElement.getBoundingClientRect();
      const rowRect = timelineRow!.getBoundingClientRect();
      expect(Math.abs(dividerRect.width - rowRect.width)).toBeLessThanOrEqual(1);
      const [leftRule, label, rightRule] = Array.from(dividerElement.children);
      expect(leftRule).toBeInstanceOf(HTMLElement);
      expect(label).toBeInstanceOf(HTMLElement);
      expect(rightRule).toBeInstanceOf(HTMLElement);
      const leftRuleRect = leftRule!.getBoundingClientRect();
      const labelRect = label!.getBoundingClientRect();
      const rightRuleRect = rightRule!.getBoundingClientRect();
      expect(Math.abs(leftRuleRect.width - rightRuleRect.width)).toBeLessThanOrEqual(1);
      expect(
        Math.abs(labelRect.left + labelRect.width / 2 - (dividerRect.left + dividerRect.width / 2)),
      ).toBeLessThanOrEqual(1);
      await userEvent.click(divider);
      expect(onInspectContextHandoff).toHaveBeenCalledWith(marker, expect.any(HTMLButtonElement));
    } finally {
      await screen.unmount();
    }
  });

  it("renders activity rows instead of the empty placeholder when a thread has non-message timeline data", async () => {
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "work-1",
            kind: "work",
            createdAt: "2026-04-13T12:00:00.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-04-13T12:00:00.000Z",
              label: "thinking",
              detail: "Inspecting repository state",
              tone: "thinking",
            },
          },
        ]}
      />,
    );

    try {
      await expect.element(page.getByText("Thinking · Inspecting repository state")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("duty-cycles only the pending Thinking label and removes it when work settles", async () => {
    const props = buildProps();
    const screen = await render(<MessagesTimeline {...props} isWorking timelineEntries={[]} />);

    try {
      const thinking = page.getByText("Thinking", { exact: true });
      await expect.element(thinking).toBeVisible();

      const thinkingElement = thinking.element();
      expect(thinkingElement.classList.contains("shimmer")).toBe(true);
      expect(thinkingElement.classList.contains("thinking-status-shimmer")).toBe(true);
      expect(getComputedStyle(thinkingElement).animationName).toBe("thinking-status-shimmer");
      expect(getComputedStyle(thinkingElement).animationDuration).toBe("6s");

      await screen.rerender(<MessagesTimeline {...props} isWorking={false} timelineEntries={[]} />);

      await expect.element(thinking).not.toBeInTheDocument();
      expect(document.querySelector(".thinking-status-shimmer")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("disables the status pulse, ping, and pending Thinking shimmer under reduced motion", async () => {
    await cdpSession().send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    let screen: Awaited<ReturnType<typeof render>> | null = null;

    try {
      await vi.waitFor(() => {
        expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
      });

      screen = await render(
        <div>
          <span data-testid="status-pulse-probe" className="animate-status-pulse" />
          <span data-testid="status-ping-probe" className="animate-status-ping" />
          <MessagesTimeline {...buildProps()} isWorking timelineEntries={[]} />
        </div>,
      );

      const thinking = page.getByText("Thinking", { exact: true });
      await expect.element(thinking).toBeVisible();

      expect(getComputedStyle(page.getByTestId("status-pulse-probe").element()).animationName).toBe(
        "none",
      );
      expect(getComputedStyle(page.getByTestId("status-ping-probe").element()).animationName).toBe(
        "none",
      );
      expect(getComputedStyle(thinking.element()).animationName).toBe("none");
      expect(getComputedStyle(thinking.element()).backgroundImage).toBe("none");
    } finally {
      await cdpSession().send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "" }],
      });
      await vi.waitFor(() => {
        expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(false);
      });
      await screen?.unmount();
    }
  });

  it("hides the transcript scrollbar so the content column never shifts width", async () => {
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "work-1",
            kind: "work",
            createdAt: "2026-04-13T12:00:00.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-04-13T12:00:00.000Z",
              label: "thinking",
              detail: "Inspecting repository state",
              tone: "thinking",
            },
          },
        ]}
      />,
    );

    try {
      const list = document.querySelector<HTMLElement>('[data-testid="legend-list"]');
      expect(list).not.toBeNull();
      expect(list!.className).toContain("[scrollbar-width:none]");
      expect(getComputedStyle(list!).scrollbarWidth).toBe("none");
      // No gutter to reserve once the scrollbar is gone, so the visible width
      // stays put whether or not the transcript overflows.
      expect(list!.offsetWidth - list!.clientWidth).toBe(0);
    } finally {
      await screen.unmount();
    }
  });

  it("previews, highlights, and navigates user turns from the desktop minimap", async () => {
    getStateSpy.mockReturnValue({
      isAtEnd: false,
      scroll: 0,
      scrollLength: 250,
      positionAtIndex: (index: number) => index * 100,
      sizeAtIndex: () => 80,
    });

    const makeMessageEntry = (
      rowId: string,
      messageId: string,
      role: "user" | "assistant",
      text: string,
      seconds: number,
    ) => ({
      id: rowId,
      kind: "message" as const,
      createdAt: `2026-07-24T12:00:0${seconds}.000Z`,
      message: {
        id: MessageId.make(messageId),
        role,
        text,
        createdAt: `2026-07-24T12:00:0${seconds}.000Z`,
        streaming: false,
      },
    });

    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          makeMessageEntry("user-row-1", "user-1", "user", "First request", 0),
          makeMessageEntry("assistant-row-1", "assistant-1", "assistant", "First response", 1),
          makeMessageEntry("user-row-2", "user-2", "user", "Second request", 2),
          makeMessageEntry("assistant-row-2", "assistant-2", "assistant", "Second response", 3),
          makeMessageEntry("user-row-3", "user-3", "user", "Third request", 4),
        ]}
      />,
    );

    try {
      const minimap = document.querySelector<HTMLElement>('[data-testid="timeline-minimap"]');
      const hitStrip = document.querySelector<HTMLButtonElement>(
        '[data-testid="timeline-minimap-hit-strip"]',
      );
      expect(minimap).not.toBeNull();
      expect(hitStrip).not.toBeNull();
      expect(minimap!.className).toContain("hidden");
      expect(minimap!.className).toContain("[@media(pointer:fine)]:block");
      expect(minimap!.className).toContain("opacity-100");
      expect(minimap!.className).not.toContain("opacity-0");

      await vi.waitFor(() => {
        const strips = Array.from(document.querySelectorAll<HTMLElement>("[data-minimap-strip]"));
        expect(strips.map((strip) => strip.dataset.inView)).toEqual(["true", "true", "false"]);
      });

      // The class gate above is the desktop contract; from here the test drives
      // pointer/keyboard interaction, which needs a real layout box. Device-less
      // CI reports `pointer: none`, so `[@media(pointer:fine)]` never matches
      // there and the container stays `display: none` — collapsing every rect to
      // zero and stranding the pointer-to-index math. Force the desktop
      // presentation so the interaction leg runs on every platform.
      minimap!.style.display = "block";

      const hitStripRect = hitStrip!.getBoundingClientRect();
      hitStrip!.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          clientY: hitStripRect.top + hitStripRect.height / 2,
        }),
      );

      await vi.waitFor(() => {
        const preview = document.querySelector<HTMLElement>("[data-minimap-preview]");
        expect(preview?.textContent).toContain("Second request");
        expect(preview?.textContent).toContain("Second response");
      });

      hitStrip!.focus();
      hitStrip!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "End" }));
      await vi.waitFor(() => {
        expect(hitStrip!.getAttribute("aria-label")).toBe("Jump to message: Third request");
      });
      hitStrip!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));

      await vi.waitFor(() => {
        expect(scrollToIndexSpy).toHaveBeenCalledWith({
          index: 4,
          animated: true,
          viewOffset: 24,
        });
      });
    } finally {
      await screen.unmount();
    }
  });

  it("renders user message bubbles with borderless soft chrome", async () => {
    const userMessageId = MessageId.make("message-user-1");
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        revertTurnCountByUserMessageId={new Map([[userMessageId, 1]])}
        timelineEntries={[
          {
            id: "message-1",
            kind: "message",
            createdAt: "2026-04-13T12:00:00.000Z",
            message: {
              id: userMessageId,
              role: "user",
              text: "Apply the cleaner chrome",
              createdAt: "2026-04-13T12:00:00.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    try {
      await expect.element(page.getByText("Apply the cleaner chrome")).toBeVisible();
      const userBubble = document.querySelector<HTMLElement>(".rounded-2xl.rounded-br-sm");

      expect(userBubble).not.toBeNull();
      expect(userBubble!.className).toContain("bg-foreground/8");
      expect(userBubble!.className).toContain("shadow-md/5");
      expect(userBubble!.className).not.toContain("border ");
      expect(userBubble!.className).not.toContain("ring-1");

      const copyButton = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Copy message"]',
      );
      const revertButton = document.querySelector<HTMLButtonElement>(
        'button[title="Revert to this message"]',
      );

      for (const button of [copyButton, revertButton]) {
        expect(button).not.toBeNull();
        expect(button!.className).toContain("border-0");
        expect(button!.className).toContain("bg-transparent");
        expect(button!.className).toContain("hover:bg-foreground/8");
        expect(button!.className).not.toContain("border-input");
      }
    } finally {
      await screen.unmount();
    }
  });

  it("snaps to the bottom when timeline rows appear after an initially empty render", async () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const props = buildProps();
    const screen = await render(<MessagesTimeline {...props} timelineEntries={[]} />);

    try {
      await expect
        .element(page.getByText("Thinking · Inspecting repository state"))
        .not.toBeInTheDocument();

      await screen.rerender(
        <MessagesTimeline
          {...props}
          timelineEntries={[
            {
              id: "work-1",
              kind: "work",
              createdAt: "2026-04-13T12:00:00.000Z",
              entry: {
                id: "work-1",
                createdAt: "2026-04-13T12:00:00.000Z",
                label: "thinking",
                detail: "Inspecting repository state",
                tone: "thinking",
              },
            },
          ]}
        />,
      );

      await expect.element(page.getByText("Thinking · Inspecting repository state")).toBeVisible();
      expect(props.onIsAtEndChange).toHaveBeenCalledWith(true);
      expect(scrollToEndSpy).toHaveBeenCalledWith({ animated: false });
      expect(requestAnimationFrameSpy).toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("never reports away-from-end for a transcript too short to scroll", async () => {
    setScrollMetrics({ scrollTop: 0, scrollHeight: 400, clientHeight: 800 });

    const props = buildProps();
    const screen = await render(<MessagesTimeline {...props} timelineEntries={THINKING_ENTRIES} />);

    try {
      await expect.element(page.getByText("Thinking · Inspecting repository state")).toBeVisible();
      expect(props.onIsAtEndChange).toHaveBeenCalledWith(true);
      expect(props.onIsAtEndChange).not.toHaveBeenCalledWith(false);
    } finally {
      await screen.unmount();
    }
  });

  it("reports away-from-end while the transcript is scrolled up", async () => {
    setScrollMetrics({ scrollTop: 0, scrollHeight: 2000, clientHeight: 800 });

    const props = buildProps();
    const screen = await render(<MessagesTimeline {...props} timelineEntries={THINKING_ENTRIES} />);

    try {
      await expect.element(page.getByText("Thinking · Inspecting repository state")).toBeVisible();
      expect(props.onIsAtEndChange).toHaveBeenCalledWith(false);
    } finally {
      await screen.unmount();
    }
  });

  it("gates automatic end pinning with the explicit live-follow latch", async () => {
    const props = buildProps();
    const screen = await render(
      <MessagesTimeline {...props} liveFollowEnabled={false} timelineEntries={THINKING_ENTRIES} />,
    );

    try {
      const list = page.getByTestId("legend-list");
      expect(list.element().dataset.maintainScrollAtEnd).toBe("false");

      await screen.rerender(
        <MessagesTimeline {...props} liveFollowEnabled timelineEntries={THINKING_ENTRIES} />,
      );
      expect(list.element().dataset.maintainScrollAtEnd).toBe("true");
    } finally {
      await screen.unmount();
    }
  });

  it("breaks live follow on upward navigation and rearms only at a user-reached end", async () => {
    const scrollNode = setScrollMetrics({ scrollTop: 1200, scrollHeight: 2000, clientHeight: 800 });
    const onManualNavigation = vi.fn();
    const onUserReachedEnd = vi.fn();
    const props = buildProps();
    const screen = await render(
      <MessagesTimeline
        {...props}
        timelineEntries={THINKING_ENTRIES}
        onManualNavigation={onManualNavigation}
        onUserReachedEnd={onUserReachedEnd}
      />,
    );

    try {
      await expect.element(page.getByText("Thinking · Inspecting repository state")).toBeVisible();
      onUserReachedEnd.mockClear();
      latestLegendOnScroll?.();
      expect(onUserReachedEnd).not.toHaveBeenCalled();

      await vi.waitFor(() => {
        scrollNode.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
        expect(onManualNavigation).toHaveBeenCalled();
      });

      Object.defineProperty(scrollNode, "scrollTop", { value: 1050, configurable: true });
      latestLegendOnScroll?.();
      expect(onUserReachedEnd).not.toHaveBeenCalled();

      scrollNode.dispatchEvent(new WheelEvent("wheel", { deltaY: 80 }));
      Object.defineProperty(scrollNode, "scrollTop", { value: 1200, configurable: true });
      latestLegendOnScroll?.();
      expect(onUserReachedEnd).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("re-checks the bottom when the measured content size settles", async () => {
    // Estimated row sizes overflow the viewport on the first pass...
    setScrollMetrics({ scrollTop: 0, scrollHeight: 2000, clientHeight: 800 });

    const props = buildProps();
    const screen = await render(<MessagesTimeline {...props} timelineEntries={THINKING_ENTRIES} />);

    try {
      await expect.element(page.getByText("Thinking · Inspecting repository state")).toBeVisible();
      expect(props.onIsAtEndChange).toHaveBeenLastCalledWith(false);

      // ...and the real measurement lands well under it. No scroll event
      // follows, so the content-size listener is what has to re-decide.
      setScrollMetrics({ scrollTop: 0, scrollHeight: 400, clientHeight: 800 });
      expect(sizeListeners.size).toBeGreaterThan(0);
      for (const listener of sizeListeners) {
        listener();
      }

      expect(props.onIsAtEndChange).toHaveBeenLastCalledWith(true);
    } finally {
      await screen.unmount();
    }
  });

  it("renders live file edits as non-expandable rows with text-only shimmer", async () => {
    const turnId = TurnId.make("turn-1");
    const editEntry = {
      id: "work-1",
      kind: "work" as const,
      createdAt: "2026-04-13T12:00:00.000Z",
      entry: {
        id: "work-1",
        createdAt: "2026-04-13T12:00:00.000Z",
        label: "File change",
        tone: "tool" as const,
        itemType: "file_change" as const,
        requestKind: "file-change" as const,
        changedFiles: ["src/app.ts"],
        changedFileStats: [{ path: "src/app.ts", additions: 255, deletions: 12 }],
        turnId,
      },
    };
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        activeTurnId={turnId}
        isWorking
        timelineEntries={[editEntry]}
      />,
    );

    try {
      await expect.element(page.getByText("Editing src/app.ts")).toBeVisible();
      await expect.element(page.getByText("+255")).not.toBeInTheDocument();
      await expect.element(page.getByText("-12")).not.toBeInTheDocument();

      const fileEditRow = document.querySelector<HTMLElement>("[data-file-edit-work-row='true']");
      const editText = document.querySelector<HTMLElement>(".chat-file-edit-text");

      expect(fileEditRow).not.toBeNull();
      expect(fileEditRow!.closest("[role='button']")).toBeNull();
      expect(fileEditRow!.dataset.fileEditWorkState).toBe("editing");
      expect(editText).not.toBeNull();
      expect(editText!.className).toContain("chat-file-edit-text--active");

      await screen.rerender(
        <MessagesTimeline
          {...buildProps()}
          activeTurnId={turnId}
          isWorking
          timelineEntries={[
            {
              ...editEntry,
              entry: {
                ...editEntry.entry,
                completed: true,
              },
            },
          ]}
        />,
      );

      await expect.element(page.getByText("Edited src/app.ts")).toBeVisible();
      await expect.element(page.getByText("+255")).toBeVisible();
      await expect.element(page.getByText("-12")).toBeVisible();

      const completedRow = document.querySelector<HTMLElement>("[data-file-edit-work-row='true']");
      const completedText = document.querySelector<HTMLElement>(".chat-file-edit-text");
      expect(completedRow?.dataset.fileEditWorkState).toBe("completed");
      expect(completedText?.className).not.toContain("chat-file-edit-text--active");
    } finally {
      await screen.unmount();
    }
  });

  it("aligns standard and file-edit tools to one compact base row", async () => {
    const props = buildProps();
    const screen = await render(
      <MessagesTimeline
        {...props}
        timelineEntries={[
          {
            id: "command-entry",
            kind: "work",
            createdAt: "2026-04-13T12:00:00.000Z",
            entry: {
              id: "command",
              createdAt: "2026-04-13T12:00:00.000Z",
              label: "Command",
              command: "bun typecheck",
              tone: "tool",
            },
          },
        ]}
      />,
    );

    try {
      const standardRow = document.querySelector<HTMLElement>(
        "[data-tool-entry-kind='expandable']",
      );
      const standardIcon = standardRow?.querySelector<HTMLElement>("[data-work-entry-icon='true']");
      expect(standardRow).not.toBeNull();
      expect(standardIcon).not.toBeNull();
      const standardRect = standardRow!.getBoundingClientRect();
      const standardIconRect = standardIcon!.getBoundingClientRect();
      expect(standardRect.height).toBe(30);

      await screen.rerender(
        <MessagesTimeline
          {...props}
          timelineEntries={[
            {
              id: "single-edit-entry",
              kind: "work",
              createdAt: "2026-04-13T12:00:01.000Z",
              entry: {
                id: "single-edit",
                createdAt: "2026-04-13T12:00:01.000Z",
                label: "File change",
                tone: "tool",
                itemType: "file_change",
                requestKind: "file-change",
                changedFiles: ["src/app.ts"],
                changedFileStats: [{ path: "src/app.ts", additions: 2, deletions: 1 }],
                completed: true,
              },
            },
          ]}
        />,
      );

      const singleEditRow = document.querySelector<HTMLElement>(
        "[data-tool-entry-kind='file-edit']",
      );
      const singleEditIcon = singleEditRow?.querySelector<HTMLElement>(
        "[data-work-entry-icon='true']",
      );
      expect(singleEditRow).not.toBeNull();
      expect(singleEditIcon).not.toBeNull();
      const singleEditRect = singleEditRow!.getBoundingClientRect();
      const singleEditIconRect = singleEditIcon!.getBoundingClientRect();
      expect(singleEditRect.height).toBe(standardRect.height);
      expect(singleEditIconRect.left).toBe(standardIconRect.left);

      await screen.rerender(
        <MessagesTimeline
          {...props}
          timelineEntries={[
            {
              id: "multi-edit-entry",
              kind: "work",
              createdAt: "2026-04-13T12:00:02.000Z",
              entry: {
                id: "multi-edit",
                createdAt: "2026-04-13T12:00:02.000Z",
                label: "File change",
                tone: "tool",
                itemType: "file_change",
                requestKind: "file-change",
                changedFiles: ["src/app.ts", "src/router.ts", "src/styles.css"],
                changedFileStats: [
                  { path: "src/app.ts", additions: 2, deletions: 1 },
                  { path: "src/router.ts", additions: 4, deletions: 0 },
                  { path: "src/styles.css", additions: 1, deletions: 2 },
                ],
                completed: true,
              },
            },
          ]}
        />,
      );

      const multiEditRow = document.querySelector<HTMLElement>(
        "[data-tool-entry-kind='file-edit']",
      );
      expect(multiEditRow).not.toBeNull();
      expect(multiEditRow!.getBoundingClientRect().height).toBeGreaterThan(standardRect.height);
      await expect.element(page.getByText("app.ts")).toBeVisible();
      await expect.element(page.getByText("router.ts")).toBeVisible();
      await expect.element(page.getByText("styles.css")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps failed commands collapsed with only a red failure icon", async () => {
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "failed-command-entry",
            kind: "work",
            createdAt: "2026-04-13T12:00:00.000Z",
            entry: {
              id: "failed-command",
              createdAt: "2026-04-13T12:00:00.000Z",
              label: "Command",
              command: "bun run missing-script",
              output: "error: Script not found",
              exitCode: 1,
              completed: true,
              tone: "tool",
            },
          },
        ]}
      />,
    );

    try {
      const row = document.querySelector<HTMLElement>("[data-tool-entry-kind='expandable']");
      const icon = row?.querySelector<HTMLElement>("[data-work-entry-icon='true']");
      const label = row?.querySelector<HTMLElement>("[data-work-entry-display-text='true']");

      expect(row).not.toBeNull();
      expect(row!.getAttribute("aria-expanded")).toBe("false");
      expect(icon?.querySelector(".lucide-circle-alert")).not.toBeNull();
      expect(icon?.className).toContain("text-destructive-foreground");
      expect(label?.className).not.toContain("text-destructive-foreground");
      await expect.element(page.getByText("error: Script not found")).not.toBeInTheDocument();

      await row!.click();
      await expect.element(page.getByText("error: Script not found")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("defers final changed files until the assistant response is complete", async () => {
    const assistantMessageId = MessageId.make("message-assistant-1");
    const turnId = TurnId.make("turn-1");
    const props = {
      ...buildProps(),
      turnDiffSummaryByAssistantMessageId: new Map([
        [
          assistantMessageId,
          {
            turnId,
            completedAt: "2026-04-13T12:00:03.000Z",
            files: [{ path: "src/app.ts", additions: 2, deletions: 1 }],
            assistantMessageId,
          },
        ],
      ]),
    };
    const streamingEntry = {
      id: "message-1",
      kind: "message" as const,
      createdAt: "2026-04-13T12:00:00.000Z",
      message: {
        id: assistantMessageId,
        role: "assistant" as const,
        text: "Applying changes",
        turnId,
        createdAt: "2026-04-13T12:00:00.000Z",
        streaming: true,
      },
    };
    const screen = await render(<MessagesTimeline {...props} timelineEntries={[streamingEntry]} />);

    try {
      await expect.element(page.getByText("Applying changes")).toBeVisible();
      await expect.element(page.getByText("Edited 1 file")).not.toBeInTheDocument();

      await screen.rerender(
        <MessagesTimeline
          {...props}
          timelineEntries={[
            {
              ...streamingEntry,
              message: {
                ...streamingEntry.message,
                completedAt: "2026-04-13T12:00:04.000Z",
                streaming: false,
              },
            },
          ]}
        />,
      );

      await expect.element(page.getByText("Edited 1 file")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps current-turn changed files hidden until the turn is settled", async () => {
    const assistantMessageId = MessageId.make("message-assistant-active");
    const turnId = TurnId.make("turn-active");
    const props = {
      ...buildProps(),
      activeTurnId: turnId,
      activeTurnInProgress: true,
      turnDiffSummaryByAssistantMessageId: new Map([
        [
          assistantMessageId,
          {
            turnId,
            completedAt: "2026-04-13T12:00:03.000Z",
            files: [{ path: "src/live.ts", additions: 8, deletions: 1 }],
            assistantMessageId,
          },
        ],
      ]),
    };
    const timelineEntry = {
      id: "message-active",
      kind: "message" as const,
      createdAt: "2026-04-13T12:00:00.000Z",
      message: {
        id: assistantMessageId,
        role: "assistant" as const,
        text: "Still finishing the response",
        createdAt: "2026-04-13T12:00:00.000Z",
        completedAt: "2026-04-13T12:00:02.000Z",
        streaming: false,
      },
    };
    const screen = await render(<MessagesTimeline {...props} timelineEntries={[timelineEntry]} />);

    try {
      await expect.element(page.getByText("Still finishing the response")).toBeVisible();
      await expect.element(page.getByText("Edited 1 file")).not.toBeInTheDocument();

      await screen.rerender(
        <MessagesTimeline
          {...props}
          activeTurnInProgress={false}
          timelineEntries={[timelineEntry]}
        />,
      );

      await expect.element(page.getByText("Edited 1 file")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("uses one collapsible activity design while running and auto-collapses on completion", async () => {
    const turnId = TurnId.make("turn-activity");
    const commentaryEntry = {
      id: "commentary-entry",
      kind: "message" as const,
      createdAt: "2026-04-13T12:00:04.000Z",
      message: {
        id: MessageId.make("message-commentary"),
        role: "assistant" as const,
        text: "I am checking the current implementation.",
        turnId,
        createdAt: "2026-04-13T12:00:04.000Z",
        streaming: true,
      },
    };
    const runningEntries = [
      commentaryEntry,
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-04-13T12:00:06.000Z",
        entry: {
          id: "work-1",
          createdAt: "2026-04-13T12:00:06.000Z",
          label: "First command",
          detail: "rg -n Working",
          tone: "tool" as const,
          turnId,
        },
      },
      {
        id: "work-entry-2",
        kind: "work" as const,
        createdAt: "2026-04-13T12:00:08.000Z",
        entry: {
          id: "work-2",
          createdAt: "2026-04-13T12:00:08.000Z",
          label: "Latest command",
          detail: "bun typecheck",
          tone: "tool" as const,
          turnId,
        },
      },
    ];
    const props = {
      ...buildProps(),
      isWorking: true,
      activeTurnInProgress: true,
      activeTurnId: turnId,
      latestTurn: {
        turnId,
        state: "running" as const,
        startedAt: "2026-04-13T12:00:00.000Z",
        completedAt: null,
      },
      activeTurnStartedAt: "2026-04-13T12:00:00.000Z",
    };
    const screen = await render(<MessagesTimeline {...props} timelineEntries={runningEntries} />);

    try {
      const runningFold = page.getByRole("button", { name: /Working for/ });
      await expect.element(runningFold).toBeVisible();
      await expect.element(runningFold).toHaveAttribute("aria-expanded", "true");
      await expect
        .element(page.getByText("I am checking the current implementation."))
        .toBeVisible();
      await expect
        .element(page.getByText("Latest command · bun typecheck"))
        .not.toBeInTheDocument();
      await expect.element(page.getByText("Ran 2 tool calls · Running")).toBeVisible();

      runningFold.element().focus();
      await userEvent.keyboard("{Enter}");
      await expect.element(runningFold).toHaveAttribute("aria-expanded", "false");
      await expect
        .element(page.getByText("I am checking the current implementation."))
        .not.toBeInTheDocument();

      const finalEntry = {
        id: "final-entry",
        kind: "message" as const,
        createdAt: "2026-04-13T12:00:39.000Z",
        message: {
          id: MessageId.make("message-final"),
          role: "assistant" as const,
          text: "The redesign is complete.",
          turnId,
          createdAt: "2026-04-13T12:00:39.000Z",
          completedAt: "2026-04-13T12:00:40.000Z",
          streaming: false,
        },
      };
      await screen.rerender(
        <MessagesTimeline
          {...props}
          isWorking={false}
          activeTurnInProgress={false}
          latestTurn={{
            turnId,
            state: "completed",
            startedAt: "2026-04-13T12:00:00.000Z",
            completedAt: "2026-04-13T12:00:40.000Z",
          }}
          timelineEntries={[
            {
              ...commentaryEntry,
              message: {
                ...commentaryEntry.message,
                completedAt: "2026-04-13T12:00:05.000Z",
                streaming: false,
              },
            },
            runningEntries[1]!,
            runningEntries[2]!,
            finalEntry,
          ]}
        />,
      );

      const settledFold = page.getByRole("button", { name: "Worked for 40s" });
      await expect.element(settledFold).toBeVisible();
      await expect.element(settledFold).toHaveAttribute("aria-expanded", "false");
      await expect.element(page.getByText("Response • Worked for 40s")).not.toBeInTheDocument();
      await expect.element(page.getByText("The redesign is complete.")).toBeVisible();
      await expect
        .element(page.getByText("I am checking the current implementation."))
        .not.toBeInTheDocument();

      await settledFold.click();
      await expect.element(settledFold).toHaveAttribute("aria-expanded", "true");
      await expect
        .element(page.getByText("I am checking the current implementation."))
        .toBeVisible();
      await expect.element(page.getByText("Ran 2 tool calls · Running")).toBeVisible();

      const previousToolsToggle = page.getByRole("button", {
        name: "Ran 2 tool calls · Running",
      });
      previousToolsToggle.element().focus();
      await userEvent.keyboard(" ");
      await expect.element(page.getByText("First command · rg -n Working")).toBeVisible();
      await expect.element(page.getByText("Latest command · bun typecheck")).toBeVisible();
      await expect.element(previousToolsToggle).toHaveAttribute("aria-expanded", "true");
      await userEvent.keyboard(" ");
      await expect.element(page.getByText("First command · rg -n Working")).not.toBeInTheDocument();
      await expect
        .element(page.getByText("Latest command · bun typecheck"))
        .not.toBeInTheDocument();
      // The recap keeps its label in both states — the chevron carries the
      // open/closed meaning, so the row does not rewrite itself on toggle.
      await expect.element(previousToolsToggle).toHaveAttribute("aria-expanded", "false");
    } finally {
      await screen.unmount();
    }
  });
});
