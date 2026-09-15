// Production CSS is part of the behavior under test: the phone tier variants
// drive the always-visible action affordances and tap-to-expand assertions.
import "../../index.css";

import { EnvironmentId, MessageId } from "@ryco/contracts";
import { createRef } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { parkPointer } from "../../../test/browserPointer";

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
    },
    ref: React.ForwardedRef<LegendListRef>,
  ) {
    React.useImperativeHandle(
      ref,
      () =>
        ({
          scrollToEnd: () => {},
          getState: () => ({ isAtEnd: true }),
        }) as unknown as LegendListRef,
    );

    return (
      <div className={props.className} data-testid="legend-list">
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

import { __resetContextMenuSheetForTests } from "../../contextMenuSheetState";
import { getPresentationTier, syncDocumentPresentationTier } from "../../lib/presentationTier";
import { useUiStateStore } from "../../uiStateStore";
import ChatMarkdown from "../ChatMarkdown";
import { ContextMenuActionSheetHost } from "../shell/phone/ContextMenuActionSheetHost";
import { MessagesTimeline } from "./MessagesTimeline";

const USER_MESSAGE_ID = MessageId.make("message-user-1");
const ASSISTANT_MESSAGE_ID = MessageId.make("message-assistant-1");

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
    revertTurnCountByUserMessageId: new Map([[USER_MESSAGE_ID, 1]]),
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

function userAndAssistantEntries() {
  return [
    {
      id: "message-1",
      kind: "message" as const,
      createdAt: "2026-07-20T12:00:00.000Z",
      message: {
        id: USER_MESSAGE_ID,
        role: "user" as const,
        text: "Please refactor the adapter",
        createdAt: "2026-07-20T12:00:00.000Z",
        streaming: false,
      },
    },
    {
      id: "message-2",
      kind: "message" as const,
      createdAt: "2026-07-20T12:00:05.000Z",
      message: {
        id: ASSISTANT_MESSAGE_ID,
        role: "assistant" as const,
        text: "Refactored the adapter as requested.",
        createdAt: "2026-07-20T12:00:05.000Z",
        completedAt: "2026-07-20T12:00:09.000Z",
        streaming: false,
      },
    },
  ];
}

const LONG_PRESS_HOLD_MS = 600;

async function dispatchLongPress(element: HTMLElement): Promise<void> {
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  element.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerId: 7,
      isPrimary: true,
      button: 0,
      clientX: x,
      clientY: y,
      pointerType: "touch",
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, LONG_PRESS_HOLD_MS));
  element.dispatchEvent(
    new PointerEvent("pointerup", {
      bubbles: true,
      cancelable: true,
      pointerId: 7,
      isPrimary: true,
      button: 0,
      clientX: x,
      clientY: y,
      pointerType: "touch",
    }),
  );
}

function sheetRow(label: string): HTMLButtonElement | null {
  const popup = document.querySelector<HTMLElement>('[data-slot="sheet-popup"]');
  if (!popup) return null;
  return (
    [...popup.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === label,
    ) ?? null
  );
}

function userBubble(): HTMLElement {
  const bubble = document.querySelector<HTMLElement>(".rounded-2xl.rounded-br-sm");
  expect(bubble).not.toBeNull();
  return bubble!;
}

const clipboardWriteText = vi.fn(async () => {});
let originalClipboardDescriptor: PropertyDescriptor | undefined;

let mounted: Awaited<ReturnType<typeof render>> | null = null;

