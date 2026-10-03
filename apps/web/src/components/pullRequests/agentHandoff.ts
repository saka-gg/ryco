import { scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  initialDraftModelSelection,
  readEffectiveProjectPreferences,
} from "@ryco/client-runtime/state/settings";
import {
  DEFAULT_AGENT_TOKEN_MODE,
  DEFAULT_RUNTIME_MODE,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  type AgentTokenMode,
  type ComposerSourceControlContext,
  type EnvironmentApi,
  type ModelSelection,
  type ScopedProjectRef,
  type SourceControlChangeRequestDetail,
  type ThreadId,
} from "@ryco/contracts";
import { truncate } from "@ryco/shared/String";
import { useRouter } from "@tanstack/react-router";
import { DateTime } from "effect";
import { useLayoutEffect, useMemo, useRef } from "react";

import { useComposerDraftStore, type DraftThreadEnvMode } from "../../composerDraftStore";
import { readEnvironmentApi } from "../../environmentApi";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { nodeIdForHostedEnvironment } from "../../hostedHub/hostedConnectionCoordinator";
import { adoptRoutedHostedNode } from "../../hostedHub/nodeRoutes";
import { getGitStatusSnapshot } from "../../lib/gitStatusState";
import { newCommandId, newDraftId, newMessageId, newThreadId, randomUUID } from "../../lib/utils";
import { fetchSourceControlChangeRequestDetail } from "../../rpc/useSourceControl";
import { selectSidebarWorktreesForProjectRef, useStore } from "../../store";
import { buildThreadRouteParams } from "../../threadRoutes";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { notifyWorktreeSubmoduleSetup } from "../worktrees/worktreeCreationNotifications";
import { usePullRequestsPage } from "./PullRequestsPageContext";
import type { PullRequestRepositoryOption } from "./pullRequestRepositories.logic";
import { capHandoffContextDetail, dispatchHandoffThread } from "./rail/agentHandoffDispatch";
import {
  composeHandoffPrompt,
  findPullRequestWorktree,
  resolveHandoffWorkLocation,
  type HandoffWorkLocation,
  type PullRequestThreadLink,
} from "./rail/agentThreads.logic";

/**
 * Agent hand-offs from the pull requests page. Every entry point (✧ menu,
 * "Ask agent" on threads and selections, "Fix with agent" on checks and
 * status lines, conflicts, suggestions) goes through this one hook, so a
 * hand-off always lands the same way: a new thread on the change request's
 * head checkout with the pull request attached as context, its first turn
 * already sent, announced by a quiet "Started · Open" toast while the page
 * stays put. The thread then shows in the rail's Agents section.
 */
export type PullRequestAgentHandoffKind =
  | "ask"
  | "summarize"
  | "review"
  | "fix-check"
  | "address-thread"
  | "resolve-conflicts"
  | "apply-suggestion"
  | "ask-selection";

export interface PullRequestAgentHandoffRequest {
  readonly kind: PullRequestAgentHandoffKind;
  /** First message for the new thread, phrased as the user would write it. */
  readonly prompt: string;
  /** Extra material quoted under the prompt (thread excerpt, log tail, selected lines). */
  readonly context?: string;
}

export interface PullRequestAgentHandoff {
  readonly available: boolean;
  /** Why hand-offs are unavailable (shown in tooltips when `available` is false). */
  readonly unavailableReason?: string;
  start(request: PullRequestAgentHandoffRequest): Promise<void>;
  /**
   * Check the change request out (worktree) and open an empty thread there,
   * without a prompt. Defaults to the selection; a list row passes its own.
   */
  openWorktreeThread(pullRequest?: PullRequestWorktreeTarget): Promise<void>;
}

/** A pull request other than the selection to check out (the list's row menu). */
export interface PullRequestWorktreeTarget {
  readonly number: number;
  readonly title: string;
  readonly headRefName: string | null;
  readonly isCrossRepository?: boolean | undefined;
}

/** Same freshness window the composer's `#` picker gives attached detail. */
const CONTEXT_STALE_AFTER_MS = 5 * 60 * 1000;

interface HandoffTarget {
  readonly repository: PullRequestRepositoryOption;
  readonly projectRef: ScopedProjectRef;
  readonly link: PullRequestThreadLink;
  readonly title: string;
  /** The page's (uncapped) detail, used when the capped context read fails. */
  readonly detail: SourceControlChangeRequestDetail | null;
}

