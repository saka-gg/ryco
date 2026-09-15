import { usePaneEffect } from "./PaneFocus";
import type { ProjectScript, ResolvedKeybindingsConfig, ThreadId } from "@ryco/contracts";
import { useCommandPaletteStore } from "../../commandPaletteStore";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { resolveShortcutCommand, shouldIgnoreGlobalNavigationShortcut } from "../../keybindings";
import { projectScriptIdFromCommand } from "~/projectScripts";
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
  onToggleDiff: () => void;
  onOpenFilesPanel: () => void;
  onOpenReviewPanel: () => void;
  onOpenTerminalPanel: () => void;
  onOpenSimulatorPanel: () => void;
  runProjectScript: (script: ProjectScript) => void | Promise<void>;
}

/**
 * Installs the global keydown listener that maps resolved keybinding commands
 * to terminal, workspace-panel, model-picker, and project-script actions for
 * the active thread.
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
    onToggleDiff,
    onOpenFilesPanel,
    onOpenReviewPanel,
    onOpenTerminalPanel,
    onOpenSimulatorPanel,
    runProjectScript,
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
      };

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
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
        onToggleDiff();
        return;
      }

      if (command === "workspace.files") {
        event.preventDefault();
        event.stopPropagation();
        onOpenFilesPanel();
        return;
      }

      if (command === "workspace.review") {
        event.preventDefault();
        event.stopPropagation();
        onOpenReviewPanel();
        return;
      }

      if (command === "workspace.terminal") {
        event.preventDefault();
        event.stopPropagation();
        onOpenTerminalPanel();
        return;
      }

      if (command === "workspace.simulator") {
        event.preventDefault();
        event.stopPropagation();
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
    onToggleDiff,
    onOpenFilesPanel,
    onOpenReviewPanel,
    onOpenTerminalPanel,
    onOpenSimulatorPanel,
    readComposer,
    toggleTerminalVisibility,
  ]);
}
