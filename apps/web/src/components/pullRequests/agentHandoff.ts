import { scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  initialDraftModelSelection,
  readEffectiveProjectPreferences,
} from "@ryco/client-runtime/state/settings";
import {
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
import { useRouter } from "@tanstack/react-router";
import { DateTime } from "effect";
import { useLayoutEffect, useMemo, useRef } from "react";

import { useComposerDraftStore, type ComposerThreadTarget } from "../../composerDraftStore";
import { readEnvironmentApi } from "../../environmentApi";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { nodeIdForHostedEnvironment } from "../../hostedHub/hostedConnectionCoordinator";
import { adoptRoutedHostedNode } from "../../hostedHub/nodeRoutes";
import { getGitStatusSnapshot } from "../../lib/gitStatusState";
import { newDraftId, newThreadId, randomUUID } from "../../lib/utils";
import { fetchSourceControlChangeRequestDetail } from "../../rpc/useSourceControl";
import { selectSidebarWorktreesForProjectRef, useStore } from "../../store";
import { buildThreadRouteParams } from "../../threadRoutes";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { notifyWorktreeSubmoduleSetup } from "../worktrees/worktreeCreationNotifications";
import { usePullRequestsPage } from "./PullRequestsPageContext";
import type { PullRequestRepositoryOption } from "./pullRequestRepositories.logic";
import { capHandoffContextDetail } from "./rail/agentHandoffContext";
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
 * hand-off always lands the same way: the change request's head checked out
 * (its live worktree, the project checkout already on the head, or a new
 * pull request worktree) and a composer there, prefilled with the prompt and
 * the pull request attached as context. Nothing is sent for the user: they
 * read the prompt, pick the model and send, so a hand-off never runs on a
 * model the composer would not offer. A sent thread shows in the rail's
 * Agents section.
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
  /**
   * The host can check the change request out (`capabilities.checkout`), which
   * every hand-off needs. False: hand-off entry points are hidden, not disabled.
   */
  readonly supported: boolean;
  readonly available: boolean;
  /** Why hand-offs are unavailable (shown in tooltips when `available` is false). */
  readonly unavailableReason?: string;
  /**
   * Check the change request out and open a composer there, prefilled with
   * the request's prompt and the pull request as context (nothing is sent).
   */
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
  readonly headRefName: string | null;
  readonly isCrossRepository?: boolean | undefined;
}

/** Same freshness window the composer's `#` picker gives attached detail. */
const CONTEXT_STALE_AFTER_MS = 5 * 60 * 1000;

