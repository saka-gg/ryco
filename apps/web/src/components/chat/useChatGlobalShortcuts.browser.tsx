import { ThreadId, type ResolvedKeybindingsConfig } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { renderHook } from "vitest-browser-react";

const { preloadWorkspacePanel } = vi.hoisted(() => ({ preloadWorkspacePanel: vi.fn() }));
vi.mock("../../workspacePanelPreload", () => ({ preloadWorkspacePanel }));

import { useChatGlobalShortcuts, type UseChatGlobalShortcutsInput } from "./useChatGlobalShortcuts";

const PANEL_SHORTCUTS = [
  { command: "workspace.files", key: "f", mode: "files", handler: "onOpenFilesPanel" },
  { command: "workspace.review", key: "r", mode: "review", handler: "onOpenReviewPanel" },
  { command: "workspace.terminal", key: "t", mode: "terminal", handler: "onOpenTerminalPanel" },
  { command: "workspace.simulator", key: "s", mode: "simulator", handler: "onOpenSimulatorPanel" },
] as const;

const KEYBINDINGS: ResolvedKeybindingsConfig = [
  ...[
    ...PANEL_SHORTCUTS,
    { command: "thread.interrupt", key: "." },
    { command: "thread.copyReference", key: "c" },
  ].map(({ command, key }) => ({
    command,
    shortcut: { key, metaKey: false, ctrlKey: false, shiftKey: true, altKey: true, modKey: false },
  })),
  {
    command: "diff.toggle",
    shortcut: {
      key: "d",
      metaKey: false,
      ctrlKey: false,
      shiftKey: true,
      altKey: true,
      modKey: false,
    },
  },
];

function createInput(): UseChatGlobalShortcutsInput {
  return {
    activeThreadId: ThreadId.make("thread-shortcuts"),
    keybindings: KEYBINDINGS,
    terminalOpen: false,
    activeTerminalId: "default",
    readComposer: () => null,
    activeProject: null,
    toggleTerminalVisibility: vi.fn(),
    splitTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    createNewTerminal: vi.fn(),
    setTerminalOpen: vi.fn(),
    diffOpen: false,
    onToggleDiff: vi.fn(),
    onOpenFilesPanel: vi.fn(),
    onOpenReviewPanel: vi.fn(),
    onOpenTerminalPanel: vi.fn(),
    onOpenSimulatorPanel: vi.fn(),
    runProjectScript: vi.fn(),
    interruptAvailable: true,
    onInterruptTurn: vi.fn(),
    copyReferenceTarget: { kind: "thread", value: "thread-shortcuts" },
    onCopyReference: vi.fn(),
  };
}

