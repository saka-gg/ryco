import type { EnvironmentId } from "@ryco/contracts";
import { useCallback } from "react";

import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import type { ComposerExecutionTarget } from "./ExecutionTarget.logic";
import { ExecutionTargetSelect } from "./ExecutionTargetSelect";
import { workLocationDraftPatch } from "./NewThreadWorkLocation.logic";

export interface NewThreadContextBarProps {
  readonly draftId: DraftId | undefined;
  /** Git projects only; a "No project" chat or a plain folder has no worktrees. */
  readonly worktreeAvailable: boolean;
  readonly envLocked: boolean;
  /** The composer footer's device control, hoisted here on the new-thread surface. */
  readonly executionTargets: ReadonlyArray<ComposerExecutionTarget>;
  readonly executionEnvironmentId: EnvironmentId;
  readonly executionTargetLocked: boolean;
  readonly onExecutionTargetChange: ((environmentId: EnvironmentId) => void) | undefined;
  readonly onComposerFocusRequest: (() => void) | undefined;
}

/**
 * The row of pills directly above the new-thread composer: a one-click "New
 * worktree" switch on the left and the device the thread runs on at the right.
 *
 * The switch only flips between the project root and a new worktree; existing
 * worktrees and the base to branch from stay in the "Work in …" sentence, which
 * reads the same draft fields and so follows the switch.
 */
export function NewThreadContextBar({
  draftId,
  worktreeAvailable,
  envLocked,
  executionTargets,
  executionEnvironmentId,
  executionTargetLocked,
  onExecutionTargetChange,
  onComposerFocusRequest,
}: NewThreadContextBarProps) {
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const draftThread = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId) : null,
  );
  const newWorktree = draftThread?.envMode === "worktree" && !draftThread.worktreePath;
  const canToggle =
    worktreeAvailable && draftId !== undefined && draftThread !== null && !envLocked;
  const showDevice = executionTargets.length > 0;

  const toggleNewWorktree = useCallback(() => {
    if (!draftId) return;
    setDraftThreadContext(
      draftId,
      workLocationDraftPatch({ kind: newWorktree ? "projectRoot" : "newWorktree", worktree: null }),
    );
    onComposerFocusRequest?.();
  }, [draftId, newWorktree, onComposerFocusRequest, setDraftThreadContext]);

  if (!canToggle && !showDevice) {
    // Keeps the hero and composer the same distance apart as the pill row would.
    return <div aria-hidden className="mb-2 h-5" />;
  }

  return (
    <div
      className="mx-auto mb-2 flex w-full max-w-208 items-center justify-between gap-2 px-1"
      data-testid="new-thread-context-bar"
    >
      {canToggle ? (
        <button
          type="button"
          role="switch"
          aria-checked={newWorktree}
          aria-label="New worktree"
          title={
            newWorktree
              ? "The worktree is created from the chosen base when you send"
              : "Run this thread in a new worktree"
          }
          data-on={newWorktree}
          className="new-thread-pill new-thread-worktree-toggle"
          onClick={toggleNewWorktree}
        >
          <span aria-hidden className="new-thread-worktree-switch" />
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            className="new-thread-worktree-fork size-3.5 shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 3v12" />
            <circle cx="6" cy="18" r="3" />
            <path data-part="grow" d="M15 6a9 9 0 0 0-9 9" />
            <circle data-part="tip" cx="18" cy="6" r="3" />
          </svg>
          <span>New worktree</span>
        </button>
      ) : (
        <span />
      )}
      {showDevice ? (
        <span className="flex min-w-0 items-center">
          <ExecutionTargetSelect
            appearance="pill"
            targets={executionTargets}
            selectedEnvironmentId={executionEnvironmentId}
            locked={executionTargetLocked}
            onChange={onExecutionTargetChange}
          />
        </span>
      ) : null}
    </div>
  );
}
