import type { ProjectScript, ProjectScriptIcon, ResolvedKeybindingsConfig } from "@ryco/contracts";
import {
  BugIcon,
  FlaskConicalIcon,
  HammerIcon,
  ListChecksIcon,
  PlayIcon,
  WrenchIcon,
} from "lucide-react";
import React, {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  keybindingValueForCommand,
  decodeProjectScriptKeybindingRule,
} from "~/lib/projectScriptKeybindings";
import { commandForProjectScript, nextProjectScriptId } from "~/projectScripts";
import { DISCLOSURE_INNER_CLASS, disclosureShellClassName } from "~/lib/disclosureMotion";
import { cn, isMacPlatform } from "~/lib/utils";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import type { SurfaceMorph } from "./ui/surfaceMorph";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";

export const SCRIPT_ICONS: Array<{ id: ProjectScriptIcon; label: string }> = [
  { id: "play", label: "Play" },
  { id: "test", label: "Test" },
  { id: "lint", label: "Lint" },
  { id: "configure", label: "Configure" },
  { id: "build", label: "Build" },
  { id: "debug", label: "Debug" },
];

/**
 * Filled fields for the action dialog: tone instead of an outline, matching
 * the borderless dialog surface they sit on.
 */
const FILLED_FIELD_CLASS_NAME =
  "border-transparent bg-foreground/5 shadow-none before:hidden dark:bg-foreground/6 has-focus-visible:border-transparent has-focus-visible:bg-foreground/7 has-focus-visible:ring-2 has-focus-visible:ring-foreground/14";

/** The action dialog's surface: no border, separated by one soft shadow. */
export const ACTION_DIALOG_SURFACE_CLASS_NAME =
  "max-w-md border-0 shadow-[0_30px_60px_-20px_rgb(0_0_0/0.25)] before:hidden dark:shadow-[0_30px_70px_-18px_rgb(0_0_0/0.75)]";

/** How long a picked icon stays visible in the open row before it folds away. */
const ICON_ROW_SETTLE_MS = 320;

export function ScriptIcon({
  icon,
  className = "size-3.5",
}: {
  icon: ProjectScriptIcon;
  className?: string;
}) {
  if (icon === "test") return <FlaskConicalIcon className={className} />;
  if (icon === "lint") return <ListChecksIcon className={className} />;
  if (icon === "configure") return <WrenchIcon className={className} />;
  if (icon === "build") return <HammerIcon className={className} />;
  if (icon === "debug") return <BugIcon className={className} />;
  return <PlayIcon className={className} />;
}

export interface NewProjectScriptInput {
  name: string;
  command: string;
  icon: ProjectScriptIcon;
  runOnWorktreeCreate: boolean;
  keybinding: string | null;
}

function normalizeShortcutKeyToken(key: string): string | null {
  const normalized = key.toLowerCase();
  if (
    normalized === "meta" ||
    normalized === "control" ||
    normalized === "ctrl" ||
    normalized === "shift" ||
    normalized === "alt" ||
    normalized === "option"
  ) {
    return null;
  }
  if (normalized === " ") return "space";
  if (normalized === "escape") return "esc";
  if (normalized === "arrowup") return "arrowup";
  if (normalized === "arrowdown") return "arrowdown";
  if (normalized === "arrowleft") return "arrowleft";
  if (normalized === "arrowright") return "arrowright";
  if (normalized.length === 1) return normalized;
  if (normalized.startsWith("f") && normalized.length <= 3) return normalized;
  if (normalized === "enter" || normalized === "tab" || normalized === "backspace") {
    return normalized;
  }
  if (normalized === "delete" || normalized === "home" || normalized === "end") {
    return normalized;
  }
  if (normalized === "pageup" || normalized === "pagedown") return normalized;
  return null;
}

