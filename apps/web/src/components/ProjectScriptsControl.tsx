import type { ProjectScript, ResolvedKeybindingsConfig, ScopedThreadRef } from "@ryco/contracts";
import { ChevronDownIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { preloadableLazy, useLazyComponentReady } from "~/lib/preloadableLazy";
import { commandForProjectScript, primaryProjectScript } from "~/projectScripts";
import { shortcutLabelForCommand } from "~/keybindings";
import { Button } from "./ui/button";
import {
  HEADER_CHROME_BUTTON_CLASS_NAME,
  HEADER_CHROME_GROUP_CLASS_NAME,
  HEADER_CHROME_ICON_BUTTON_CLASS_NAME,
} from "./chat/headerChrome";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "./ui/menu";
import type { SurfaceMorph } from "./ui/surfaceMorph";
import { notifySurfaceLoadFailure } from "./ui/surfaceLoadFailure";
import type { NewProjectScriptInput } from "./ProjectScriptDialog";
import { ScriptIcon } from "./ScriptIcon";

export type { NewProjectScriptInput } from "./ProjectScriptDialog";

/**
 * The add/edit action dialog loads on demand rather than with every thread:
 * its chunk starts loading as soon as something that opens it is reached (the
 * scripts menu's trigger or the Add action button, or the menu opening), so
 * by the click it is usually there and the dialog grows out of that control in
 * the same commit.
 */
const LazyProjectScriptDialog = preloadableLazy(() =>
  import("./ProjectScriptDialog").then((module) => module.ProjectScriptDialog),
);

function preloadProjectScriptDialog(): void {
  void LazyProjectScriptDialog.preload();
}

function isSameThread(a: ScopedThreadRef | null, b: ScopedThreadRef | null): boolean {
  return a?.environmentId === b?.environmentId && a?.threadId === b?.threadId;
}

interface ProjectScriptsControlProps {
  scripts: ProjectScript[];
  keybindings: ResolvedKeybindingsConfig;
  preferredScriptId?: string | null;
  onRunScript: (script: ProjectScript) => void;
  onAddScript: (input: NewProjectScriptInput) => Promise<void> | void;
  onUpdateScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void> | void;
  onDeleteScript: (scriptId: string) => Promise<void> | void;
  /**
   * The thread whose header holds this control. The header follows plain
   * thread switches, so a failed dialog load's toast shows only while that
   * thread is open: its Retry never opens one project's action over another
   * project's thread.
   */
  threadRef?: ScopedThreadRef | null;
}

export default function ProjectScriptsControl({
  scripts,
  keybindings,
  preferredScriptId = null,
  onRunScript,
  onAddScript,
  onUpdateScript,
  onDeleteScript,
  threadRef = null,
}: ProjectScriptsControlProps) {
  const [editingScript, setEditingScript] = useState<ProjectScript | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogSession, setDialogSession] = useState(0);
  // Mounted from the first open on, so every later close still folds and every
  // later open grows. It mounts once its chunk is in, never on a fallback. A
  // failed load lets the open go (the next open, or the toast's Retry, loads
  // again).
  const [dialogWanted, setDialogWanted] = useState(false);
  if (dialogOpen && !dialogWanted) setDialogWanted(true);

  // Morph anchors. The dialog grows out of whatever opened it (the Add action
  // button, or the scripts menu) and folds into where the saved action now
  // lives: the run button when it became the primary script, otherwise the
  // menu it was filed into.
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const primaryButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const morphOriginRef = useRef<HTMLElement | null>(null);
  const savedScriptIdRef = useRef<string | null>(null);
  // The thread the open dialog was asked for (see `threadRef`).
  const [dialogThread, setDialogThread] = useState<ScopedThreadRef | null>(null);

  // Resolved lazily by the morph (on open and as the close starts), so these
  // only read refs; their identity does not matter to the dialog.
  const dialogMorph: SurfaceMorph = {
    origin: () => morphOriginRef.current,
    target: () => {
      const savedId = savedScriptIdRef.current;
      if (savedId !== null) {
        const primary = primaryButtonRef.current;
        if (primary?.dataset.scriptId === savedId) return primary;
        return menuTriggerRef.current ?? addButtonRef.current;
      }
      const origin = morphOriginRef.current;
      if (origin?.isConnected) return origin;
      return menuTriggerRef.current ?? addButtonRef.current;
    },
  };

  const primaryScript = useMemo(() => {
    if (preferredScriptId) {
      const preferred = scripts.find((script) => script.id === preferredScriptId);
      if (preferred) return preferred;
    }
    return primaryProjectScript(scripts);
  }, [preferredScriptId, scripts]);
  const dropdownItemClassName =
    "data-highlighted:bg-transparent data-highlighted:text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground data-highlighted:hover:bg-accent data-highlighted:hover:text-accent-foreground data-highlighted:focus-visible:bg-accent data-highlighted:focus-visible:text-accent-foreground";

  /** The menu popup is closing as the dialog opens, so the dialog grows out of it. */
  const morphOriginFrom = (element: HTMLElement): HTMLElement =>
    element.closest<HTMLElement>('[data-slot="menu-popup"]') ?? element;

  /** With no origin (a toast's Retry), the dialog grows out of the header control. */
  const openDialog = (
    script: ProjectScript | null,
    origin: HTMLElement | null,
    forThread: ScopedThreadRef | null,
  ) => {
    morphOriginRef.current = origin
      ? morphOriginFrom(origin)
      : (menuTriggerRef.current ?? addButtonRef.current);
    savedScriptIdRef.current = null;
    setDialogThread(forThread);
    setEditingScript(script);
    setDialogSession((session) => session + 1);
    setDialogOpen(true);
  };
  const openAddDialog = (origin: HTMLElement) => openDialog(null, origin, threadRef);
  const openEditDialog = (script: ProjectScript, origin: HTMLElement) =>
    openDialog(script, origin, threadRef);

  const dialogReady = useLazyComponentReady(LazyProjectScriptDialog, dialogWanted, {
    onLoadError: (error) => {
      // Retry reopens the same action for the same thread, whatever the
      // control has shown since.
      const script = editingScript;
      const forThread = dialogThread;
      setDialogOpen(false);
      setDialogWanted(false);
      notifySurfaceLoadFailure(
        "action dialog",
        error,
        () => {
          // This control may have remounted since (a draft that became a
          // server thread): the reopen then reaches nobody, so load again
          // anyway and the next open is instant.
          preloadProjectScriptDialog();
          openDialog(script, null, forThread);
        },
        forThread,
      );
    },
  });
  // An open still waiting for its chunk is dropped when the header moves to
  // another thread, so it never opens one project's action over another's.
  if (dialogOpen && !dialogReady && !isSameThread(threadRef, dialogThread)) {
    setDialogOpen(false);
    setDialogWanted(false);
  }

  return (
    <>
      {primaryScript ? (
        <div aria-label="Project scripts" className={HEADER_CHROME_GROUP_CLASS_NAME} role="group">
          <Button
            ref={primaryButtonRef}
            data-script-id={primaryScript.id}
            size="xs"
            variant="ghost"
            className={HEADER_CHROME_BUTTON_CLASS_NAME}
            onClick={() => onRunScript(primaryScript)}
            title={`Run ${primaryScript.name}`}
          >
            <ScriptIcon icon={primaryScript.icon} />
            <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
              {primaryScript.name}
            </span>
          </Button>
          <Menu
            highlightItemOnHover={false}
            // Also an open that came without hover or focus on the trigger.
            onOpenChange={(open) => {
              if (open) preloadProjectScriptDialog();
            }}
          >
            <MenuTrigger
              render={
                <Button
                  ref={menuTriggerRef}
                  size="icon-xs"
                  variant="ghost"
                  className={HEADER_CHROME_ICON_BUTTON_CLASS_NAME}
                  aria-label="Script actions"
                  onPointerEnter={preloadProjectScriptDialog}
                  onFocus={preloadProjectScriptDialog}
                />
              }
            >
              <ChevronDownIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              {scripts.map((script) => {
                const shortcutLabel = shortcutLabelForCommand(
                  keybindings,
                  commandForProjectScript(script.id),
                );
                return (
                  <MenuItem
                    key={script.id}
                    className={`group ${dropdownItemClassName}`}
                    onClick={() => onRunScript(script)}
                  >
                    <ScriptIcon icon={script.icon} className="size-4" />
                    <span className="truncate">
                      {script.runOnWorktreeCreate ? `${script.name} (setup)` : script.name}
                    </span>
                    <span className="relative ms-auto flex h-6 min-w-6 items-center justify-end">
                      {shortcutLabel && (
                        <MenuShortcut className="ms-0 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0">
                          {shortcutLabel}
                        </MenuShortcut>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="absolute right-0 top-1/2 size-6 -translate-y-1/2 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-visible:opacity-100 group-focus-visible:pointer-events-auto"
                        aria-label={`Edit ${script.name}`}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          openEditDialog(script, event.currentTarget);
                        }}
                      >
                        <SettingsIcon className="size-3.5" />
                      </Button>
                    </span>
                  </MenuItem>
                );
              })}
              <MenuItem
                className={dropdownItemClassName}
                onClick={(event) => openAddDialog(event.currentTarget)}
              >
                <PlusIcon className="size-4" />
                Add action
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      ) : (
        <Button
          ref={addButtonRef}
          size="xs"
          variant="ghost"
          className={HEADER_CHROME_BUTTON_CLASS_NAME}
          onPointerEnter={preloadProjectScriptDialog}
          onFocus={preloadProjectScriptDialog}
          onClick={(event) => openAddDialog(event.currentTarget)}
          title="Add action"
        >
          <PlusIcon className="size-3.5" />
          <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
            Add action
          </span>
        </Button>
      )}

      {dialogWanted && dialogReady ? (
        <LazyProjectScriptDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          session={dialogSession}
          script={editingScript}
          scripts={scripts}
          keybindings={keybindings}
          morph={dialogMorph}
          onSave={(input, editingScriptId) =>
            editingScriptId ? onUpdateScript(editingScriptId, input) : onAddScript(input)
          }
          onSaved={(scriptId) => {
            savedScriptIdRef.current = scriptId;
          }}
          onDelete={onDeleteScript}
        />
      ) : null}
    </>
  );
}