interface HandoffTarget {
  readonly repository: PullRequestRepositoryOption;
  readonly projectRef: ScopedProjectRef;
  readonly link: PullRequestThreadLink;
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

/**
 * The project's default model and token mode, seeded into a draft the way a
 * new thread's draft is (`useHandleNewThread`). The composer still checks the
 * model against the provider's live model list before it shows or sends it.
 */
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

/** A checkout that already exists: the draft runs there, nothing is created. */
type ExistingCheckout = Exclude<HandoffWorkLocation, { readonly kind: "new-worktree" }>;

function draftPlacement(location: ExistingCheckout) {
  return location.kind === "existing-worktree"
    ? { worktreePath: location.worktreePath, branch: location.branch || null }
    : { worktreePath: null, branch: location.branch };
}

/** Writes the prompt and the pull request into a composer (a draft or a server thread). */
function seedComposer(
  target: ComposerThreadTarget,
  input: { readonly prompt: string; readonly context: ComposerSourceControlContext | null },
): void {
  const store = useComposerDraftStore.getState();
  if (input.prompt) store.setPrompt(target, input.prompt);
  if (input.context) store.addSourceControlContext(target, input.context);
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
 * Opens a separate draft (the project's own draft stays untouched) on a
 * checkout that already exists, seeded the way a new thread's draft is, with
 * the prompt and the pull request attached, then routes to it.
 */
async function openHandoffDraft(input: {
  readonly target: HandoffTarget;
  readonly router: Router;
  readonly location: ExistingCheckout;
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
  const placement = draftPlacement(input.location);
  store.createDetachedDraftSession(target.repository.repositoryKey, target.projectRef, draftId, {
    threadId: newThreadId(),
    branch: placement.branch,
    worktreePath: placement.worktreePath,
    envMode: "local",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    ...(defaults.tokenMode ? { tokenMode: defaults.tokenMode } : {}),
  });
  store.applyStickyState(draftId);
  if (defaults.modelSelection) store.setModelSelection(draftId, defaults.modelSelection);
  seedComposer(draftId, { prompt: input.prompt, context: input.context });
  adoptHostedTarget(target.projectRef);
  await router.navigate({ to: "/draft/$draftId", params: { draftId } });
}

type CreateWorktreeForProject = NonNullable<EnvironmentApi["git"]["createWorktreeForProject"]>;

/**
 * Where every hand-off lands. On a checkout that already exists, a fresh
 * draft there; otherwise the pull request is checked out into its own
 * worktree first (which creates an empty thread on it) and that thread's
 * composer is seeded. Seeding happens before the route mounts, so the
 * composer opens with the caret after the prompt.
 */
async function openOnCheckout(input: {
  readonly target: HandoffTarget;
  readonly api: EnvironmentApi;
  readonly router: Router;
  readonly requireWorktreeCreation: () => CreateWorktreeForProject;
  readonly prompt: string;
  /** Read alongside the checkout; null leaves the composer without context. */
  readonly context: Promise<ComposerSourceControlContext | null> | null;
}): Promise<void> {
  const { target, api, router } = input;
  const location = resolveLocation(target);
  if (location.kind !== "new-worktree") {
    const [context, defaults] = await Promise.all([
      input.context,
      readDraftDefaults(api, target.projectRef),
    ]);
    await openHandoffDraft({ target, router, location, prompt: input.prompt, context, defaults });
    return;
  }
  const createWorktree = input.requireWorktreeCreation();
  const pending = toastManager.add({
    type: "loading",
    title: `Checking out #${target.link.number}…`,
    timeout: 0,
  });
  try {
    // Creates (or reuses) the pull request's worktree and an empty thread on it.
    const [created, context] = await Promise.all([
      createWorktree({
        projectId: target.projectRef.projectId,
        intent: { kind: "pr", number: target.link.number },
      }),
      input.context,
    ]);
    notifyWorktreeSubmoduleSetup(created.submoduleInitialization);
    seedComposer(scopeThreadRef(target.projectRef.environmentId, created.sessionId), {
      prompt: input.prompt,
      context,
    });
    await navigateToThread(router, target.projectRef, created.sessionId);
  } finally {
    toastManager.close(pending);
  }
}

export function usePullRequestAgentHandoff(): PullRequestAgentHandoff {
  const { repository, model } = usePullRequestsPage();
  const router = useRouter({ warn: false });
  // A hand-off sends nothing itself, but the composer it opens can only send with dispatch.
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
      detail,
    };
  }, [detail, repository, selection, summary?.headRefName, summary?.isCrossRepository]);

  // Callers hold on to `start` across renders; read the latest target and router.
  const latest = useRef({ target, router, worktreeCapability });
  useLayoutEffect(() => {
    latest.current = { target, router, worktreeCapability };
  });
  const inFlightRef = useRef(false);

  const dispatchAllowed = dispatchCapability.allowed;
  const dispatchReason = dispatchCapability.reason;
  const supported = model.capabilities.checkout;
  const hostName = model.provider?.name ?? "This host";
  return useMemo<PullRequestAgentHandoff>(() => {
    const unavailableReason = !supported
      ? `${hostName} change requests can’t be checked out here.`
      : !repository
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
      if (!supported) throw new Error(unavailableReason ?? "Checkout is unavailable here.");
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
        detail: null,
      };
      return { target: rowTarget, api };
    };
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
      supported,
      available: unavailableReason === undefined,
      ...(unavailableReason ? { unavailableReason } : {}),
      start: (request) =>
        guard("Couldn’t open an agent thread", async () => {
          const { target: current, api } = requireTarget();
          await openOnCheckout({
            target: current,
            api,
            router: requireRouter(),
            requireWorktreeCreation: () => requireWorktreeCreation(api),
            prompt: composeHandoffPrompt(request.prompt, request.context),
            context: readChangeRequestContext(current),
          });
        }),
      openWorktreeThread: (pullRequest) =>
        guard("Couldn’t check out the pull request", async () => {
          const { target: current, api } = pullRequest
            ? requireTargetFor(pullRequest)
            : requireTarget();
          await openOnCheckout({
            target: current,
            api,
            router: requireRouter(),
            requireWorktreeCreation: () => requireWorktreeCreation(api),
            prompt: "",
            context: null,
          });
        }),
    };
  }, [dispatchAllowed, dispatchReason, hostName, repository, supported, target]);
}