function keybindingFromEvent(event: KeyboardEvent<HTMLInputElement>): string | null {
  const keyToken = normalizeShortcutKeyToken(event.key);
  if (!keyToken) return null;

  const parts: string[] = [];
  if (isMacPlatform(navigator.platform)) {
    if (event.metaKey) parts.push("mod");
    if (event.ctrlKey) parts.push("ctrl");
  } else {
    if (event.ctrlKey) parts.push("mod");
    if (event.metaKey) parts.push("meta");
  }
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  if (parts.length === 0) {
    return null;
  }
  parts.push(keyToken);
  return parts.join("+");
}

export interface ProjectScriptDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * Changes each time the dialog is opened; the form resets to `script` (or
   * to a blank action) when it does.
   */
  readonly session: number;
  /** The action being edited, or null to add one. */
  readonly script: ProjectScript | null;
  /** The project's actions, for a new action's id. */
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly keybindings: ResolvedKeybindingsConfig;
  /** Where the dialog grows from and folds into; see `SurfaceMorph`. */
  readonly morph: SurfaceMorph;
  /** Saves the action; reject to keep the dialog open with the error shown. */
  readonly onSave: (
    input: NewProjectScriptInput,
    editingScriptId: string | null,
  ) => Promise<void> | void;
  /** Runs after a save succeeds and before the dialog closes, with the saved id. */
  readonly onSaved?: (scriptId: string) => void;
  readonly onDelete: (scriptId: string) => Promise<void> | void;
}

/**
 * Add or edit one project action: a name-as-title header with its icon tile,
 * an inline icon row, the command, an optional shortcut and whether it runs on
 * new worktrees. Deleting confirms in a dialog that grows from the button.
 * Shared by the chat header's run control and the projects page.
 */
