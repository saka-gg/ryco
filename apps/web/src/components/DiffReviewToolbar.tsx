import {
  ChevronDownIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  ChevronUpIcon,
  ListTreeIcon,
} from "lucide-react";
import { memo } from "react";

import { useAppKeybindings } from "~/appKeybindings";
import { shortcutLabelForCommand } from "~/keybindings";

import { DiffStatLabel } from "./chat/DiffStatLabel";
import { Toggle } from "./ui/toggle-group";

const ICON_BUTTON_CLASS_NAME =
  "rounded p-1 hover:bg-foreground/10 disabled:opacity-40 disabled:hover:bg-transparent";

/**
 * The diff panel's review row (desktop presentations): the file tree toggle, the patch's file
 * count and line totals, previous/next hunk with their shortcuts, and collapse/expand all.
 */
export const DiffReviewToolbar = memo(function DiffReviewToolbar(props: {
  readonly fileTreeOpen: boolean;
  readonly onFileTreeOpenChange: (open: boolean) => void;
  readonly totals: {
    readonly files: number;
    readonly additions: number;
    readonly deletions: number;
  };
  readonly canPreviousHunk: boolean;
  readonly canNextHunk: boolean;
  readonly onHunk: (direction: 1 | -1) => void;
  /** Null when no file is listed. */
  readonly allCollapsed: boolean | null;
  readonly onToggleCollapseAll: () => void;
}) {
  const keybindings = useAppKeybindings();
  const withShortcut = (label: string, command: "diff.hunk.next" | "diff.hunk.previous") => {
    const shortcut = shortcutLabelForCommand(keybindings, command);
    return shortcut ? `${label} (${shortcut})` : label;
  };
  const treeLabel = props.fileTreeOpen ? "Hide file tree" : "Show file tree";
  const collapseLabel = props.allCollapsed ? "Expand all files" : "Collapse all files";
  return (
    <div
      role="toolbar"
      aria-label="Review tools"
      className="flex shrink-0 items-center gap-1 border-b border-border/50 px-2 py-1 text-[11px] text-muted-foreground"
    >
      <Toggle
        aria-label={treeLabel}
        title={treeLabel}
        variant="outline"
        size="xs"
        pressed={props.fileTreeOpen}
        onPressedChange={(pressed) => props.onFileTreeOpenChange(Boolean(pressed))}
      >
        <ListTreeIcon className="size-3" />
      </Toggle>
      <span className="ml-1 tabular-nums" data-diff-totals="">
        {props.totals.files} {props.totals.files === 1 ? "file" : "files"}{" "}
        <DiffStatLabel additions={props.totals.additions} deletions={props.totals.deletions} />
      </span>
      <div className="flex-1" />
      <button
        type="button"
        className={ICON_BUTTON_CLASS_NAME}
        aria-label="Previous hunk"
        title={withShortcut("Previous hunk", "diff.hunk.previous")}
        disabled={!props.canPreviousHunk}
        onClick={() => props.onHunk(-1)}
      >
        <ChevronUpIcon className="size-3.5" />
      </button>
      <button
        type="button"
        className={ICON_BUTTON_CLASS_NAME}
        aria-label="Next hunk"
        title={withShortcut("Next hunk", "diff.hunk.next")}
        disabled={!props.canNextHunk}
        onClick={() => props.onHunk(1)}
      >
        <ChevronDownIcon className="size-3.5" />
      </button>
      <button
        type="button"
        className={ICON_BUTTON_CLASS_NAME}
        aria-label={collapseLabel}
        title={collapseLabel}
        disabled={props.allCollapsed === null}
        onClick={props.onToggleCollapseAll}
      >
        {props.allCollapsed ? (
          <ChevronsUpDownIcon className="size-3.5" />
        ) : (
          <ChevronsDownUpIcon className="size-3.5" />
        )}
      </button>
    </div>
  );
});
