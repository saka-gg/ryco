import { ChevronDownIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "../../../lib/utils";
import { RollingText } from "../../chat/RollingText";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Button } from "../../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { KeyHint } from "../primitives";
import { usePullRequestSelection } from "../PullRequestsPageContext";
import type { PullRequestsTab } from "../pullRequestsSearch";
import { usePullRequestsShortcut } from "../pullRequestsShortcuts";
import { MergeThroughPopover } from "./MergeThroughPopover";
import {
  MERGE_METHOD_CONFIRM,
  MERGE_METHOD_HINT,
  type NextActionCommand,
  type NextActionMenuItem,
} from "./mergeFacts.logic";
import { PENDING_LABEL, useMergeCommands, type MergeCommands } from "./useMergeCommands";
import { useMergeModel, type MergeModel } from "./useMergeModel";

/** How long the first merge click waits for its confirmation. */
const MERGE_CONFIRM_WINDOW_MS = 4000;

const SIZE_CLASS = {
  sm: "h-7 px-2.5 text-xs",
  default: "h-8 px-3 text-[13px]",
} as const;

const TRIGGER_SIZE_CLASS = {
  sm: "h-7 w-6",
  default: "h-8 w-7",
} as const;

/** Fill and outline trade places as the step moves between the viewer and others. */
const MORPH_CLASS =
  "transition-[background-color,border-color,color,box-shadow,opacity] duration-(--app-motion-duration-chip) ease-(--app-motion-ease)";

/**
 * The next step as a single button (plus a menu with every other lifecycle
 * step), for the bar off Conversation. `M` opens the menu. It stays on every
 * tab — off Conversation its label is the verdict's only home (spec §7) — even
 * when its step points at the tab already open (e.g. "View failing check" on
 * Checks still reveals and flashes the failing job).
 */
export function NextActionButton(props: { readonly size?: "sm" | "default" }) {
  const model = useMergeModel();
  const commands = useMergeCommands(model);
  if (!model) return null;
  return <NextActionControl model={model} commands={commands} size={props.size ?? "default"} />;
}

/**
 * The split button behind both homes of the next action (rail and bar). The
 * label rolls when the step changes and the width follows the new label;
 * merging takes a second click within four seconds. A merge picked from the
 * menu arms the same confirmation on the button, so every merge is two
 * deliberate clicks against the head the page shows.
 */
