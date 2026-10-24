import type { EnvironmentId } from "@ryco/contracts";
import { RotateCwIcon, SparklesIcon } from "lucide-react";
import { useEffect, useReducer } from "react";
import {
  useCreateIssueMutation,
  useGenerateBranchNameMutation,
  useGenerateIssueContentMutation,
  useSourceControlIssueAssignees,
  useSourceControlIssueLabels,
} from "~/rpc/useSourceControl";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { IssueAssigneePicker } from "./IssueAssigneePicker";
import { IssueLabelPicker } from "./IssueLabelPicker";
import { canSubmit, initialNewIssueState, newIssueDialogReducer } from "./newIssueDialogReducer";

export interface NewIssueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: EnvironmentId;
  cwd: string;
  onCreated?: (issueNumber: number) => void;
}

export function NewIssueDialog(props: NewIssueDialogProps) {
  // Uncompiled on purpose: Babel's React Compiler never compiled this function
  // (it bails on value blocks inside try/catch). Oxc can, but its render reads
  // have not been audited for purity yet. Remove after that audit.
  "use no memo";
  const [state, dispatch] = useReducer(newIssueDialogReducer, initialNewIssueState);

  const labelsQuery = useSourceControlIssueLabels({
    environmentId: props.environmentId,
    cwd: props.cwd,
  });
  const assigneesQuery = useSourceControlIssueAssignees({
    environmentId: props.environmentId,
    cwd: props.cwd,
  });

  const polish = useGenerateIssueContentMutation({ environmentId: props.environmentId });
  const branchGen = useGenerateBranchNameMutation({ environmentId: props.environmentId });
  const createIssue = useCreateIssueMutation({ environmentId: props.environmentId });

  useEffect(() => {
    if (!props.open) return;
    if (!state.worktreeEnabled) return;
    if (state.worktreeBranchName !== null) return;
    if (state.body.trim().length < 10) return;
    if (state.ai.branchStatus !== "idle") return;
    dispatch({ type: "aiBranchStarted" });
    branchGen
      .mutateAsync({ cwd: props.cwd, message: `${state.title}\n\n${state.body}` })
      .then((r) => dispatch({ type: "branchGenerated", branch: r.branch }))
      .catch((e: unknown) =>
        dispatch({
          type: "aiBranchFailed",
          error: e instanceof Error ? e.message : "Failed to generate branch name.",
        }),
      );
  }, [
    props.open,
    props.cwd,
    state.worktreeEnabled,
    state.worktreeBranchName,
    state.body,
    state.title,
    state.ai.branchStatus,
    branchGen,
  ]);

  const onPolish = async () => {
    dispatch({ type: "aiPolishStarted" });
    try {
      const trimmedInstructions = state.polishInstructions.trim();
      const r = await polish.mutateAsync({
        cwd: props.cwd,
        mode: "polish",
        rough: state.body,
        ...(state.title ? { currentTitle: state.title } : {}),
        ...(trimmedInstructions ? { customInstructions: trimmedInstructions } : {}),
      });
      dispatch({ type: "aiPolishSucceeded", result: r });
    } catch (e) {
      dispatch({
        type: "aiPolishFailed",
        error: e instanceof Error ? e.message : "Polish failed.",
      });
    }
  };

  const onSuggestTitle = async () => {
    dispatch({ type: "aiTitleStarted" });
    try {
      const r = await polish.mutateAsync({
        cwd: props.cwd,
        mode: "title",
        body: state.body,
      });
      dispatch({ type: "aiTitleSucceeded", result: r });
    } catch (e) {
      dispatch({
        type: "aiTitleFailed",
        error: e instanceof Error ? e.message : "Title suggest failed.",
      });
    }
  };

  const onRegenerateBranch = async () => {
    dispatch({ type: "aiBranchStarted" });
    try {
      const r = await branchGen.mutateAsync({
        cwd: props.cwd,
        message: `${state.title}\n\n${state.body}`,
      });
      dispatch({ type: "branchGenerated", branch: r.branch });
    } catch (e) {
      dispatch({
        type: "aiBranchFailed",
        error: e instanceof Error ? e.message : "Branch generation failed.",
      });
    }
  };

  const onSubmit = async () => {
    dispatch({ type: "submitStarted" });
    try {
      const result = await createIssue.mutateAsync({
        cwd: props.cwd,
        title: state.title,
        body: state.body,
        ...(state.labels.length > 0 ? { labels: state.labels } : {}),
        ...(state.assignees.length > 0 ? { assignees: state.assignees } : {}),
        ...(state.worktreeEnabled && state.worktreeBranchName
          ? { worktree: { enabled: true, branchName: state.worktreeBranchName } }
          : {}),
      });
      props.onCreated?.(result.issue.number);
      props.onOpenChange(false);
    } catch (e) {
      dispatch({
        type: "submitFailed",
        error: e instanceof Error ? e.message : "Create issue failed.",
      });
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="flex max-h-[80vh] w-full max-w-2xl flex-col p-0">
        <DialogHeader className="border-border/60 border-b px-5 py-3">
          <DialogTitle className="text-base">New issue</DialogTitle>
          <DialogDescription className="text-xs">{props.cwd}</DialogDescription>
        </DialogHeader>

        <DialogPanel className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between font-medium text-muted-foreground text-xs uppercase tracking-wide">
              <span>Title</span>
              <button
                type="button"
                onClick={() => void onSuggestTitle()}
                disabled={state.body.length === 0 || state.ai.titleStatus === "running"}
                className="inline-flex items-center gap-1 text-primary text-xs disabled:opacity-50"
              >
                <SparklesIcon className="size-3" />
                {state.ai.titleStatus === "running" ? "Suggesting…" : "Suggest from body"}
              </button>
            </div>
            <Input
              value={state.title}
              onChange={(e) => dispatch({ type: "setTitle", value: e.target.value })}
              placeholder="Short summary"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between font-medium text-muted-foreground text-xs uppercase tracking-wide">
              <span>Description</span>
              <button
                type="button"
                onClick={() => void onPolish()}
                disabled={state.body.length === 0 || state.ai.polishStatus === "running"}
                className="inline-flex items-center gap-1 text-primary text-xs disabled:opacity-50"
              >
                <SparklesIcon className="size-3" />
                {state.ai.polishStatus === "running" ? "Polishing…" : "Polish with AI"}
              </button>
            </div>
            <Textarea
              value={state.body}
              onChange={(e) => dispatch({ type: "setBody", value: e.target.value })}
              placeholder="Describe the issue, paste error logs, etc. — rough is fine, AI will polish it."
              className="min-h-[120px]"
            />
            {state.ai.polishStatus === "error" && state.ai.lastError ? (
              <p className="text-destructive text-xs">Polish failed: {state.ai.lastError}</p>
            ) : null}
            <Input
              value={state.polishInstructions}
              onChange={(e) => dispatch({ type: "setPolishInstructions", value: e.target.value })}
              placeholder='Polish guidance (optional) — e.g. "make it more detailed", "add use cases"'
              className="mt-2 h-8 text-xs"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <div className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                Labels
              </div>
              <IssueLabelPicker
                available={labelsQuery.data ?? []}
                selected={state.labels}
                onChange={(next) => dispatch({ type: "setLabels", labels: next })}
                isLoading={labelsQuery.isLoading}
                error={
                  labelsQuery.error instanceof Error
                    ? labelsQuery.error.message
                    : labelsQuery.error
                      ? String(labelsQuery.error)
                      : null
                }
              />
            </div>
            <div className="space-y-1.5">
              <div className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                Assignees
              </div>
              <IssueAssigneePicker
                available={assigneesQuery.data ?? []}
                selected={state.assignees}
                onChange={(next) => dispatch({ type: "setAssignees", assignees: next })}
                isLoading={assigneesQuery.isLoading}
                error={
                  assigneesQuery.error instanceof Error
                    ? assigneesQuery.error.message
                    : assigneesQuery.error
                      ? String(assigneesQuery.error)
                      : null
                }
              />
            </div>
          </div>

          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={state.worktreeEnabled}
                onChange={(e) => dispatch({ type: "setWorktreeEnabled", value: e.target.checked })}
              />
              Create worktree on submit
            </label>
            {state.worktreeEnabled ? (
              <div className="mt-2 flex items-center gap-2">
                <Input
                  value={state.worktreeBranchName ?? ""}
                  onChange={(e) =>
                    dispatch({ type: "setWorktreeBranchName", value: e.target.value })
                  }
                  placeholder={
                    state.ai.branchStatus === "running"
                      ? "Generating…"
                      : "Branch name (auto-suggested)"
                  }
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={() => void onRegenerateBranch()}
                  disabled={state.body.length === 0 || state.ai.branchStatus === "running"}
                  aria-label="Regenerate branch name"
                >
                  <RotateCwIcon
                    className={
                      state.ai.branchStatus === "running" ? "size-3.5 animate-spin" : "size-3.5"
                    }
                  />
                </Button>
              </div>
            ) : null}
          </div>

          {state.submitError ? (
            <p className="text-destructive text-sm">{state.submitError}</p>
          ) : null}
        </DialogPanel>

        <DialogFooter className="border-border/60 border-t px-5 py-3">
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit(state)} onClick={() => void onSubmit()}>
            {state.submitStatus === "submitting" ? "Creating…" : "Create issue"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
