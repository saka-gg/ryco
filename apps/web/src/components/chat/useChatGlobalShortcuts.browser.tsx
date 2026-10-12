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

const KEYBINDINGS: ResolvedKeybindingsConfig = PANEL_SHORTCUTS.map(({ command, key }) => ({
  command,
  shortcut: { key, metaKey: false, ctrlKey: false, shiftKey: true, altKey: true, modKey: false },
}));

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
});
