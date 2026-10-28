import { usePaneEffect } from "./PaneFocus";
import type { ThreadReferenceCopyTarget } from "@ryco/client-runtime/state/threads";
import type { ProjectScript, ResolvedKeybindingsConfig, ThreadId } from "@ryco/contracts";
import { useCommandPaletteStore } from "../../commandPaletteStore";
import { isComposerFocused } from "../../lib/composerFocus";
import { isTerminalFocused } from "../../lib/terminalFocus";
import {
  resolveShortcutCommand,
  shouldIgnoreGlobalNavigationShortcut,
  shouldIgnoreSplitViewShortcut,
} from "../../keybindings";
import { projectScriptIdFromCommand } from "~/projectScripts";
import { preloadWorkspacePanel } from "../../workspacePanelPreload";
import type { ChatComposerHandle } from "./ChatComposer";

export interface UseChatGlobalShortcutsInput {
  activeThreadId: ThreadId | null;
  keybindings: ResolvedKeybindingsConfig;
  terminalOpen: boolean;
  activeTerminalId: string;
  readComposer: () => ChatComposerHandle | null;
  activeProject: { scripts: ReadonlyArray<ProjectScript> } | null | undefined;
  toggleTerminalVisibility: () => void;
  splitTerminal: () => void;
  closeTerminal: (terminalId: string) => void;
  createNewTerminal: () => void;
  setTerminalOpen: (open: boolean) => void;
  /** Whether the review surface is open, so `diff.toggle` preloads it only to open it. */
  diffOpen: boolean;
  onToggleDiff: () => void;
  onOpenFilesPanel: () => void;
  onOpenReviewPanel: () => void;
  onOpenTerminalPanel: () => void;
  onOpenSimulatorPanel: () => void;
  runProjectScript: (script: ProjectScript) => void | Promise<void>;
  /** Whether the composer offers Stop; `thread.interrupt` acts only then. */
  interruptAvailable: boolean;
  onInterruptTurn: () => void | Promise<void>;
  /** Null where there is nothing to copy (a draft); `thread.copyReference` acts only otherwise. */
  copyReferenceTarget: ThreadReferenceCopyTarget | null;
  onCopyReference: (target: ThreadReferenceCopyTarget) => void;
}

/**
 * Installs the global keydown listener that maps resolved keybinding commands
 * to terminal, workspace-panel, model-picker, and project-script actions for
 * the active thread. A workspace-panel shortcut starts the panel's chunks
 * before it navigates, so they load during the route commit rather than after
 * the panel mounts. Stopping the turn and copying the thread's reference also
 * run while typing, since neither edits text.
 */
export function useChatGlobalShortcuts(input: UseChatGlobalShortcutsInput): void {
  const {
    activeThreadId,
    keybindings,
    terminalOpen,
    activeTerminalId,
    readComposer,
    activeProject,
    toggleTerminalVisibility,
    splitTerminal,
    closeTerminal,
    createNewTerminal,
    setTerminalOpen,
    diffOpen,
    onToggleDiff,
    onOpenFilesPanel,
    onOpenReviewPanel,
    onOpenTerminalPanel,
    onOpenSimulatorPanel,
    runProjectScript,
    interruptAvailable,
    onInterruptTurn,
    copyReferenceTarget,
    onCopyReference,
  } = input;

  usePaneEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!activeThreadId || useCommandPaletteStore.getState().open || event.defaultPrevented) {
        return;
      }
      const modelPickerOpen = readComposer()?.isModelPickerOpen() ?? false;
      const shortcutContext = {
        terminalFocus: isTerminalFocused(),
        terminalOpen: Boolean(terminalOpen),
        modelPickerOpen,
        composerFocus: isComposerFocused(),
      };

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      // With nothing to stop or copy, the key is left to the browser. A held
      // key acts once.
      if (command === "thread.interrupt") {
        if (shouldIgnoreSplitViewShortcut(event) || !interruptAvailable) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) void onInterruptTurn();
        return;
      }

      if (command === "thread.copyReference") {
        if (shouldIgnoreSplitViewShortcut(event) || !copyReferenceTarget) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) onCopyReference(copyReferenceTarget);
        return;
      }

      if (
        shouldIgnoreGlobalNavigationShortcut(event) &&
        (command !== "modelPicker.toggle" || !modelPickerOpen)
      ) {
        return;
      }
      if (!command) return;

      if (command === "terminal.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleTerminalVisibility();
        return;
      }

      if (command === "terminal.split") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminal();
        return;
      }

      if (command === "terminal.close") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalOpen) return;
        closeTerminal(activeTerminalId);
        return;
      }

      if (command === "terminal.new") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalOpen) {
          setTerminalOpen(true);
        }
        createNewTerminal();
        return;
      }

      if (command === "diff.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (!diffOpen) preloadWorkspacePanel("review", { intent: true });
        onToggleDiff();
        return;
      }

      if (command === "workspace.files") {
        event.preventDefault();
        event.stopPropagation();
        preloadWorkspacePanel("files", { intent: true });
        onOpenFilesPanel();
        return;
      }

      if (command === "workspace.review") {
        event.preventDefault();
        event.stopPropagation();
        preloadWorkspacePanel("review", { intent: true });
        onOpenReviewPanel();
        return;
      }

      if (command === "workspace.terminal") {
        event.preventDefault();
        event.stopPropagation();
        preloadWorkspacePanel("terminal", { intent: true });
        onOpenTerminalPanel();
        return;
      }

      if (command === "workspace.simulator") {
        event.preventDefault();
        event.stopPropagation();
        preloadWorkspacePanel("simulator", { intent: true });
        onOpenSimulatorPanel();
        return;
      }

      if (command === "modelPicker.toggle") {
        event.preventDefault();
        event.stopPropagation();
        readComposer()?.toggleModelPicker();
        return;
      }

      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject) return;
      const script = activeProject.scripts.find((entry) => entry.id === scriptId);
      if (!script) return;
      event.preventDefault();
      event.stopPropagation();
      void runProjectScript(script);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [
    activeProject,
    terminalOpen,
    activeTerminalId,
    activeThreadId,
    closeTerminal,
    createNewTerminal,
    setTerminalOpen,
    runProjectScript,
    splitTerminal,
    keybindings,
    diffOpen,
    onToggleDiff,
    onOpenFilesPanel,
    onOpenReviewPanel,
    onOpenTerminalPanel,
    onOpenSimulatorPanel,
    readComposer,
    toggleTerminalVisibility,
    interruptAvailable,
    onInterruptTurn,
    copyReferenceTarget,
    onCopyReference,
  ]);
}
