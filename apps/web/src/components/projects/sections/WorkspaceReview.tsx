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
import { LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { cn } from "../../../lib/utils";
import {
  announceWorkspaceLifecycleResult,
  readLifecycleApi,
  useWorkspaceLifecycleChanges,
} from "../../../workspaceLifecycle";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Skeleton } from "../../ui/skeleton";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import type { WorkspaceReviewAction } from "../projectsSearch";
import { workspaceLostWorkFacts } from "./projectWorkspaces.logic";

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

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * The "Delete workspace" review, in the map's inspector or the app's review
 * dialog. Everything it states comes from the server preview, and Confirm
 * applies exactly that preview (its fingerprint): a workspace that changed in
 * between is refused, never guessed at. A partial or failed run stays here
 * with what happened and a Retry that inspects again.
 *
 * Deleting force-removes the checkout and always deletes its branch. Work that
 * exists only there is spelled out (with an AI-written description when the
 * node offers one) and the confirm button says "Delete anyway". The
 * workspace's conversations stay in the archive unless the reader also deletes
 * them.
 */
export function WorkspaceReview(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly worktreeId: WorktreeId;
  /** Only "Delete workspace" is reviewed; older links naming a removal land here too. */
  readonly action: WorkspaceReviewAction;
  readonly title: string;
  /** Whether this device lets the reader inspect workspaces; the reason when not. */
  readonly previewDenied: string | null;
  /** Viewers and unreachable devices see the review but cannot confirm it. */
  readonly canApply: boolean;
  readonly onClose: () => void;
  /** Opens this review again from anywhere (a toast after the reader moved on). */
  readonly onReopen: () => void;
  /** Inline under a workspace (indented to its title) or flush in a dialog. */
  readonly layout?: "inline" | "dialog";
}) {
  const { environmentId, worktreeId, action, onClose, onReopen } = props;
  const label = WORKSPACE_LIFECYCLE_ACTION_LABELS[action];
  const [deleteConversations, setDeleteConversations] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "review" });
  const previewKey = `${worktreeId}\u0000${deleteConversations}\u0000${attempt}`;
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly value: Preview } | null>(
    null,
  );
  const lifecycle = props.previewDenied === null ? readLifecycleApi(environmentId) : undefined;
  const summarizeChanges = lifecycle?.summarizeChanges;
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
        ...workspaceActionRequest(action, { deleteConversations }),
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
  }, [action, deleteConversations, lifecycle, previewKey, worktreeId]);

  const loadedView = loaded?.key === previewKey ? loaded.value : null;
  const view: Preview | null =
    props.previewDenied !== null
      ? { status: "error", message: props.previewDenied }
      : !lifecycle
        ? { status: "error", message: "This device does not support workspace actions." }
        : // A node that predates deleting answers with an ordinary removal.
          loadedView?.status === "ready" && loadedView.preview.effects.discard !== true
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
  const lostWork = shown ? workspaceLostWorkFacts(shown.workspace) : [];
  const losesWork = shown !== null && (shown.effects.discardsWork === true || lostWork.length > 0);
  const conversationCount = shown
    ? shown.workspace.conversations.active + shown.workspace.conversations.archived
    : 0;

  // The AI description of what would be lost: asked once per open, only when
  // something would be lost and the node can describe it. Informational only;
  // the preview's fingerprint never depends on it.
  const [workDescription, setWorkDescription] = useState<{ readonly text: string | null } | null>(
    null,
  );
  const describeRequestedRef = useRef(false);
  const describable = losesWork && summarizeChanges !== undefined;
  useEffect(() => {
    if (!describable || !summarizeChanges || describeRequestedRef.current) return;
    describeRequestedRef.current = true;
    summarizeChanges({ worktreeId }).then(
      (result) => {
        if (mountedRef.current) setWorkDescription({ text: result.summary?.trim() || null });
      },
      () => {
        if (mountedRef.current) setWorkDescription({ text: null });
      },
    );
  }, [describable, summarizeChanges, worktreeId]);

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
    // Conversations this run deletes stay restorable for a few seconds.
    const deletedConversationIds =
      preview.request.deleteConversations === true
        ? (preview.effects.trashConversationIds ?? [])
        : [];
    try {
      const result = await lifecycle.applyWorkspace({
        ...preview.request,
        expectedFingerprint: preview.fingerprint,
      });
      if (result.outcome === "completed" || !mountedRef.current) {
        // Re-inspects open lists; partial or failed runs get a toast with Retry.
        announceWorkspaceLifecycleResult(target, result, onReopen, { deletedConversationIds });
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

  const branch = shown?.workspace.branch ?? null;
  // The dialog names the workspace here; inline, its title is already above.
  const headerTitle = props.layout === "dialog" ? props.title : null;
  const headerBranch = branch !== null && branch !== props.title ? branch : null;

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
      {headerTitle !== null || headerBranch !== null ? (
        <p
          data-testid="workspace-review-header"
          className="flex min-w-0 items-baseline gap-1.5 text-foreground"
        >
          {headerTitle !== null ? (
            <span className="min-w-0 truncate font-medium">{headerTitle}</span>
          ) : null}
          {headerBranch !== null ? (
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
              {headerBranch}
            </span>
          ) : null}
        </p>
      ) : null}
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
            "flex flex-col gap-3 transition-opacity duration-(--app-motion-duration-chip)",
            refreshing && "opacity-60",
          )}
        >
          <p data-testid="workspace-review-summary" className="text-xs text-muted-foreground">
            {shown.effects.removeCheckout
              ? "Removes the checkout from disk"
              : "Removes the workspace"}
            {shown.effects.deleteBranch ? (
              <>
                {" "}
                and deletes branch <span className="font-mono">{shown.effects.branch}</span>
              </>
            ) : null}
            .
          </p>
          {losesWork ? (
            <div
              data-testid="workspace-review-lost-work"
              className="flex flex-col gap-1.5 rounded-[min(var(--radius-lg),0.625rem)] border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs"
            >
              <p className="flex items-center gap-1.5 font-medium text-destructive-foreground">
                <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
                This work exists only here and will be lost:
              </p>
              {lostWork.length > 0 ? (
                <p className="text-foreground">
                  {lostWork.map((fact, index) => (
                    <span key={fact.label} title={fact.detail}>
                      {index > 0 ? " · " : null}
                      {fact.label}
                    </span>
                  ))}
                </p>
              ) : null}
              {describable && workDescription === null ? (
                <div
                  data-testid="workspace-review-work-description-loading"
                  aria-live="polite"
                  className="flex flex-col gap-1"
                >
                  <span className="sr-only">Summarizing…</span>
                  <Skeleton aria-hidden className="h-3 w-full" />
                  <Skeleton aria-hidden className="h-3 w-2/3" />
                </div>
              ) : workDescription?.text ? (
                <p
                  data-testid="workspace-review-work-description"
                  className="text-muted-foreground"
                >
                  {workDescription.text}
                </p>
              ) : null}
            </div>
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
      {shown && conversationCount > 0 && !failure && view?.status !== "error" ? (
        <label className="flex items-start gap-2 text-xs">
          <Checkbox
            className="mt-px"
            data-testid="workspace-review-delete-conversations"
            checked={deleteConversations}
            disabled={busy}
            onCheckedChange={(checked) => setDeleteConversations(checked === true)}
          />
          <span className="flex flex-col gap-0.5">
            <span>Also delete {plural(conversationCount, "conversation")}</span>
            <span className="text-muted-foreground">
              {deleteConversations
                ? "You can undo for a few seconds."
                : "They stay in the archive."}
            </span>
          </span>
        </label>
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
            variant="destructive"
            data-testid="workspace-review-confirm"
            disabled={busy || preview === null || blocked || !props.canApply}
            onClick={() => void apply()}
          >
            {busy ? <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin" /> : null}
            {losesWork ? "Delete anyway" : "Delete workspace"}
          </Button>
        )}
      </div>
    </section>
  );
}
