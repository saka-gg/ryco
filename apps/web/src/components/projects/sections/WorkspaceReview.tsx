import {
  WORKSPACE_LIFECYCLE_ACTION_LABELS,
  workspaceActionRequest,
} from "@ryco/client-runtime/state/lifecycle";
import type {
  EnvironmentId,
  ProjectId,
  WorkspaceLifecyclePreview,
  WorkspaceLifecycleResult,
  WorktreeId,
} from "@ryco/contracts";
import { LoaderCircleIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { cn } from "../../../lib/utils";
import {
  announceWorkspaceLifecycleResult,
  readLifecycleApi,
  useWorkspaceLifecycleChanges,
} from "../../../workspaceLifecycle";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import type { WorkspaceReviewAction } from "../projectsSearch";

type Preview =
  | { readonly status: "ready"; readonly preview: WorkspaceLifecyclePreview }
  | { readonly status: "error"; readonly message: string };

type Phase =
  | { readonly kind: "review" }
  | { readonly kind: "applying" }
  | { readonly kind: "result"; readonly result: WorkspaceLifecycleResult }
  | { readonly kind: "apply-error"; readonly message: string };

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/**
 * The review of one checkout change, in the map's inspector or the app's
 * review dialog. Everything it states comes from the server preview, and
 * Confirm applies exactly that preview (its fingerprint): a workspace that
 * changed in between is refused, never guessed at. A partial or failed run
 * stays here with what happened and a Retry that inspects again.
 *
 * "Delete workspace" discards what exists only there; when it would lose work,
 * Confirm also needs an explicit acknowledgement of this exact preview.
 */
export function WorkspaceReview(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly worktreeId: WorktreeId;
  readonly action: WorkspaceReviewAction;
  readonly title: string;
  /** Whether this device lets the reader inspect workspaces; the reason when not. */
  readonly previewDenied: string | null;
  /** Viewers and unreachable devices see the review but cannot confirm it. */
  readonly canApply: boolean;
  readonly onClose: () => void;
  /** Opens this review again from anywhere (a toast after the reader moved on). */
  readonly onReopen: () => void;
  /** Switches to another review of the same workspace ("Delete workspace instead"). */
  readonly onChangeAction?: ((action: WorkspaceReviewAction) => void) | undefined;
  /** Inline under a workspace (indented to its title) or flush in a dialog. */
  readonly layout?: "inline" | "dialog";
}) {
  const { environmentId, worktreeId, action, onClose, onReopen } = props;
  const label = WORKSPACE_LIFECYCLE_ACTION_LABELS[action];
  const deleting = action === "delete-workspace";
  const removal = action === "remove-checkout" || action === "remove-stale-record";
  const [archiveConversations, setArchiveConversations] = useState(true);
  // Deleting means everything: the branch goes too unless the reader keeps it.
  const [deleteBranch, setDeleteBranch] = useState(deleting);
  const [acknowledged, setAcknowledged] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "review" });
  const previewKey = `${worktreeId}\u0000${action}\u0000${archiveConversations}\u0000${deleteBranch}\u0000${attempt}`;
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly value: Preview } | null>(
    null,
  );
  const lifecycle = props.previewDenied === null ? readLifecycleApi(environmentId) : undefined;
  const headingId = useId();
  // An apply can settle after the reader closed the review or left the page;
  // its outcome then goes to a toast instead of this (gone) panel.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!lifecycle) return;
    let cancelled = false;
    lifecycle
      .previewWorkspace({
        worktreeId,
        ...workspaceActionRequest(action),
        archiveConversations,
        deleteBranch,
      })
      .then(
        (preview): Preview => ({ status: "ready", preview }),
        (error: unknown): Preview => ({
          status: "error",
          message: errorMessage(error, "The workspace could not be inspected."),
        }),
      )
      .then((value) => {
        if (!cancelled) setLoaded({ key: previewKey, value });
      });
    return () => {
      cancelled = true;
    };
  }, [action, archiveConversations, deleteBranch, lifecycle, previewKey, worktreeId]);

  const loadedView = loaded?.key === previewKey ? loaded.value : null;
  const view: Preview | null =
    props.previewDenied !== null
      ? { status: "error", message: props.previewDenied }
      : !lifecycle
        ? { status: "error", message: "This device does not support workspace actions." }
        : // A node that predates deleting answers with an ordinary removal.
          deleting && loadedView?.status === "ready" && loadedView.preview.effects.discard !== true
          ? {
              status: "error",
              message: "This device's Ryco cannot delete workspaces yet. Update it, then retry.",
            }
          : loadedView;
  // Only the current preview can be confirmed. While options re-inspect, the
  // last one stays on screen (dimmed) so the controls never jump away.
  const preview = view?.status === "ready" ? view.preview : null;
  const shown =
    preview ?? (view === null && loaded?.value.status === "ready" ? loaded.value.preview : null);
  const refreshing = preview === null && shown !== null;
  const blocked = preview !== null && preview.blockers.length > 0;
  const busy = phase.kind === "applying";
  const branchDeletable =
    shown !== null &&
    action === "remove-checkout" &&
    shown.workspace.branchExists === true &&
    shown.workspace.unmerged === false;
  const destructive =
    deleting || shown?.effects.removeCheckout === true || shown?.effects.deleteBranch;
  // Losing work needs a yes to this exact preview; a re-inspection asks again.
  const needsAcknowledgement = preview?.effects.discardsWork === true;
  const confirmed = !needsAcknowledgement || acknowledged === preview?.fingerprint;
  // A removal blocked only by work it would keep can become a delete instead.
  const canDeleteInstead =
    action === "remove-checkout" &&
    props.onChangeAction !== undefined &&
    blocked &&
    shown?.workspace.discardBlockers?.length === 0;
  const target = {
    environmentId,
    projectId: props.projectId,
    worktreeId,
    action,
    title: props.title,
  };

  const retry = () => {
    setPhase({ kind: "review" });
    setAttempt((value) => value + 1);
  };

  const apply = async () => {
    if (!preview || !lifecycle) return;
    setPhase({ kind: "applying" });
    try {
      const result = await lifecycle.applyWorkspace({
        ...preview.request,
        expectedFingerprint: preview.fingerprint,
      });
      if (result.outcome === "completed" || !mountedRef.current) {
        // Re-inspects open lists; partial or failed runs get a toast with Retry.
        announceWorkspaceLifecycleResult(target, result, onReopen);
        if (mountedRef.current) onClose();
        return;
      }
      // Even a refused or partial run may have changed something: lists re-inspect.
      useWorkspaceLifecycleChanges.getState().markChanged();
      setPhase({ kind: "result", result });
    } catch (error) {
      const message = errorMessage(error, "The action could not be applied.");
      if (mountedRef.current) {
        setPhase({ kind: "apply-error", message });
        return;
      }
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `${label} failed`,
          description: message,
          actionProps: { children: "Retry", onClick: onReopen },
        }),
      );
    }
  };

  const failure =
    phase.kind === "result"
      ? {
          title:
            phase.result.outcome === "partial"
              ? `${label} partly completed`
              : `${label} did not run`,
          message: phase.result.message,
          detail: phase.result.steps.find((step) => step.status === "failed")?.detail ?? null,
          tone: phase.result.outcome === "partial" ? "warning" : "destructive",
        }
      : phase.kind === "apply-error"
        ? { title: `${label} failed`, message: phase.message, detail: null, tone: "destructive" }
        : null;

  return (
    <section
      aria-labelledby={headingId}
      data-workspace-review={action}
      className={cn(
        "flex flex-col gap-3 text-[13px]",
        props.layout !== "dialog" && "pt-0.5 pb-3.5 pl-[1.625rem]",
      )}
    >
      <h3 id={headingId} className="sr-only">
        {label} · {props.title}
      </h3>
      {failure ? (
        <div role="alert" className="flex flex-col gap-1">
          <p
            className={cn(
              "font-medium",
              failure.tone === "warning"
                ? "text-warning-foreground"
                : "text-destructive-foreground",
            )}
          >
            {failure.title}
          </p>
          <p className="text-xs text-muted-foreground">{failure.message}</p>
          {failure.detail ? (
            <p className="text-xs text-muted-foreground">{failure.detail}</p>
          ) : null}
        </div>
      ) : view?.status === "error" ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {view.message}
        </p>
      ) : shown === null ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
          <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin" />
          Inspecting the workspace…
        </p>
      ) : (
        <div
          aria-busy={refreshing}
          className={cn(
            "flex flex-col gap-2 transition-opacity duration-(--app-motion-duration-chip)",
            refreshing && "opacity-60",
          )}
        >
          <p data-testid="workspace-review-summary" className="font-medium text-foreground">
            {shown.summary}
          </p>
          {shown.details.length > 0 ? (
            <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
              {shown.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          ) : null}
          {shown.blockers.length > 0 ? (
            <div role="alert" className="flex flex-col gap-1 text-xs text-destructive-foreground">
              <p className="font-medium">Nothing will change:</p>
              <ul className="flex flex-col gap-1">
                {shown.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
      {canDeleteInstead && !failure ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[min(var(--radius-lg),0.625rem)] border border-dashed border-destructive/35 px-3 py-2 text-xs">
          <span className="min-w-0 flex-[1_1_12rem] text-muted-foreground">
            Don't need what's in it? Deleting the workspace discards it and moves its conversations
            to Trash.
          </span>
          <Button
            size="xs"
            variant="destructive-outline"
            data-testid="workspace-review-delete-instead"
            disabled={busy}
            onClick={() => props.onChangeAction?.("delete-workspace")}
          >
            Delete workspace instead…
          </Button>
        </div>
      ) : null}
      {deleting && shown && shown.blockers.length === 0 && !failure ? (
        <div className="flex flex-col gap-2 text-xs">
          {shown.workspace.branchExists === true ? (
            <label className="flex items-start gap-2">
              <Checkbox
                className="mt-px"
                checked={deleteBranch}
                disabled={busy}
                onCheckedChange={(checked) => setDeleteBranch(checked === true)}
              />
              <span>
                Also delete branch <span className="font-mono">{shown.effects.branch}</span>
                {shown.workspace.unmerged === false ? " (merged)" : " and its unmerged commits"}
              </span>
            </label>
          ) : null}
          {needsAcknowledgement && preview ? (
            <label className="flex items-start gap-2 font-medium text-destructive-foreground">
              <Checkbox
                className="mt-px"
                data-testid="workspace-review-acknowledge"
                checked={acknowledged === preview.fingerprint}
                disabled={busy}
                onCheckedChange={(checked) =>
                  setAcknowledged(checked === true ? preview.fingerprint : null)
                }
              />
              <span>I understand that work which exists only in this workspace is lost.</span>
            </label>
          ) : null}
        </div>
      ) : null}
      {removal && shown && shown.blockers.length === 0 && !failure ? (
        <div className="flex flex-col gap-2 text-xs">
          <label className="flex items-start gap-2">
            <Checkbox
              className="mt-px"
              checked={archiveConversations}
              disabled={busy}
              onCheckedChange={(checked) => setArchiveConversations(checked === true)}
            />
            <span>Archive this workspace's conversations. Their history is always kept.</span>
          </label>
          {action === "remove-checkout" ? (
            <label
              className={cn("flex items-start gap-2", !branchDeletable && "text-muted-foreground")}
            >
              <Checkbox
                className="mt-px"
                checked={deleteBranch}
                disabled={busy || !branchDeletable}
                onCheckedChange={(checked) => setDeleteBranch(checked === true)}
              />
              <span>
                Also delete branch <span className="font-mono">{shown.effects.branch}</span>
                {branchDeletable ? " (merged)" : " (only possible once it is verified merged)"}
              </span>
            </label>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
          {failure ? "Close" : "Cancel"}
        </Button>
        {failure || view?.status === "error" ? (
          <Button size="sm" variant="outline" onClick={retry}>
            Retry
          </Button>
        ) : (
          <Button
            size="sm"
            variant={destructive ? "destructive" : "default"}
            data-testid="workspace-review-confirm"
            disabled={busy || preview === null || blocked || !confirmed || !props.canApply}
            onClick={() => void apply()}
          >
            {busy ? <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin" /> : null}
            {label}
          </Button>
        )}
      </div>
    </section>
  );
}
