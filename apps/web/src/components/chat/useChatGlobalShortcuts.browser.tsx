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
  ...PANEL_SHORTCUTS.map(({ command, key }) => ({
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
  };
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
});