/** Presses alt+shift+`key` in the focused composer-like field; returns whether it was consumed. */
function pressInEditable(
  key: string,
  init: KeyboardEventInit = {},
  options: { composer?: boolean } = {},
): boolean {
  const editable = document.createElement("div");
  editable.contentEditable = "true";
  if (options.composer) editable.dataset.testid = "composer-editor";
  document.body.append(editable);
  editable.focus();
  try {
    const event = new KeyboardEvent("keydown", {
      key,
      altKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    editable.dispatchEvent(event);
    return event.defaultPrevented;
  } finally {
    editable.remove();
  }
}

describe("useChatGlobalShortcuts", () => {
  afterEach(() => {
    preloadWorkspacePanel.mockReset();
  });

  it("starts a workspace panel's chunks before its shortcut navigates", async () => {
    const input = createInput();
    const hook = await renderHook(() => useChatGlobalShortcuts(input));

    try {
      for (const { key, mode, handler } of PANEL_SHORTCUTS) {
        preloadWorkspacePanel.mockClear();
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key, altKey: true, shiftKey: true, bubbles: true }),
        );

        const open = input[handler] as ReturnType<typeof vi.fn>;
        expect(preloadWorkspacePanel).toHaveBeenCalledExactlyOnceWith(mode, { intent: true });
        expect(open).toHaveBeenCalledOnce();
        expect(preloadWorkspacePanel.mock.invocationCallOrder[0]).toBeLessThan(
          open.mock.invocationCallOrder[0] ?? 0,
        );
      }
    } finally {
      await hook.unmount();
    }
  });

  it("starts the review chunks before the diff toggle opens it, and not when it closes", async () => {
    const input = createInput();
    const hook = await renderHook(() => useChatGlobalShortcuts(input));
    const toggle = input.onToggleDiff as ReturnType<typeof vi.fn>;

    try {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "d", altKey: true, shiftKey: true, bubbles: true }),
      );
      expect(preloadWorkspacePanel).toHaveBeenCalledExactlyOnceWith("review", { intent: true });
      expect(toggle).toHaveBeenCalledOnce();
      expect(preloadWorkspacePanel.mock.invocationCallOrder[0]).toBeLessThan(
        toggle.mock.invocationCallOrder[0] ?? 0,
      );
    } finally {
      await hook.unmount();
    }

    preloadWorkspacePanel.mockClear();
    const openInput = { ...createInput(), diffOpen: true };
    const openHook = await renderHook(() => useChatGlobalShortcuts(openInput));
    try {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "d", altKey: true, shiftKey: true, bubbles: true }),
      );
      expect(openInput.onToggleDiff).toHaveBeenCalledOnce();
      expect(preloadWorkspacePanel).not.toHaveBeenCalled();
    } finally {
      await openHook.unmount();
    }
  });

  it("stops the running turn while typing, once per press", async () => {
    const input = createInput();
    const hook = await renderHook(() => useChatGlobalShortcuts(input));

    try {
      expect(pressInEditable(".")).toBe(true);
      expect(pressInEditable(".", { repeat: true })).toBe(true);
      expect(input.onInterruptTurn).toHaveBeenCalledOnce();
    } finally {
      await hook.unmount();
    }
  });

  it("leaves the stop key alone with nothing to stop", async () => {
    const input = { ...createInput(), interruptAvailable: false };
    const hook = await renderHook(() => useChatGlobalShortcuts(input));

    try {
      expect(pressInEditable(".")).toBe(false);
      expect(input.onInterruptTurn).not.toHaveBeenCalled();
    } finally {
      await hook.unmount();
    }
  });

  it("copies the thread's reference while typing, and leaves the key alone without one", async () => {
    const input = createInput();
    const hook = await renderHook(() => useChatGlobalShortcuts(input));
    try {
      expect(pressInEditable("c")).toBe(true);
      expect(pressInEditable("c", { repeat: true })).toBe(true);
      expect(input.onCopyReference).toHaveBeenCalledExactlyOnceWith(input.copyReferenceTarget);
    } finally {
      await hook.unmount();
    }

    const draftInput = { ...createInput(), copyReferenceTarget: null };
    const draftHook = await renderHook(() => useChatGlobalShortcuts(draftInput));
    try {
      expect(pressInEditable("c")).toBe(false);
      expect(draftInput.onCopyReference).not.toHaveBeenCalled();
    } finally {
      await draftHook.unmount();
    }
  });

  it("scopes stop and copy to the composer by their when clause", async () => {
    const composerFocus = { type: "identifier", name: "composerFocus" } as const;
    for (const [whenAst, inComposer] of [
      [composerFocus, true],
      [{ type: "not", node: composerFocus }, false],
    ] as const) {
      const input = {
        ...createInput(),
        keybindings: KEYBINDINGS.map((rule) => ({ ...rule, whenAst })),
      };
      const hook = await renderHook(() => useChatGlobalShortcuts(input));
      try {
        expect(pressInEditable(".", {}, { composer: true })).toBe(inComposer);
        expect(pressInEditable("c", {}, { composer: true })).toBe(inComposer);
        expect(pressInEditable(".")).toBe(!inComposer);
        expect(pressInEditable("c")).toBe(!inComposer);
        expect(input.onInterruptTurn).toHaveBeenCalledOnce();
        expect(input.onCopyReference).toHaveBeenCalledOnce();
      } finally {
        await hook.unmount();
      }
    }
  });
});