describe("message touch actions", () => {
  beforeAll(() => {
    syncDocumentPresentationTier();
    originalClipboardDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard");
  });

  beforeEach(async () => {
    await page.viewport(390, 844);
    await vi.waitFor(() => {
      expect(getPresentationTier()).toBe("phone");
    });
    clipboardWriteText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
  });

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    if (originalClipboardDescriptor) {
      Object.defineProperty(Navigator.prototype, "clipboard", originalClipboardDescriptor);
    }
    // Remove the per-instance override installed in beforeEach.
    delete (navigator as unknown as Record<string, unknown>)["clipboard"];
    __resetContextMenuSheetForTests();
    useUiStateStore.setState({ threadWorkEntryExpandedById: {} });
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    await page.viewport(1_280, 720);
  });

  it("keeps message actions visible on phone while desktop stays hover-revealed", async () => {
    mounted = await render(
      <MessagesTimeline {...buildProps()} timelineEntries={userAndAssistantEntries()} />,
    );

    const copyButton = await vi.waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>('button[aria-label="Copy message"]');
      expect(button).not.toBeNull();
      return button!;
    });
    const actionRow = copyButton.closest("div")!;
    expect(getComputedStyle(actionRow).opacity).toBe("1");

    await page.viewport(1_280, 720);
    await vi.waitFor(() => {
      expect(getPresentationTier()).toBe("desktop");
    });
    // Park the real pointer so the hover-reveal assertion cannot be
    // satisfied by wherever an earlier interaction left it.
    await parkPointer(4, 4);
    await vi.waitFor(() => {
      expect(getComputedStyle(actionRow).opacity).toBe("0");
    });
  });

  it("opens the message action sheet from a long-press and round-trips copy and revert", async () => {
    const props = buildProps();
    mounted = await render(
      <MessagesTimeline {...props} timelineEntries={userAndAssistantEntries()} />,
    );

    await vi.waitFor(() => {
      expect(document.querySelector(".rounded-2xl.rounded-br-sm")).not.toBeNull();
    });

    // Copy round-trip through the shared clipboard hook.
    await dispatchLongPress(userBubble());
    await vi.waitFor(() => {
      expect(sheetRow("Copy message")).not.toBeNull();
    });
    expect(sheetRow("Copy message")!.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    sheetRow("Copy message")!.click();
    await vi.waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith("Please refactor the adapter");
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-slot="sheet-popup"]')).toBeNull();
    });

    // Revert round-trip through the existing revert handler.
    await dispatchLongPress(userBubble());
    await vi.waitFor(() => {
      expect(sheetRow("Revert to this message")).not.toBeNull();
    });
    sheetRow("Revert to this message")!.click();
    await vi.waitFor(() => {
      expect(props.onRevertUserMessage).toHaveBeenCalledWith(USER_MESSAGE_ID);
    });
  });

  it("opens the assistant copy action from a long-press on the response", async () => {
    mounted = await render(
      <MessagesTimeline {...buildProps()} timelineEntries={userAndAssistantEntries()} />,
    );

    const assistantBlock = await vi.waitFor(() => {
      const block = document
        .querySelector<HTMLElement>('[data-message-role="assistant"]')
        ?.querySelector<HTMLElement>(".min-w-0.px-1");
      expect(block).not.toBeNull();
      return block!;
    });
    await dispatchLongPress(assistantBlock);
    await vi.waitFor(() => {
      expect(sheetRow("Copy response")).not.toBeNull();
    });
    sheetRow("Copy response")!.click();
    await vi.waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith("Refactored the adapter as requested.");
    });
  });

  it("cancels the long-press on a >10px drag and never hijacks text selection", async () => {
    mounted = await render(
      <MessagesTimeline {...buildProps()} timelineEntries={userAndAssistantEntries()} />,
    );
    await vi.waitFor(() => {
      expect(document.querySelector(".rounded-2xl.rounded-br-sm")).not.toBeNull();
    });

    const bubble = userBubble();
    const rect = bubble.getBoundingClientRect();
    bubble.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        pointerId: 9,
        isPrimary: true,
        button: 0,
        clientX: rect.left + 10,
        clientY: rect.top + 10,
        pointerType: "touch",
      }),
    );
    // While the press is pending, selection is suppressed on the target only.
    expect(bubble.style.userSelect).toBe("none");
    bubble.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        pointerId: 9,
        isPrimary: true,
        clientX: rect.left + 10,
        clientY: rect.top + 34,
        pointerType: "touch",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, LONG_PRESS_HOLD_MS));
    expect(document.querySelector('[data-slot="sheet-popup"]')).toBeNull();
    // The drag cancelled the press and restored the selection guard.
    expect(bubble.style.userSelect).toBe("");
    expect(window.getSelection()?.toString() ?? "").toBe("");
  });

  it("does not long-press on the desktop tier", async () => {
    await page.viewport(1_280, 720);
    await vi.waitFor(() => {
      expect(getPresentationTier()).toBe("desktop");
    });
    mounted = await render(
      <MessagesTimeline {...buildProps()} timelineEntries={userAndAssistantEntries()} />,
    );
    await vi.waitFor(() => {
      expect(document.querySelector(".rounded-2xl.rounded-br-sm")).not.toBeNull();
    });

    await dispatchLongPress(userBubble());
    expect(document.querySelector('[data-slot="sheet-popup"]')).toBeNull();
  });

  it("expands truncated tool detail in place on every tier instead of tooltip-only", async () => {
    const longDetail =
      "Inspecting repository state across apps/web, apps/server, and packages/contracts before the refactor";
    mounted = await render(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "work-1",
            kind: "work",
            createdAt: "2026-07-20T12:00:00.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-07-20T12:00:00.000Z",
              label: "thinking",
              detail: longDetail,
              tone: "thinking" as const,
            },
          },
        ]}
      />,
    );

    const expandRow = await vi.waitFor(() => {
      const row = document.querySelector<HTMLElement>('[role="button"][aria-expanded]');
      expect(row).not.toBeNull();
      return row!;
    });
    expect(expandRow.getAttribute("aria-expanded")).toBe("false");
    expandRow.click();
    const detailBlock = await vi.waitFor(() => {
      const block = document.querySelector<HTMLElement>('[data-work-entry-detail="true"]');
      expect(block).not.toBeNull();
      return block!;
    });
    // Phone: the full text is part of the expanded panel's Activity card.
    expect(detailBlock.textContent).toBe(longDetail);
    expect(getComputedStyle(detailBlock).display).not.toBe("none");

    // Desktop still offers the hover tooltip, but the panel is the single
    // source of the full text — it is not a phone-only fallback.
    await page.viewport(1_280, 720);
    await vi.waitFor(() => {
      expect(getPresentationTier()).toBe("desktop");
    });
    await vi.waitFor(() => {
      expect(getComputedStyle(detailBlock).display).not.toBe("none");
    });
    expect(detailBlock.textContent).toBe(longDetail);
  });

  it.each([
    { language: "ts", source: "const value = 1;" },
    { language: "mermaid", source: "flowchart LR\nA-->B" },
  ])(
    "keeps the $language code-block copy button always visible on phone and hover-revealed on desktop",
    async ({ language, source }) => {
      mounted = await render(
        <ChatMarkdown text={`\`\`\`${language}\n${source}\n\`\`\``} cwd={undefined} />,
      );

      const copyButton = await vi.waitFor(() => {
        const button = document.querySelector<HTMLButtonElement>(".chat-markdown-copy-button");
        expect(button).not.toBeNull();
        return button!;
      });
      expect(getComputedStyle(copyButton).opacity).toBe("1");
      expect(getComputedStyle(copyButton).pointerEvents).toBe("auto");
      expect(document.querySelector(".chat-markdown-mermaid img")).toBeNull();

      await page.viewport(1_280, 720);
      await vi.waitFor(() => {
        expect(getPresentationTier()).toBe("desktop");
      });
      await parkPointer(4, 4);
      await vi.waitFor(() => {
        // A resize must preserve the actual control, not leave us inspecting a
        // detached node whose computed opacity is the empty string.
        expect(copyButton.isConnected).toBe(true);
        expect(document.querySelector(".chat-markdown-copy-button")).toBe(copyButton);
        expect(getComputedStyle(copyButton).opacity).toBe("0");
        expect(getComputedStyle(copyButton).pointerEvents).toBe("none");
      });
      if (language === "mermaid") {
        await expect.element(page.getByRole("img")).toBeVisible();
      }
      const block = copyButton.closest<HTMLElement>(".chat-markdown-codeblock")!;
      const rect = block.getBoundingClientRect();
      await parkPointer(rect.left + 10, rect.top + 10);
      await vi.waitFor(() => {
        expect(getComputedStyle(copyButton).opacity).toBe("1");
        expect(getComputedStyle(copyButton).pointerEvents).toBe("auto");
      });
      copyButton.focus();
      await parkPointer(4, 4);
      expect(document.activeElement).toBe(copyButton);
      expect(getComputedStyle(copyButton).opacity).toBe("1");
      await page.getByRole("button", { name: "Copy code", exact: true }).click();
      expect(clipboardWriteText).toHaveBeenCalledWith(`${source}\n`);

      await page.viewport(390, 844);
      await vi.waitFor(() => {
        expect(getPresentationTier()).toBe("phone");
        expect(document.querySelector(".chat-markdown-mermaid img")).toBeNull();
        expect(copyButton.isConnected).toBe(true);
        expect(document.activeElement).toBe(copyButton);
        expect(getComputedStyle(copyButton).opacity).toBe("1");
        expect(getComputedStyle(copyButton).pointerEvents).toBe("auto");
      });
    },
  );

  it("fires only the innermost recognizer on a nested long-press and keeps right-click working", async () => {
    mounted = await render(
      <>
        <ContextMenuActionSheetHost />
        <MessagesTimeline
          {...buildProps()}
          markdownCwd="/repo"
          timelineEntries={[
            {
              id: "message-2",
              kind: "message",
              createdAt: "2026-07-20T12:00:05.000Z",
              message: {
                id: ASSISTANT_MESSAGE_ID,
                role: "assistant" as const,
                text: "See [src/app.ts](src/app.ts) for details.",
                createdAt: "2026-07-20T12:00:05.000Z",
                completedAt: "2026-07-20T12:00:09.000Z",
                streaming: false,
              },
            },
          ]}
        />
      </>,
    );

    const anchor = await vi.waitFor(() => {
      const link = document.querySelector<HTMLAnchorElement>(".chat-markdown a");
      expect(link).not.toBeNull();
      return link!;
    });

    // The file-link recognizer (innermost) wins; the surrounding message
    // recognizer must not also fire, so exactly one sheet opens — the
    // file-link menu, not the message-actions sheet.
    await dispatchLongPress(anchor);
    await vi.waitFor(() => {
      expect(sheetRow("Open in editor")).not.toBeNull();
    });
    expect(document.querySelectorAll('[data-slot="sheet-popup"]')).toHaveLength(1);
    expect(sheetRow("Copy response")).toBeNull();

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => {
      expect(document.querySelector('[data-slot="sheet-popup"]')).toBeNull();
    });

    // The post-fire suppression self-heals: a later contextmenu on the same
    // link is not swallowed and presents the file actions again.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const rect = anchor.getBoundingClientRect();
    anchor.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 4,
        clientY: rect.top + 4,
      }),
    );
    await vi.waitFor(() => {
      expect(sheetRow("Open in editor")).not.toBeNull();
    });
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => {
      expect(document.querySelector('[data-slot="sheet-popup"]')).toBeNull();
    });
  });
});