type Router = NonNullable<ReturnType<typeof useRouter>>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function adoptHostedTarget(projectRef: ScopedProjectRef): void {
  const nodeId = nodeIdForHostedEnvironment(projectRef.environmentId);
  if (nodeId) adoptRoutedHostedNode(nodeId);
}

/** Where the change request's head is (or will be) checked out. */
function resolveLocation(target: HandoffTarget): HandoffWorkLocation {
  const worktrees = selectSidebarWorktreesForProjectRef(useStore.getState(), target.projectRef);
  const worktree = findPullRequestWorktree(worktrees, target.link);
  const projectBranch =
    getGitStatusSnapshot({
      environmentId: target.repository.environmentId,
      cwd: target.repository.cwd,
    }).data?.refName ?? null;
  return resolveHandoffWorkLocation({ worktree, projectBranch, link: target.link });
}

/**
 * The pull request as composer context, read the way the composer's `#`
 * picker reads it (capped detail), so the agent sees exactly what a manual
 * attach would give it. When that read fails, the page's detail stands in,
 * capped the same way.
 */
async function readChangeRequestContext(
  target: HandoffTarget,
): Promise<ComposerSourceControlContext | null> {
  let detail: SourceControlChangeRequestDetail | null = null;
  try {
    detail = await fetchSourceControlChangeRequestDetail({
      environmentId: target.repository.environmentId,
      cwd: target.repository.cwd,
      reference: String(target.link.number),
    });
  } catch {
    detail = target.detail ? capHandoffContextDetail(target.detail) : null;
  }
  if (!detail) return null;
  const now = Date.now();
  return {
    id: randomUUID(),
    kind: "change-request",
    provider: detail.provider,
    reference: `${detail.provider}#${detail.number}`,
    detail,
    fetchedAt: DateTime.fromDateUnsafe(new Date(now)),
    staleAfter: DateTime.fromDateUnsafe(new Date(now + CONTEXT_STALE_AFTER_MS)),
  };
}

/** The project's default model and token mode, as a fresh thread would pick them. */
async function readDraftDefaults(
  api: EnvironmentApi,
  projectRef: ScopedProjectRef,
): Promise<{
  readonly modelSelection: ModelSelection | null;
  readonly tokenMode: AgentTokenMode | null;
}> {
  if (!api.server?.getConfig) return { modelSelection: null, tokenMode: null };
  try {
    const config = await api.server.getConfig();
    const effective = await readEffectiveProjectPreferences({
      api,
      config,
      projectId: projectRef.projectId,
    });
    const fallback = effective?.initialModelSelection.value;
    return {
      modelSelection: fallback ? initialDraftModelSelection({ effective, fallback }) : null,
      tokenMode: config.settings.defaultAgentTokenMode,
    };
  } catch {
    // Defaults are a convenience; the composer still resolves its own model.
    return { modelSelection: null, tokenMode: null };
  }
}

function draftLocationContext(location: HandoffWorkLocation, target: HandoffTarget) {
  switch (location.kind) {
    case "existing-worktree":
      return {
        envMode: "local" as DraftThreadEnvMode,
        worktreePath: location.worktreePath,
        branch: location.branch || null,
        worktreeSource: null,
      };
    case "project-root":
      return {
        envMode: "local" as DraftThreadEnvMode,
        worktreePath: null,
        branch: location.branch,
        worktreeSource: null,
      };
    case "new-worktree":
      return {
        envMode: "worktree" as DraftThreadEnvMode,
        worktreePath: null,
        branch: null,
        // Recorded, not materialized: the worktree is created from the pull
        // request on first send, through the same path the source picker uses.
        worktreeSource: {
          kind: "pr" as const,
          number: target.link.number,
          label: `#${target.link.number} ${target.title}`,
        },
      };
  }
}

async function navigateToThread(
  router: Router,
  projectRef: ScopedProjectRef,
  threadId: ThreadId,
): Promise<void> {
  adoptHostedTarget(projectRef);
  await router.navigate({
    to: "/$environmentId/$threadId",
    params: buildThreadRouteParams(scopeThreadRef(projectRef.environmentId, threadId)),
  });
}

/**
 * Opens a separate draft (the project's own draft stays untouched) on the
 * pull request's checkout with the prompt and the pull request attached, then
 * routes to it. Only for nodes that cannot name a default model (no project
 * preferences): the composer resolves the model there and the user sends.
 */
