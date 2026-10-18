import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { ChevronDownIcon, CircleDotIcon, GitBranchIcon, GitPullRequestIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { cn } from "~/lib/utils";
import { AtlassianJiraIcon } from "../Icons";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  preloadSourceItemTabs,
  SourcePickerPanel,
  useSourcePickerState,
  type NewThreadSource,
} from "./SourcePickerPanel";

export type { NewThreadSource } from "./SourcePickerPanel";

export interface NewThreadSourcePickerProps {
  readonly label: string;
  /**
   * Which kind of thing `label` names. A branch is the unremarkable default and
   * stays plain; a PR, issue, or work item is a deliberate, less common choice,
   * so each gets its provider glyph in its own colour — the sentence should say
   * *what* you picked at a glance, not just its title.
   */
  readonly sourceKind: "branch" | "pr" | "issue" | "workItem" | null;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly cwd: string | null;
  readonly fetchOrigin: boolean;
  readonly onFetchOriginChange: (enabled: boolean) => void;
  readonly branchName: string | null;
  readonly onBranchNameChange: (name: string | null) => void;
  readonly onSelect: (source: NewThreadSource) => void;
}

/**
 * The `from …` token of the work-location sentence, when the target is a new
 * worktree.
 *
 * One popover with four segments rather than four controls or a jump into the
 * worktree dialog: the question ("where does this branch off from?") is one
 * question, and branch / PR / issue / work item are four answers to it.
 *
 * Only offered in new-worktree mode. Working directly in a checkout is a real
 * `git switch`, and a PR head or an issue is not something you can switch to.
 */
export function NewThreadSourcePicker({
  label,
  sourceKind,
  environmentId,
  projectId,
  cwd,
  onSelect,
  fetchOrigin,
  onFetchOriginChange,
  branchName,
  onBranchNameChange,
}: NewThreadSourcePickerProps) {
  const [open, setOpen] = useState(false);
  const pickerState = useSourcePickerState();

  const choose = useCallback(
    (source: NewThreadSource) => {
      setOpen(false);
      onSelect(source);
    },
    [onSelect],
  );
  const handleOpenChange = useCallback((nextOpen: boolean) => {
    // Opening the picker is the intent: by the time a segment is picked, its
    // list has usually loaded.
    if (nextOpen) preloadSourceItemTabs();
    setOpen(nextOpen);
  }, []);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        aria-label={`Change what this worktree branches from (currently ${label})`}
        className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 font-medium text-foreground/85 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        render={<button type="button" />}
      >
        <SourceKindGlyph kind={sourceKind} />
        <span className="min-w-0 max-w-[18rem] truncate">{label}</span>
        <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        side="bottom"
        className="w-[30rem] overflow-hidden p-0"
        viewportClassName="p-0 [--viewport-inline-padding:0px]"
      >
        <SourcePickerPanel
          state={pickerState}
          repository={{ environmentId, projectId, cwd }}
          onSelect={choose}
          branchCreation={{ fetchOrigin, onFetchOriginChange, branchName, onBranchNameChange }}
        />
      </PopoverPopup>
    </Popover>
  );
}

function SourceKindGlyph({ kind }: { readonly kind: NewThreadSourcePickerProps["sourceKind"] }) {
  const className = "size-3.5 shrink-0";
  switch (kind) {
    case "pr":
      return (
        <GitPullRequestIcon
          aria-label="Pull request"
          className={cn(className, "text-emerald-500 dark:text-emerald-400")}
        />
      );
    case "issue":
      return (
        <CircleDotIcon
          aria-label="Issue"
          className={cn(className, "text-sky-500 dark:text-sky-400")}
        />
      );
    case "workItem":
      return (
        <AtlassianJiraIcon
          aria-label="Jira work item"
          className={cn(className, "text-violet-500 dark:text-violet-400")}
        />
      );
    case "branch":
      return <GitBranchIcon aria-hidden className={cn(className, "text-muted-foreground")} />;
    default:
      return null;
  }
}
