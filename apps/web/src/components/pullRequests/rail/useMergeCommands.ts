import type { ChangeRequestUpdateAction } from "@ryco/contracts";
import { preferredUpdateBranchMethod } from "@ryco/shared/sourceControl";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import {
  invalidateSourceControl,
  useMergeChangeRequestMutation,
  useUpdateChangeRequestMutation,
} from "../../../rpc/useSourceControl";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { usePullRequestAgentHandoff } from "../agentHandoff";
import { usePullRequestSelection, usePullRequestsPage } from "../PullRequestsPageContext";
import { isHeadMovedError, type MergeStatusLine, type NextActionCommand } from "./mergeFacts.logic";
import { usePullRequestRailStore } from "./railStore";
import type { MergeModel } from "./useMergeModel";

/** Label the next-action button rolls to while its request is in flight. */
export const PENDING_LABEL: Partial<Record<NextActionCommand["type"], string>> = {
  merge: "Merging…",
  "update-branch": "Updating…",
  "set-draft": "Saving…",
  "enable-auto-merge": "Enabling…",
  "disable-auto-merge": "Cancelling…",
  "delete-branch": "Deleting…",
  reopen: "Reopening…",
  close: "Closing…",
  "checkout-worktree": "Checking out…",
};

const FAILURE_TITLE: Partial<Record<NextActionCommand["type"], string>> = {
  merge: "Couldn’t merge",
  "update-branch": "Couldn’t update the branch",
  "set-draft": "Couldn’t change the draft state",
  "enable-auto-merge": "Couldn’t enable auto-merge",
  "disable-auto-merge": "Couldn’t cancel auto-merge",
  "delete-branch": "Couldn’t delete the branch",
  reopen: "Couldn’t reopen the pull request",
  close: "Couldn’t close the pull request",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface MergeCommands {
  /** The command whose request is in flight. */
  readonly pending: NextActionCommand["type"] | null;
  /** Runs a command that needs no further UI (confirm, popover, dialog). */
  run(command: NextActionCommand): Promise<void>;
  /** A status line's hover ghost ("Fix" hands off to an agent, "Update" updates the branch). */
  runFix(line: MergeStatusLine): void;
}

/**
 * Executes next-action commands: navigation through `nav`, lifecycle changes
 * through one `updateChangeRequest` mutation, the merge itself with
 * `expectedHeadSha`, and agent hand-offs. Failures surface as one quiet toast;
 * a head that moved under the user gets its own wording and a refresh.
 */
export function useMergeCommands(model: MergeModel | null): MergeCommands {
  const { nav, readerKey, model: pageModel } = usePullRequestsPage();
  const selection = usePullRequestSelection();
  const handoff = usePullRequestAgentHandoff();
  const update = useUpdateChangeRequestMutation(selection.mutationTarget);
  const merge = useMergeChangeRequestMutation({
    environmentId: selection.mutationTarget.environmentId,
    cwd: selection.mutationTarget.cwd,
    reference: selection.reference,
  });
  const requestPicker = usePullRequestRailStore((state) => state.requestPicker);
  const headGuard = pageModel.capabilities.merge.expectedHeadSha;
  const [pending, setPending] = useState<NextActionCommand["type"] | null>(null);
  const inFlightRef = useRef(false);

  // Commands run from menus and timers; they read the latest render's facts.
  const latest = useRef({ model, selection, readerKey });
  useLayoutEffect(() => {
    latest.current = { model, selection, readerKey };
  });

  const refresh = useCallback(() => {
    invalidateSourceControl({
      environmentId: pageModel.environmentId,
      cwd: pageModel.cwd,
    });
  }, [pageModel.cwd, pageModel.environmentId]);

  const mutate = useCallback(
    async (type: NextActionCommand["type"], perform: () => Promise<unknown>) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setPending(type);
      try {
        await perform();
      } catch (error) {
        if (isHeadMovedError(error)) {
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: "New commits were pushed",
              description: "Review the latest changes, then try again.",
            }),
          );
          refresh();
        } else {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: FAILURE_TITLE[type] ?? "Something went wrong",
              description: errorText(error),
            }),
          );
        }
      } finally {
        inFlightRef.current = false;
        setPending(null);
      }
    },
    [refresh],
  );

  const updateWith = useCallback(
    (type: NextActionCommand["type"], action: ChangeRequestUpdateAction) =>
      mutate(type, () => update.mutateAsync(action)),
    [mutate, update],
  );

  const run = useCallback(
    async (command: NextActionCommand) => {
      const { model: current, selection: currentSelection, readerKey: key } = latest.current;
      const headSha = currentSelection.headSha;
      const number = currentSelection.number;
      switch (command.type) {
        case "reveal-job":
          nav.revealJob(command.jobId);
          return;
        case "open-checks":
          nav.setTab("checks");
          return;
        case "open-files":
          nav.setTab("files");
          return;
        case "reveal-thread":
          nav.revealThread(command.threadId);
          return;
        case "request-review":
          if (key) requestPicker(key, "reviewers");
          nav.setTab("conversation");
          return;
        case "checkout-worktree":
          await mutate(command.type, () => handoff.openWorktreeThread());
          return;
        case "resolve-with-agent": {
          const detail = current?.detail;
          await handoff.start({
            kind: "resolve-conflicts",
            prompt: `Resolve the merge conflicts in pull request #${number}${
              detail ? ` (${detail.headRefName} into ${detail.baseRefName})` : ""
            }, then push the result.`,
          });
          return;
        }
        case "update-branch":
          if (!headSha) return;
          await updateWith(command.type, {
            kind: "update-branch",
            method: command.method,
            expectedHeadSha: headSha,
          });
          return;
        case "set-draft":
          await updateWith(command.type, { kind: "set-draft", draft: command.draft });
          return;
        case "enable-auto-merge":
          await updateWith(command.type, {
            kind: "auto-merge",
            enabled: true,
            ...(current ? { mergeMethod: current.method } : {}),
            ...(headSha ? { expectedHeadSha: headSha } : {}),
          });
          return;
        case "disable-auto-merge":
          await updateWith(command.type, { kind: "auto-merge", enabled: false });
          return;
        case "delete-branch":
          await updateWith(command.type, { kind: "delete-branch" });
          return;
        case "reopen":
          await updateWith(command.type, { kind: "reopen" });
          return;
        case "close":
          await updateWith(command.type, { kind: "close" });
          return;
        case "merge":
          if (!current) return;
          await mutate(command.type, async () => {
            const result = await merge.mutateAsync({
              mergeMethod: current.method,
              ...(current.menu.deleteBranchDefault !== null
                ? { deleteBranch: current.deleteBranch }
                : {}),
              // Hosts that cannot guard the head are not asked to.
              ...(headGuard ? { expectedHeadSha: headSha } : {}),
            });
            if (result.outcome === "enqueued") {
              toastManager.add(
                stackedThreadToast({
                  type: "info",
                  title: "Queued to merge",
                  description: `#${number} merges when the queue reaches it.`,
                }),
              );
            }
          });
          return;
        case "merge-stack":
          // Opens the merge-through picker; the button owns that popover.
          return;
      }
    },
    [handoff, headGuard, merge, mutate, nav, requestPicker, updateWith],
  );

  const runFix = useCallback(
    (line: MergeStatusLine) => {
      const { selection: currentSelection } = latest.current;
      const number = currentSelection.number;
      switch (line.fix?.kind) {
        case "fix-check": {
          const failing = currentSelection.checks.failing.map((check) => `"${check.label}"`);
          void handoff.start({
            kind: "fix-check",
            prompt: `${failing.length > 1 ? `The checks ${failing.join(", ")} are` : `The check ${failing[0] ?? `"${line.text}"`} is`} failing on pull request #${number}. Find the cause, fix it, and push the fix.`,
          });
          return;
        }
        case "resolve-conflicts":
          void run({ type: "resolve-with-agent" });
          return;
        case "update-branch": {
          // The host's own way to update (GitLab only rebases).
          const method = preferredUpdateBranchMethod(pageModel.capabilities);
          if (method) void run({ type: "update-branch", method });
          return;
        }
        case undefined:
          return;
      }
    },
    [handoff, pageModel.capabilities, run],
  );

  return { pending, run, runFix };
}