export function NextActionControl(props: {
  readonly model: MergeModel;
  readonly commands: MergeCommands;
  readonly size: "sm" | "default";
  /** Register `M` only while this tab shows (the rail lives on Conversation). */
  readonly shortcutTab?: PullRequestsTab | undefined;
  readonly className?: string | undefined;
}) {
  const { model, commands, size } = props;
  const selection = usePullRequestSelection();
  const button = model.button;
  const groupRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [mergeThroughOpen, setMergeThroughOpen] = useState(false);
  const menu = model.menu;
  // Armed for one head, and only while a merge is still offered (the button
  // or the menu): new commits or a new step never inherit a confirmation.
  const mergeOffered =
    button?.command.type === "merge" || menu.items.some((item) => item.command.type === "merge");
  const armKey = mergeOffered ? `merge@${selection.headSha ?? ""}` : null;
  const [armedFor, setArmedFor] = useState<string | null>(null);
  const armed = armedFor !== null && armedFor === armKey;
  useEffect(() => {
    if (armedFor === null) return;
    const timer = window.setTimeout(() => setArmedFor(null), MERGE_CONFIRM_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [armedFor]);

  const hasMenu = menu.methods !== null || menu.items.length > 0;
  usePullRequestsShortcut(
    "m",
    () => {
      if (!hasMenu) return false;
      setMenuOpen(true);
    },
    {
      enabled: hasMenu && button !== null,
      ...(props.shortcutTab ? { tab: props.shortcutTab } : {}),
    },
  );

  if (!button) return null;

  const pendingLabel = commands.pending ? PENDING_LABEL[commands.pending] : undefined;
  const label = pendingLabel ?? (armed ? MERGE_METHOD_CONFIRM[model.method] : button.label);
  // While armed the button is the merge confirmation, whatever step it showed.
  const filled = armed || button.variant === "filled";
  const disabledReason = armed ? null : button.disabledReason;
  const inert = disabledReason !== null || commands.pending !== null;

  const runPrimary = () => {
    if (inert) return;
    if (armed) {
      setArmedFor(null);
      void commands.run({ type: "merge" });
      return;
    }
    switch (button.command.type) {
      case "merge":
        setArmedFor(armKey);
        return;
      case "merge-stack":
        setMergeThroughOpen(true);
        return;
      default:
        void commands.run(button.command);
    }
  };

  const runMenuItem = (command: NextActionCommand) => {
    setMenuOpen(false);
    if (command.type === "close") {
      setConfirmClose(true);
      return;
    }
    if (command.type === "merge-stack") {
      setMergeThroughOpen(true);
      return;
    }
    if (command.type === "merge") {
      // The button rolls to the confirmation; the merge waits for that click.
      setArmedFor(armKey);
      return;
    }
    void commands.run(command);
  };

  const primary = (
    <Button
      variant={filled ? "default" : "outline"}
      aria-disabled={inert || undefined}
      data-armed={armed || undefined}
      onClick={runPrimary}
      className={cn(
        SIZE_CLASS[size],
        MORPH_CLASS,
        "min-w-0 gap-1.5 font-medium",
        hasMenu && "rounded-r-none before:rounded-r-none",
        disabledReason !== null && "cursor-not-allowed opacity-64",
      )}
    >
      <RollingText text={label} className="min-w-0" />
    </Button>
  );

  return (
    <>
      <div
        ref={groupRef}
        data-next-action={button.command.type}
        className={cn("inline-flex max-w-full items-stretch", props.className)}
      >
        {disabledReason ? (
          <Tooltip>
            <TooltipTrigger render={primary} />
            <TooltipPopup side="bottom" sideOffset={6} className="max-w-64">
              {disabledReason}
            </TooltipPopup>
          </Tooltip>
        ) : (
          primary
        )}
        {hasMenu ? (
          <Menu open={menuOpen} onOpenChange={setMenuOpen}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <MenuTrigger
                    render={
                      <Button
                        variant={filled ? "default" : "outline"}
                        aria-label="More merge options"
                        className={cn(
                          TRIGGER_SIZE_CLASS[size],
                          MORPH_CLASS,
                          "rounded-l-none px-0 before:rounded-l-none",
                          filled ? "ml-px" : "-ml-px",
                        )}
                      />
                    }
                  />
                }
              >
                <ChevronDownIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom" sideOffset={6}>
                <span className="inline-flex items-center gap-1.5">
                  More options
                  <KeyHint>M</KeyHint>
                </span>
              </TooltipPopup>
            </Tooltip>
            <NextActionMenuPopup model={model} onRun={runMenuItem} />
          </Menu>
        ) : null}
      </div>
      <MergeThroughPopover
        open={mergeThroughOpen}
        onOpenChange={setMergeThroughOpen}
        anchor={groupRef}
        initialThrough={selection.number}
        align={size === "sm" ? "end" : "start"}
      />
      <CloseConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        number={selection.number}
        pending={commands.pending === "close"}
        onConfirm={async () => {
          await commands.run({ type: "close" });
          setConfirmClose(false);
        }}
      />
    </>
  );
}

function MenuItemBody(props: { readonly label: string; readonly hint: string | null }) {
  return (
    <span className="flex min-w-0 flex-col py-0.5">
      <span className="truncate">{props.label}</span>
      {props.hint ? (
        <span className="truncate text-xs text-muted-foreground">{props.hint}</span>
      ) : null}
    </span>
  );
}

/**
 * Merge method, delete-branch, then the other lifecycle steps. Never repeats
 * what the button already does (the model leaves that item out).
 */
function NextActionMenuPopup(props: {
  readonly model: MergeModel;
  readonly onRun: (command: NextActionCommand) => void;
}) {
  const { model } = props;
  const { methods, deleteBranchDefault, items } = model.menu;
  const lifecycle = items.filter(
    (item) => item.command.type === "set-draft" || item.command.type === "close",
  );
  const steps = items.filter((item) => !lifecycle.includes(item));
  const group = (entries: ReadonlyArray<NextActionMenuItem>) =>
    entries.map((item) => (
      <MenuItem
        key={JSON.stringify(item.command)}
        variant={item.destructive ? "destructive" : "default"}
        onClick={() => props.onRun(item.command)}
      >
        <MenuItemBody label={item.label} hint={item.hint} />
      </MenuItem>
    ));
  return (
    <MenuPopup align="end" sideOffset={6} className="w-64">
      {methods ? (
        <MenuGroup>
          <MenuGroupLabel className="text-[11px] font-normal">Merge method</MenuGroupLabel>
          <MenuRadioGroup
            value={model.method}
            onValueChange={(value) => model.setMethod(value as typeof model.method)}
          >
            {methods.map((option) => (
              <MenuRadioItem
                key={option.method}
                value={option.method}
                disabled={option.disabledReason !== null}
                closeOnClick={false}
              >
                <MenuItemBody
                  label={option.label}
                  hint={option.disabledReason ?? MERGE_METHOD_HINT[option.method]}
                />
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      ) : null}
      {deleteBranchDefault !== null ? (
        <MenuCheckboxItem
          checked={model.deleteBranch}
          onCheckedChange={(checked) => model.setDeleteBranch(checked)}
          closeOnClick={false}
        >
          Delete branch after merge
        </MenuCheckboxItem>
      ) : null}
      {steps.length > 0 ? (
        <>
          {methods || deleteBranchDefault !== null ? <MenuSeparator /> : null}
          {group(steps)}
        </>
      ) : null}
      {lifecycle.length > 0 ? (
        <>
          {methods || deleteBranchDefault !== null || steps.length > 0 ? <MenuSeparator /> : null}
          {group(lifecycle)}
        </>
      ) : null}
    </MenuPopup>
  );
}

function CloseConfirmDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly number: number;
  readonly pending: boolean;
  readonly onConfirm: () => Promise<void>;
}) {
  return (
    <AlertDialog
      open={props.open}
      onOpenChange={(open) => !props.pending && props.onOpenChange(open)}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Close #{props.number} without merging?</AlertDialogTitle>
          <AlertDialogDescription>
            The pull request stays on the host and can be reopened later. Its branch is kept.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />} disabled={props.pending}>
            Cancel
          </AlertDialogClose>
          <Button
            variant="destructive"
            disabled={props.pending}
            onClick={() => void props.onConfirm()}
          >
            Close pull request
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
