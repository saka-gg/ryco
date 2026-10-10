import { WORKSPACE_LIFECYCLE_ACTION_LABELS } from "@ryco/client-runtime/state/lifecycle";
import { WS_METHODS } from "@ryco/contracts";
import { useState } from "react";

import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import {
  openWorkspaceReviewDialog,
  useWorkspaceReviewDialog,
  type WorkspaceReviewTarget,
} from "../../workspaceLifecycle";
import { useProjectEditAccess } from "../projects/sections/useProjectEditAccess";
import { WorkspaceReview } from "../projects/sections/WorkspaceReview";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

function WorkspaceReviewDialogBody(props: {
  readonly target: WorkspaceReviewTarget;
  /** Bumps on every open: the review inside starts fresh, the popup stays put. */
  readonly token: number;
  readonly onClose: () => void;
}) {
  const { target } = props;
  const access = useProjectEditAccess(target.environmentId);
  const applyCapability = useHostedRpcCapability(WS_METHODS.lifecycleApplyWorkspace);
  const previewCapability = useHostedRpcCapability(WS_METHODS.lifecyclePreviewWorkspace);
  return (
    <DialogPopup className="max-w-md" data-testid="workspace-review-dialog">
      <DialogHeader>
        <DialogTitle>{WORKSPACE_LIFECYCLE_ACTION_LABELS[target.action]}</DialogTitle>
        <DialogDescription className="truncate font-mono text-xs">{target.title}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <WorkspaceReview
          key={`${target.worktreeId}:${target.action}:${props.token}`}
          layout="dialog"
          environmentId={target.environmentId}
          projectId={target.projectId}
          worktreeId={target.worktreeId}
          action={target.action}
          title={target.title}
          previewDenied={
            previewCapability.allowed
              ? null
              : (previewCapability.reason ?? "Your role on this device can't change workspaces.")
          }
          canApply={access.canEdit && applyCapability.allowed}
          onClose={props.onClose}
          onReopen={() => openWorkspaceReviewDialog(target)}
          onChangeAction={(action) => openWorkspaceReviewDialog({ ...target, action })}
        />
        {access.reason ? (
          <p className="mt-1 text-[11.5px] text-muted-foreground">{access.reason}</p>
        ) : null}
      </DialogPanel>
    </DialogPopup>
  );
}

/**
 * The review a menu opens (sidebar worktree menu, Inbox Workspace submenu, a
 * toast's Retry): a small dialog over whatever the reader is doing. Mounted
 * once by the app shell; `openWorkspaceReviewDialog` drives it.
 */
export function WorkspaceReviewDialog() {
  const target = useWorkspaceReviewDialog((state) => state.target);
  const token = useWorkspaceReviewDialog((state) => state.token);
  const close = useWorkspaceReviewDialog((state) => state.close);
  /* Closing keeps the last review on screen while the dialog folds away. */
  const [shown, setShown] = useState(target);
  if (target && target !== shown) setShown(target);
  const current = target ?? shown;
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {current ? (
        <WorkspaceReviewDialogBody target={current} token={token} onClose={close} />
      ) : null}
    </Dialog>
  );
}
