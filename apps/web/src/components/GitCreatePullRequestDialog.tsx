import { GitPullRequestDraftIcon, GitPullRequestIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Kbd } from "~/components/ui/kbd";
import { cn, isMacPlatform } from "~/lib/utils";
import type { ChangeRequestTerminology } from "../sourceControlPresentation";
import {
  type CreatePrDialogContext,
  resolveCreatePrDialogExecution,
  resolveCreatePrDialogView,
} from "./GitActionsControl.logic";

export interface GitCreatePullRequestSubmission {
  action: "create_pr" | "commit_push_pr";
  draft: boolean;
  /** Unticked "Commit and push local changes" on a dirty tree: committed work only. */
  leaveLocalChangesOut: boolean;
  title: string | null;
  body: string | null;
}

/** Borderless authoring field, like the reference app's PR title and description. */
const FIELD_CLASS =
  "w-full bg-transparent py-1 text-sm leading-snug outline-none placeholder:text-muted-foreground/70";

function ActionRow(props: {
  highlighted?: boolean;
  disabled: boolean;
  icon: ReactNode;
  label: string;
  trailing?: ReactNode;
  ariaKeyShortcuts?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      aria-keyshortcuts={props.ariaKeyShortcuts}
      onClick={props.onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-sm outline-none transition-colors",
        "hover:bg-accent focus-visible:bg-accent [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
        props.highlighted && "bg-accent",
        props.disabled && "pointer-events-none opacity-50",
      )}
    >
      {props.icon}
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.trailing}
    </button>
  );
}

/**
 * Create PR in one step: a branch summary, an optional title and description (generated when
 * left empty), a "Commit and push local changes" toggle with the diff totals, and Create
 * draft / Create actions (Mod+Enter creates). Ported from Synara's GitCreatePrDialog.
 * Mounted only while open, so every opening starts empty.
 */
export default function GitCreatePullRequestDialog(props: {
  onOpenChange: (open: boolean) => void;
  context: CreatePrDialogContext;
  terminology: ChangeRequestTerminology;
  onSubmit: (submission: GitCreatePullRequestSubmission) => void;
}) {
  const { context, terminology } = props;
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [includeLocalChanges, setIncludeLocalChanges] = useState(true);
  const view = useMemo(() => resolveCreatePrDialogView(context), [context]);
  const execution = useMemo(
    () => resolveCreatePrDialogExecution(context, includeLocalChanges),
    [context, includeLocalChanges],
  );
  const canCreate = execution.kind === "run_action";
  const unavailableHint = execution.kind === "unavailable" ? execution.hint : null;
  const isMac = isMacPlatform(typeof navigator === "undefined" ? "" : navigator.platform);

  const submit = (draft: boolean) => {
    if (execution.kind !== "run_action") return;
    props.onSubmit({
      action: execution.action,
      draft,
      leaveLocalChangesOut: !includeLocalChanges && view.showCommitToggle,
      title: title.trim() || null,
      body: body.trim() || null,
    });
  };

  return (
    <Dialog open onOpenChange={props.onOpenChange}>
      <DialogPopup
        className="max-w-md"
        showCloseButton={false}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit(false);
          }
        }}
      >
        <DialogHeader className="gap-0.5">
          <DialogTitle className="font-normal font-sans text-muted-foreground text-xs">
            {view.isNewBranch ? "New branch" : "Branch"}
          </DialogTitle>
          <DialogDescription
            className={cn(
              "truncate font-medium text-sm",
              view.willCreateFeatureBranch ? "text-muted-foreground italic" : "text-foreground",
            )}
          >
            {view.willCreateFeatureBranch
              ? "Auto-named feature branch"
              : (view.refName ?? "(detached HEAD)")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-1 pt-2">
          <input
            autoFocus
            aria-label={`${terminology.shortLabel} title`}
            className={cn(FIELD_CLASS, "font-medium")}
            maxLength={300}
            placeholder="Title (leave empty to generate)"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <textarea
            aria-label={`${terminology.shortLabel} description`}
            className={cn(FIELD_CLASS, "resize-none")}
            maxLength={60_000}
            placeholder="Description (leave empty to generate)"
            rows={2}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          {view.showCommitToggle ? (
            <label className="flex cursor-pointer items-center gap-2 py-1 text-sm">
              <Checkbox
                checked={includeLocalChanges}
                onCheckedChange={(checked) => setIncludeLocalChanges(checked === true)}
              />
              <span className="flex-1">Commit and push local changes</span>
              <span className="shrink-0 font-mono text-xs">
                <span className="text-success">+{view.insertions}</span>{" "}
                <span className="text-destructive">−{view.deletions}</span>
              </span>
            </label>
          ) : null}
          {unavailableHint ? <p className="py-1 text-warning text-xs">{unavailableHint}</p> : null}
        </DialogPanel>
        <div className="border-t border-border p-2">
          <ActionRow
            disabled={!canCreate}
            icon={<GitPullRequestDraftIcon />}
            label={`Create draft ${terminology.shortLabel}`}
            onClick={() => submit(true)}
          />
          <ActionRow
            highlighted
            disabled={!canCreate}
            icon={<GitPullRequestIcon />}
            label={`Create ${terminology.shortLabel}`}
            trailing={<Kbd aria-hidden="true">{isMac ? "⌘↵" : "Ctrl+↵"}</Kbd>}
            ariaKeyShortcuts={isMac ? "Meta+Enter" : "Control+Enter"}
            onClick={() => submit(false)}
          />
        </div>
      </DialogPopup>
    </Dialog>
  );
}