export function ProjectScriptDialog(props: ProjectScriptDialogProps) {
  const formId = React.useId();
  const iconRowId = React.useId();
  const editingScriptId = props.script?.id ?? null;
  const isEditing = editingScriptId !== null;
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [icon, setIcon] = useState<ProjectScriptIcon>("play");
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [runOnWorktreeCreate, setRunOnWorktreeCreate] = useState(false);
  const [keybinding, setKeybinding] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  // A new session starts from the action being edited (or a blank one).
  const [session, setSession] = useState<number | null>(null);
  if (session !== props.session) {
    setSession(props.session);
    setName(props.script?.name ?? "");
    setCommand(props.script?.command ?? "");
    setIcon(props.script?.icon ?? "play");
    setIconPickerOpen(false);
    setRunOnWorktreeCreate(props.script?.runOnWorktreeCreate ?? false);
    setKeybinding(
      props.script
        ? (keybindingValueForCommand(props.keybindings, commandForProjectScript(props.script.id)) ??
            "")
        : "",
    );
    setValidationError(null);
    setDeleteConfirmOpen(false);
  }

  const deleteButtonRef = useRef<HTMLButtonElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const iconRowRef = useRef<HTMLDivElement | null>(null);
  const iconSelectionRef = useRef<HTMLSpanElement | null>(null);
  const iconRowTimerRef = useRef<number | null>(null);
  const deleteConfirmedRef = useRef(false);
  const deleteConfirmMorph: SurfaceMorph = {
    origin: () => deleteButtonRef.current,
    // Confirming closes the parent too, so there is no button to fold into.
    target: () => (deleteConfirmedRef.current ? null : deleteButtonRef.current),
  };

  const captureKeybinding = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") return;
    event.preventDefault();
    if (event.key === "Backspace" || event.key === "Delete") {
      setKeybinding("");
      return;
    }
    const next = keybindingFromEvent(event);
    if (!next) return;
    setKeybinding(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    if (trimmedName.length === 0) {
      setValidationError("Name is required.");
      return;
    }
    if (trimmedCommand.length === 0) {
      setValidationError("Command is required.");
      return;
    }

    setValidationError(null);
    try {
      const scriptIdForValidation =
        editingScriptId ??
        nextProjectScriptId(
          trimmedName,
          props.scripts.map((script) => script.id),
        );
      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding,
        command: commandForProjectScript(scriptIdForValidation),
      });
      const payload = {
        name: trimmedName,
        command: trimmedCommand,
        icon,
        runOnWorktreeCreate,
        keybinding: keybindingRule?.key ?? null,
      } satisfies NewProjectScriptInput;
      await props.onSave(payload, editingScriptId);
      props.onSaved?.(scriptIdForValidation);
      props.onOpenChange(false);
      setIconPickerOpen(false);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : "Failed to save action.");
    }
  };

  const confirmDeleteScript = useCallback(() => {
    if (!editingScriptId) return;
    deleteConfirmedRef.current = true;
    setDeleteConfirmOpen(false);
    props.onOpenChange(false);
    void props.onDelete(editingScriptId);
  }, [editingScriptId, props]);

  // The selection pill sits under the checked icon and slides when it changes.
  // The row mounts with the dialog, so the pill is placed (without a slide)
  // each time the row opens, then slides between icons while it stays open.
  const iconRowWasOpenRef = useRef(false);
  useLayoutEffect(() => {
    const opening = iconPickerOpen && !iconRowWasOpenRef.current;
    iconRowWasOpenRef.current = iconPickerOpen;
    if (!iconPickerOpen) return;
    const pill = iconSelectionRef.current;
    const checked = iconRowRef.current?.querySelector<HTMLElement>(
      `[role="radio"][data-icon="${icon}"]`,
    );
    if (!pill || !checked) return;
    if (opening) pill.style.transition = "none";
    pill.style.width = `${checked.offsetWidth}px`;
    pill.style.height = `${checked.offsetHeight}px`;
    pill.style.translate = `${checked.offsetLeft}px ${checked.offsetTop}px`;
    if (opening) {
      void pill.offsetWidth;
      pill.style.removeProperty("transition");
    }
  }, [icon, iconPickerOpen]);

  useEffect(
    () => () => {
      if (iconRowTimerRef.current !== null) window.clearTimeout(iconRowTimerRef.current);
    },
    [],
  );

  const pickIcon = (next: ProjectScriptIcon) => {
    setIcon(next);
    if (iconRowTimerRef.current !== null) window.clearTimeout(iconRowTimerRef.current);
    iconRowTimerRef.current = window.setTimeout(() => {
      iconRowTimerRef.current = null;
      setIconPickerOpen(false);
    }, ICON_ROW_SETTLE_MS);
  };

  const onIconRowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = SCRIPT_ICONS.findIndex((entry) => entry.id === icon);
    const next = SCRIPT_ICONS[(index + step + SCRIPT_ICONS.length) % SCRIPT_ICONS.length];
    if (!next) return;
    setIcon(next.id);
    iconRowRef.current
      ?.querySelector<HTMLElement>(`[role="radio"][data-icon="${next.id}"]`)
      ?.focus();
  };

  return (
    <>
      <Dialog
        onOpenChange={(open) => {
          props.onOpenChange(open);
          if (!open) {
            setIconPickerOpen(false);
          }
        }}
        onOpenChangeComplete={(open) => {
          if (open) {
            deleteConfirmedRef.current = false;
          }
        }}
        open={props.open}
      >
        <DialogPopup
          morph={props.morph}
          initialFocus={nameInputRef}
          className={ACTION_DIALOG_SURFACE_CLASS_NAME}
        >
          <div data-slot="dialog-header" className="flex items-center gap-3 pt-5 pb-3 ps-5 pe-12">
            <button
              type="button"
              aria-label="Choose icon"
              aria-expanded={iconPickerOpen}
              aria-controls={iconRowId}
              className="grid size-11 shrink-0 place-items-center rounded-xl bg-foreground/6 text-foreground outline-none transition-[background-color,box-shadow,scale] duration-(--app-motion-duration-chip) hover:bg-foreground/9 focus-visible:ring-2 focus-visible:ring-ring active:scale-95 aria-expanded:ring-2 aria-expanded:ring-foreground/18"
              onClick={() => setIconPickerOpen((open) => !open)}
            >
              <span key={icon} className="app-icon-swap grid place-items-center">
                <ScriptIcon icon={icon} className="size-5" />
              </span>
            </button>
            <div className="min-w-0 flex-1">
              <DialogTitle className="sr-only">
                {isEditing ? "Edit action" : "Add action"}
              </DialogTitle>
              <input
                ref={nameInputRef}
                id="script-name"
                form={formId}
                aria-label="Name"
                autoComplete="off"
                placeholder="Name this action"
                className="w-full min-w-0 bg-transparent font-heading font-semibold text-lg leading-7 tracking-tight outline-none placeholder:text-muted-foreground/60"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <DialogDescription className="truncate text-xs">
                Runs from the top bar or its shortcut, in this project only.
              </DialogDescription>
            </div>
          </div>
          <div id={iconRowId} className={disclosureShellClassName(iconPickerOpen)}>
            <div className={DISCLOSURE_INNER_CLASS}>
              <div
                ref={iconRowRef}
                role="radiogroup"
                aria-label="Icon"
                className="relative mx-5 mb-2 grid grid-cols-6 gap-1"
                onKeyDown={onIconRowKeyDown}
              >
                <span
                  ref={iconSelectionRef}
                  aria-hidden
                  className="pointer-events-none absolute top-0 left-0 rounded-xl bg-primary transition-[translate,width] duration-(--app-motion-duration-stack) ease-(--app-motion-spring-snappy)"
                />
                {SCRIPT_ICONS.map((entry, index) => {
                  const isSelected = entry.id === icon;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      data-icon={entry.id}
                      tabIndex={iconPickerOpen && isSelected ? 0 : -1}
                      className={cn(
                        "relative flex h-14 flex-col items-center justify-center gap-1 rounded-xl text-xs outline-none transition-[color,opacity,translate] duration-(--app-motion-duration-stack) ease-(--app-motion-spring-gentle) focus-visible:ring-2 focus-visible:ring-ring",
                        isSelected
                          ? "text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground",
                        iconPickerOpen ? "translate-y-0 opacity-100" : "-translate-y-1.5 opacity-0",
                      )}
                      style={{ transitionDelay: iconPickerOpen ? `${40 + index * 28}ms` : "0ms" }}
                      onClick={() => pickIcon(entry.id)}
                    >
                      <ScriptIcon icon={entry.id} className="size-4" />
                      <span>{entry.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <DialogPanel>
            <form id={formId} className="space-y-4" onSubmit={submit}>
              <div className="space-y-1.5">
                <Label htmlFor="script-command">Command</Label>
                <Textarea
                  id="script-command"
                  className={FILLED_FIELD_CLASS_NAME}
                  placeholder="bun test"
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="script-keybinding">Keybinding</Label>
                <Input
                  id="script-keybinding"
                  className={FILLED_FIELD_CLASS_NAME}
                  placeholder="Press shortcut"
                  value={keybinding}
                  readOnly
                  onKeyDown={captureKeybinding}
                />
                <p className="text-xs text-muted-foreground">
                  Press a shortcut. Use <code>Backspace</code> to clear.
                </p>
              </div>
              <label className="flex items-center justify-between gap-3 text-sm">
                <span className="flex flex-col">
                  <span>Run on new worktrees</span>
                  <span className="text-xs text-muted-foreground">
                    Runs once, right after a worktree is created.
                  </span>
                </span>
                <Switch
                  checked={runOnWorktreeCreate}
                  onCheckedChange={(checked) => setRunOnWorktreeCreate(Boolean(checked))}
                />
              </label>
              {validationError && <p className="text-sm text-destructive">{validationError}</p>}
            </form>
          </DialogPanel>
          <DialogFooter variant="bare">
            {isEditing && (
              <Button
                ref={deleteButtonRef}
                type="button"
                variant="destructive-outline"
                className="mr-auto"
                onClick={() => setDeleteConfirmOpen(true)}
              >
                Delete
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                props.onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button form={formId} type="submit">
              {isEditing ? "Save changes" : "Save action"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogPopup
          morph={deleteConfirmMorph}
          className={cn(ACTION_DIALOG_SURFACE_CLASS_NAME, "max-w-sm")}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Delete action "{name}"?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter variant="bare">
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={confirmDeleteScript}>
              Delete action
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
