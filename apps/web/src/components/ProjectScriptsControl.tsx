import type { ProjectScript, ResolvedKeybindingsConfig } from "@ryco/contracts";
import { ChevronDownIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

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
import { ProjectScriptDialog, ScriptIcon, type NewProjectScriptInput } from "./ProjectScriptDialog";

export type { NewProjectScriptInput } from "./ProjectScriptDialog";

interface ProjectScriptsControlProps {
  scripts: ProjectScript[];
  keybindings: ResolvedKeybindingsConfig;
  preferredScriptId?: string | null;
  onRunScript: (script: ProjectScript) => void;
  onAddScript: (input: NewProjectScriptInput) => Promise<void> | void;
  onUpdateScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void> | void;
  onDeleteScript: (scriptId: string) => Promise<void> | void;
}

export default function ProjectScriptsControl({
  scripts,
  keybindings,
  preferredScriptId = null,
  onRunScript,
  onAddScript,
  onUpdateScript,
  onDeleteScript,
}: ProjectScriptsControlProps) {
  const [editingScript, setEditingScript] = useState<ProjectScript | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogSession, setDialogSession] = useState(0);

  // Morph anchors. The dialog grows out of whatever opened it (the Add action
  // button, or the scripts menu) and folds into where the saved action now
  // lives: the run button when it became the primary script, otherwise the
  // menu it was filed into.
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const primaryButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const morphOriginRef = useRef<HTMLElement | null>(null);
  const savedScriptIdRef = useRef<string | null>(null);

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

  const openDialog = (script: ProjectScript | null, origin: HTMLElement) => {
    morphOriginRef.current = morphOriginFrom(origin);
    savedScriptIdRef.current = null;
    setEditingScript(script);
    setDialogSession((session) => session + 1);
    setDialogOpen(true);
  };
  const openAddDialog = (origin: HTMLElement) => openDialog(null, origin);
  const openEditDialog = (script: ProjectScript, origin: HTMLElement) => openDialog(script, origin);

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
          <Menu highlightItemOnHover={false}>
            <MenuTrigger
              render={
                <Button
                  ref={menuTriggerRef}
                  size="icon-xs"
                  variant="ghost"
                  className={HEADER_CHROME_ICON_BUTTON_CLASS_NAME}
                  aria-label="Script actions"
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
          onClick={(event) => openAddDialog(event.currentTarget)}
          title="Add action"
        >
          <PlusIcon className="size-3.5" />
          <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
            Add action
          </span>
        </Button>
      )}

      <ProjectScriptDialog
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
    </>
  );
}