async function openHandoffDraft(input: {
  readonly target: HandoffTarget;
  readonly router: Router;
  readonly location: HandoffWorkLocation;
  readonly prompt: string;
  readonly context: ComposerSourceControlContext | null;
  readonly defaults: {
    readonly modelSelection: ModelSelection | null;
    readonly tokenMode: AgentTokenMode | null;
  };
}): Promise<void> {
  const { target, router, defaults } = input;
  const draftId = newDraftId();
  const store = useComposerDraftStore.getState();
  const placement = draftLocationContext(input.location, target);
  store.createDetachedDraftSession(target.repository.repositoryKey, target.projectRef, draftId, {
    threadId: newThreadId(),
    branch: placement.branch,
    worktreePath: placement.worktreePath,
    envMode: placement.envMode,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    ...(defaults.tokenMode ? { tokenMode: defaults.tokenMode } : {}),
  });
  store.setDraftThreadContext(draftId, { worktreeSource: placement.worktreeSource });
  store.applyStickyState(draftId);
  if (defaults.modelSelection) store.setModelSelection(draftId, defaults.modelSelection);
  if (input.prompt) store.setPrompt(draftId, input.prompt);
  if (input.context) store.addSourceControlContext(draftId, input.context);
  adoptHostedTarget(target.projectRef);
  await router.navigate({ to: "/draft/$draftId", params: { draftId } });
}

/** "Started · Open": the thread runs; the page stays where the reviewer is. */
function announceStarted(input: {
  readonly title: string;
  /** Opens the thread; null where this surface cannot navigate. */
  readonly open: (() => Promise<void>) | null;
}): void {
  const open = input.open;
  const toastId = toastManager.add(
    stackedThreadToast({
      type: "success",
      title: "Started",
      description: input.title,
      ...(open
        ? {
            actionProps: {
              children: "Open",
              onClick: () => {
                toastManager.close(toastId);
                void open();
              },
            },
          }
        : {}),
    }),
  );
}

