import { WORKSPACE_LIFECYCLE_ACTION_LABELS } from "@ryco/client-runtime/state/lifecycle";
import type { WorkspaceLifecyclePreview } from "@ryco/contracts";
import { useCallback, useEffect, useState } from "react";

import {
  announceWorkspaceLifecycleResult,
  readLifecycleApi,
  useWorkspaceLifecycleDialogStore,
  type WorkspaceLifecycleTarget,
} from "../../workspaceLifecycle";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";

type PreviewState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly preview: WorkspaceLifecyclePreview }
  | { readonly status: "error"; readonly message: string };

/**
 * The one review step for workspace actions that touch a checkout. Everything shown
 * comes from the server preview; Confirm applies exactly that preview (its
 * fingerprint), so a workspace that changed in between is refused, not guessed at.
 */
export function WorkspaceLifecycleDialogHost() {
  const target = useWorkspaceLifecycleDialogStore((state) => state.target);
  const close = useWorkspaceLifecycleDialogStore((state) => state.close);
  return target ? (
    <WorkspaceLifecycleDialog
      key={`${target.environmentId}:${target.worktreeId}:${target.action}`}
      target={target}
      onClose={close}
    />
  ) : null;
}

function WorkspaceLifecycleDialog(props: {
  readonly target: WorkspaceLifecycleTarget;
  readonly onClose: () => void;
}) {
  const { target, onClose } = props;
  const [archiveConversations, setArchiveConversations] = useState(true);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const removal = target.action === "remove-checkout" || target.action === "remove-stale-record";

  const lifecycleAvailable = readLifecycleApi(target.environmentId) !== undefined;
  const loadPreview = useCallback(async () => {
    const lifecycle = readLifecycleApi(target.environmentId);
    if (!lifecycle) return;
    try {
      const preview = await lifecycle.previewWorkspace({
        worktreeId: target.worktreeId,
        action: target.action,
        archiveConversations,
        deleteBranch,
      });
      setState({ status: "ready", preview });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "The workspace could not be inspected.",
      });
    }
  }, [archiveConversations, deleteBranch, target]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const apply = async () => {
    if (state.status !== "ready") return;
    const lifecycle = readLifecycleApi(target.environmentId);
    if (!lifecycle) return;
    setBusy(true);
    try {
      const result = await lifecycle.applyWorkspace({
        ...state.preview.request,
        expectedFingerprint: state.preview.fingerprint,
      });
      onClose();
      announceWorkspaceLifecycleResult(target, result);
    } catch (error) {
      setBusy(false);
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "The action could not be applied.",
      });
    }
  };

  const view: PreviewState = lifecycleAvailable
    ? state
    : { status: "error", message: "This environment does not support workspace actions." };
  const preview = view.status === "ready" ? view.preview : null;
  const blocked = preview !== null && preview.blockers.length > 0;
  const branchDeletable =
    preview !== null &&
    target.action === "remove-checkout" &&
    preview.workspace.branchExists === true &&
    preview.workspace.unmerged === false;
  const destructive = preview?.effects.removeCheckout === true || preview?.effects.deleteBranch;

  return (
    <AlertDialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <AlertDialogPopup data-testid="workspace-lifecycle-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {WORKSPACE_LIFECYCLE_ACTION_LABELS[target.action]} ·{" "}
            {preview?.workspace.title ?? target.title}
          </AlertDialogTitle>
          <AlertDialogDescription render={<div />}>
            {view.status === "loading" ? (
              <span className="block">Inspecting the workspace…</span>
            ) : view.status === "error" ? (
              <span className="block text-destructive">{view.message}</span>
            ) : (
              <>
                <span
                  className="block pb-2 font-medium text-foreground"
                  data-testid="workspace-lifecycle-summary"
                >
                  {view.preview.summary}
                </span>
                {view.preview.details.map((detail) => (
                  <span key={detail} className="block pb-1.5">
                    {detail}
                  </span>
                ))}
                {blocked ? (
                  <span className="mt-2 block rounded-md border border-destructive/30 bg-destructive/6 px-3 py-2 text-destructive">
                    <span className="block pb-1 font-medium">Nothing will change:</span>
                    {view.preview.blockers.map((blocker) => (
                      <span key={blocker} className="block pb-1">
                        {blocker}
                      </span>
                    ))}
                  </span>
                ) : null}
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {removal && preview && !blocked ? (
          <div className="flex flex-col gap-2 px-6 pb-2 text-sm">
            <label className="flex items-start gap-2">
              <Checkbox
                className="mt-0.5"
                checked={archiveConversations}
                disabled={busy}
                onCheckedChange={(checked) => {
                  setState({ status: "loading" });
                  setArchiveConversations(checked === true);
                }}
              />
              <span>Archive this workspace's conversations (history is always kept)</span>
            </label>
            {target.action === "remove-checkout" ? (
              <label className="flex items-start gap-2">
                <Checkbox
                  className="mt-0.5"
                  checked={deleteBranch}
                  disabled={busy || !branchDeletable}
                  onCheckedChange={(checked) => {
                    setState({ status: "loading" });
                    setDeleteBranch(checked === true);
                  }}
                />
                <span>
                  Also delete branch {preview.effects.branch}
                  {branchDeletable ? " (merged)" : " (only possible for a verified merged branch)"}
                </span>
              </label>
            ) : null}
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>
            Cancel
          </AlertDialogClose>
          {view.status === "error" ? (
            <Button
              variant="outline"
              onClick={() => {
                setState({ status: "loading" });
                void loadPreview();
              }}
            >
              Retry
            </Button>
          ) : null}
          <Button
            variant={destructive ? "destructive" : "default"}
            data-testid="workspace-lifecycle-confirm"
            disabled={busy || preview === null || blocked}
            onClick={() => void apply()}
          >
            {WORKSPACE_LIFECYCLE_ACTION_LABELS[target.action]}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