export function usePullRequestAgentHandoff(): PullRequestAgentHandoff {
  const { repository, model } = usePullRequestsPage();
  const router = useRouter({ warn: false });
  const dispatchCapability = useHostedRpcCapability(ORCHESTRATION_WS_METHODS.dispatchCommand);
  const worktreeCapability = useHostedRpcCapability(WS_METHODS.gitCreateWorktreeForProject);
  const selection = model.selection;
  const detail = selection?.detail.data ?? null;
  const summary = selection?.summary ?? null;

  const target = useMemo<HandoffTarget | null>(() => {
    if (!repository || !selection) return null;
    return {
      repository,
      projectRef: scopeProjectRef(repository.environmentId, repository.projectId),
      link: {
        number: selection.number,
        headRefName: detail?.headRefName ?? summary?.headRefName ?? null,
        isCrossRepository: detail?.isCrossRepository ?? summary?.isCrossRepository,
      },
      title: detail?.title ?? summary?.title ?? `#${selection.number}`,
      detail,
    };
  }, [
    detail,
    repository,
    selection,
    summary?.headRefName,
    summary?.isCrossRepository,
    summary?.title,
  ]);

  // Callers hold on to `start` across renders; read the latest target and router.
  const latest = useRef({ target, router, worktreeCapability });
  useLayoutEffect(() => {
    latest.current = { target, router, worktreeCapability };
  });
  const inFlightRef = useRef(false);

  const dispatchAllowed = dispatchCapability.allowed;
  const dispatchReason = dispatchCapability.reason;
  return useMemo<PullRequestAgentHandoff>(() => {
    const unavailableReason = !repository
      ? "Choose a repository first."
      : !target
        ? "Select a pull request first."
        : !dispatchAllowed
          ? (dispatchReason ?? "Agent threads are unavailable on this connection.")
          : undefined;

    const guard = async (failure: string, run: () => Promise<void>) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        await run();
      } catch (error) {
        toastManager.add(
          stackedThreadToast({ type: "error", title: failure, description: errorText(error) }),
        );
      } finally {
        inFlightRef.current = false;
      }
    };

    const requireTarget = () => {
      const current = latest.current.target;
      if (unavailableReason !== undefined || !current) {
        throw new Error(unavailableReason ?? "Select a pull request first.");
      }
      const api = readEnvironmentApi(current.projectRef.environmentId);
      if (!api) throw new Error("This repository’s environment is not connected.");
      return { target: current, api };
    };
    // A row's pull request: only the repository has to be resolved.
    const requireTargetFor = (pullRequest: PullRequestWorktreeTarget) => {
      if (!repository) throw new Error("Choose a repository first.");
      const projectRef = scopeProjectRef(repository.environmentId, repository.projectId);
      const api = readEnvironmentApi(projectRef.environmentId);
      if (!api) throw new Error("This repository’s environment is not connected.");
      const rowTarget: HandoffTarget = {
        repository,
        projectRef,
        link: {
          number: pullRequest.number,
          headRefName: pullRequest.headRefName,
          isCrossRepository: pullRequest.isCrossRepository,
        },
        title: pullRequest.title,
        detail: null,
      };
      return { target: rowTarget, api };
    };
    // Only leaving the page needs the router; starting a thread does not.
    const requireRouter = () => {
      const currentRouter = latest.current.router;
      if (!currentRouter) throw new Error("Navigation is unavailable here.");
      return currentRouter;
    };

    const requireWorktreeCreation = (api: EnvironmentApi) => {
      const capability = latest.current.worktreeCapability;
      if (!capability.allowed) {
        throw new Error(capability.reason ?? "Worktree creation is unavailable here.");
      }
      const createWorktree = api.git.createWorktreeForProject;
      if (!createWorktree) {
        throw new Error("Worktree creation is unavailable in this environment.");
      }
      return createWorktree;
    };

    return {
      available: unavailableReason === undefined,
      ...(unavailableReason ? { unavailableReason } : {}),
      start: (request) =>
        guard("Couldn’t start an agent thread", async () => {
          const { target: current, api } = requireTarget();
          const location = resolveLocation(current);
          if (location.kind === "new-worktree") requireWorktreeCreation(api);
          const prompt = composeHandoffPrompt(request.prompt, request.context);
          const [context, defaults] = await Promise.all([
            readChangeRequestContext(current),
            readDraftDefaults(api, current.projectRef),
          ]);
          if (!defaults.modelSelection) {
            // A node that names no default model leaves the pick to the composer.
            await openHandoffDraft({
              target: current,
              router: requireRouter(),
              location,
              prompt,
              context,
              defaults,
            });
            return;
          }
          // A sent draft is titled by its prompt; the quoted material stays out.
          const title = truncate(request.prompt) || `#${current.link.number}`;
          const pending =
            location.kind === "new-worktree"
              ? toastManager.add({
                  type: "loading",
                  title: `Checking out #${current.link.number}…`,
                  timeout: 0,
                })
              : null;
          let threadId: ThreadId;
          try {
            ({ threadId } = await dispatchHandoffThread({
              api,
              projectId: current.projectRef.projectId,
              projectCwd: current.repository.cwd,
              pullRequestNumber: current.link.number,
              location,
              title,
              prompt,
              context,
              modelSelection: defaults.modelSelection,
              tokenMode: defaults.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
              newThreadId,
              newMessageId,
              newCommandId,
              onWorktreeCreated: (created) =>
                notifyWorktreeSubmoduleSetup(created.submoduleInitialization),
            }));
          } finally {
            if (pending !== null) toastManager.close(pending);
          }
          const currentRouter = latest.current.router;
          announceStarted({
            title,
            open: currentRouter
              ? () => navigateToThread(currentRouter, current.projectRef, threadId)
              : null,
          });
        }),
      openWorktreeThread: (pullRequest) =>
        guard("Couldn’t check out the pull request", async () => {
          const { target: current, api } = pullRequest
            ? requireTargetFor(pullRequest)
            : requireTarget();
          const currentRouter = requireRouter();
          const location = resolveLocation(current);
          if (location.kind !== "new-worktree") {
            // Already checked out: a fresh, empty draft there is the whole job.
            await openHandoffDraft({
              target: current,
              router: currentRouter,
              location,
              prompt: "",
              context: null,
              defaults: await readDraftDefaults(api, current.projectRef),
            });
            return;
          }
          const createWorktree = requireWorktreeCreation(api);
          const pending = toastManager.add({
            type: "loading",
            title: `Checking out #${current.link.number}…`,
            timeout: 0,
          });
          try {
            // Creates (or reuses) the pull request's worktree and its first thread.
            const created = await createWorktree({
              projectId: current.projectRef.projectId,
              intent: { kind: "pr", number: current.link.number },
            });
            notifyWorktreeSubmoduleSetup(created.submoduleInitialization);
            await navigateToThread(currentRouter, current.projectRef, created.sessionId);
          } finally {
            toastManager.close(pending);
          }
        }),
    };
  }, [dispatchAllowed, dispatchReason, repository, target]);
}
