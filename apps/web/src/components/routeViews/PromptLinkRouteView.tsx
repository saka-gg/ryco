import {
  findPromptLinkProject,
  PROMPT_LINK_LOOKUP_WAIT_MS,
  promptLinkChatEnvironmentId,
  promptLinkModelNote,
  promptLinkPullRequestCheckoutNote,
  resolvePromptLinkModelSelection,
  resolvePromptLinkPullRequest,
} from "@ryco/client-runtime/promptLinks";
import { scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { resolveChatsAvailability } from "@ryco/client-runtime/state/composer";
import type { Project } from "@ryco/client-runtime/state/threads";
import { WS_METHODS, type EnvironmentId } from "@ryco/contracts";
import {
  parseNewThreadLink,
  promptLinkPullRequestUrl,
  promptLinkRepositoryName,
  type LinkedPrompt,
  type NewThreadLink,
  type PromptLinkPullRequest,
  type PromptLinkRepository,
} from "@ryco/shared/promptLinks";
import { useLocation, useRouter } from "@tanstack/react-router";
import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";

import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { isHostedHubMode } from "../../env";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  readEnvironmentConnection,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { readEnvironmentServerConfig } from "../../hooks/useChatsAvailability";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { readHostedRpcCapability, useHostedEnvironmentRecord } from "../../hostedHub/capabilities";
import { useHostedWorkspaceState } from "../../hostedHub/hostedConnectionCoordinator";
import { isHostedEnvironmentSessionAdoptable, useHostedHubStore } from "../../hostedHub/state";
import { useDesktopWorkspaceState } from "../../platform/desktopWorkspace";
import {
  type AppState,
  selectBootstrapCompleteForEnvironment,
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  selectSidebarWorktreesAcrossEnvironments,
  useStore,
} from "../../store";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../../threadRoutes";
import { placeLinkedPrompt } from "../promptLinks/linkedPrompt";
import {
  resolvePromptLinkLookup,
  type PromptLinkLookupState,
} from "../promptLinks/promptLinkLookup.logic";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";

/** The `/new` route body, loaded by the route file through `lazyRouteComponent`. */
export function PromptLinkRoute(): ReactElement {
  // Read raw: the router's search parsing turns `prompt=123` into a number.
  const search = useLocation({ select: (location) => location.searchStr });
  const locationKey = useLocation({
    select: (location) => location.state.__TSR_key ?? location.href,
  });
  return (
    <PromptLinkView key={`${locationKey}${search}`} search={search} locationKey={locationKey} />
  );
}

/** A parsed link, or why it cannot open. `locationKey` names the history entry it came from. */
export function PromptLinkView(props: {
  readonly search: string;
  readonly locationKey: string;
}): ReactElement {
  const parsed = useMemo(() => parseNewThreadLink(props.search), [props.search]);
  if (!parsed.ok) return <LinkPage title="Could not open the link" description={parsed.error} />;
  return <PromptLinkOpener link={parsed.value} locationKey={props.locationKey} />;
}

type LinkState =
  | { readonly status: "waiting" }
  | { readonly status: "opening" }
  | { readonly status: "opened" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "missing-repository"; readonly repository: PromptLinkRepository };

/** Where a pull request link's draft runs, once the link resolved to a project. */
interface PullRequestPlacement {
  readonly pullRequest: PromptLinkPullRequest;
  readonly worktree: { readonly worktreePath: string | null; readonly branch: string } | null;
}

// A link opens once per history entry. Going back to it lands here again, and opening it a
// second time for the same click would surprise more than it helps.
const handledLinkKeys = new Set<string>();

const selectShellCurrentByEnvironmentId = (state: AppState): Record<string, boolean> =>
  Object.fromEntries(
    Object.entries(state.environmentStateById).map(([environmentId, environment]) => [
      environmentId,
      environment.bootstrapComplete,
    ]),
  );

/**
 * When the link may resolve (`resolvePromptLinkLookup`). In hosted mode it
 * waits for the selected node's own session to be adoptable, the one rule
 * the hosted lifecycle owner applies; it never opens a connection itself.
 */
function usePromptLinkLookup(): PromptLinkLookupState {
  const hosted = isHostedHubMode();
  const selectedEnvironmentId = useHostedHubStore(
    (state) => state.selectedNode?.environmentId ?? null,
  );
  const record = useHostedEnvironmentRecord(hosted ? selectedEnvironmentId : null);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const shellCurrentByEnvironmentId = useStore(useShallow(selectShellCurrentByEnvironmentId));
  const saved = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const desktopMachines = useDesktopWorkspaceState().machines;
  const hostedMachines = useHostedWorkspaceState().machines;
  return useMemo(
    () =>
      resolvePromptLinkLookup({
        hosted,
        // The record is read above so a change to it re-renders; the rule is the one function.
        hostedSessionAdoptable:
          record !== undefined &&
          selectedEnvironmentId !== null &&
          isHostedEnvironmentSessionAdoptable(selectedEnvironmentId),
        primaryEnvironmentId: hosted ? null : primaryEnvironmentId,
        shellCurrentByEnvironmentId,
        connections: [
          ...Object.entries(saved).map(([environmentId, runtime]) => ({
            environmentId: environmentId as EnvironmentId,
            connectionState: runtime.connectionState,
          })),
          ...desktopMachines,
          ...hostedMachines,
        ],
      }),
    [
      desktopMachines,
      hosted,
      hostedMachines,
      primaryEnvironmentId,
      record,
      saved,
      selectedEnvironmentId,
      shellCurrentByEnvironmentId,
    ],
  );
}

/** The node's providers, from its live connection when there is one. */
function readProviders(environmentId: EnvironmentId) {
  const config =
    readEnvironmentConnection(environmentId)?.config.read() ??
    readEnvironmentServerConfig(environmentId);
  return config?.providers ?? [];
}

function PromptLinkOpener(props: {
  readonly link: NewThreadLink;
  readonly locationKey: string;
}): ReactElement {
  const { link, locationKey } = props;
  const router = useRouter();
  const lookup = usePromptLinkLookup();
  const { handleNewThread, handleNewChat } = useNewThreadHandler();
  const [state, setState] = useState<LinkState>(() =>
    handledLinkKeys.has(locationKey) ? { status: "opened" } : { status: "waiting" },
  );
  const [waitedOut, setWaitedOut] = useState(false);

  // Machines still connecting get a bounded wait; one that keeps reconnecting must not hold
  // the link forever.
  useEffect(() => {
    if (!lookup.gateOpen || lookup.settled) return;
    const timer = setTimeout(() => setWaitedOut(true), PROMPT_LINK_LOOKUP_WAIT_MS);
    return () => clearTimeout(timer);
  }, [lookup.gateOpen, lookup.settled]);

  const openedDraftId = (): DraftId | null => {
    const params = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    const target = resolveThreadRouteTarget(params);
    return target?.kind === "draft" ? target.draftId : null;
  };

  /** The link's model and notes, for a draft on `environmentId`. */
  const modelRequest = (environmentId: EnvironmentId, draftId: DraftId) => {
    if (link.kind !== "new" || link.provider === null) return { note: null, apply: () => {} };
    const request = { provider: link.provider, model: link.model };
    const resolved = resolvePromptLinkModelSelection(readProviders(environmentId), request);
    return {
      note: promptLinkModelNote(request, resolved),
      apply: () => {
        if (resolved)
          useComposerDraftStore.getState().setModelSelection(draftId, resolved.selection);
      },
    };
  };

  const openProjectDraft = async (
    project: Project,
    prompt: LinkedPrompt | null,
    pullRequest: PullRequestPlacement | null,
  ) => {
    await handleNewThread(scopeProjectRef(project.environmentId, project.id));
    const draftId = openedDraftId();
    const session = draftId ? useComposerDraftStore.getState().getDraftSession(draftId) : null;
    if (
      draftId === null ||
      session === null ||
      session.environmentId !== project.environmentId ||
      session.projectId !== project.id
    ) {
      setState({ status: "failed", message: `Ryco could not open a draft in ${project.name}.` });
      return;
    }
    setState({ status: "opened" });
    const model = modelRequest(project.environmentId, draftId);
    const notes: Array<string | null> = [model.note];
    let applyLocation = () => {};
    if (pullRequest !== null) {
      const store = useComposerDraftStore.getState();
      const { worktree } = pullRequest;
      const worktreePath = worktree?.worktreePath ?? null;
      if (worktree && worktreePath !== null) {
        // The pull request is checked out already: the draft runs there. This is the
        // "existing worktree" row of `NewThreadWorkLocation.logic.ts`; importing that module
        // here would split it out of the chat route's chunk.
        applyLocation = () =>
          store.setDraftThreadContext(draftId, {
            envMode: "local",
            worktreePath,
            branch: worktree.branch || null,
            worktreeSource: null,
          });
      } else if (
        readHostedRpcCapability(WS_METHODS.gitCreateWorktreeForProject, project.environmentId)
          .allowed
      ) {
        // Recorded only: the worktree is created by Send, the way a picked pull request is.
        notes.push(promptLinkPullRequestCheckoutNote(pullRequest.pullRequest));
        const { number } = pullRequest.pullRequest;
        applyLocation = () =>
          store.setDraftThreadContext(draftId, {
            envMode: "worktree",
            worktreePath: null,
            branch: null,
            worktreeSource: { kind: "pr", number, label: `#${number}` },
            worktreeBranchName: null,
            fetchOrigin: true,
          });
      } else {
        notes.push(
          `This machine cannot check out pull request #${pullRequest.pullRequest.number} from here, so the draft runs where the project's drafts usually run.`,
        );
      }
    }
    placeLinkedPrompt(draftId, prompt, {
      notes,
      apply: () => {
        model.apply();
        applyLocation();
      },
    });
  };

  const openChat = async (prompt: LinkedPrompt | null) => {
    setState({ status: "opening" });
    const store = useStore.getState();
    const chatEnvironmentIds = Object.keys(store.environmentStateById)
      .map((environmentId) => environmentId as EnvironmentId)
      .filter((environmentId) => {
        if (!selectBootstrapCompleteForEnvironment(store, environmentId)) return false;
        const config = readEnvironmentServerConfig(environmentId);
        return config === null || resolveChatsAvailability(config).available;
      });
    const selected = isHostedHubMode()
      ? useHostedHubStore.getState().selectedNode?.environmentId
      : undefined;
    const environmentId =
      selected && chatEnvironmentIds.includes(selected)
        ? selected
        : promptLinkChatEnvironmentId(
            selectSidebarThreadsAcrossEnvironments(store),
            chatEnvironmentIds,
          );
    if (environmentId === null) {
      setState({
        status: "failed",
        message: "None of your machines can start a chat without a project right now.",
      });
      return;
    }
    await handleNewChat(environmentId);
    const draftId = openedDraftId();
    const session = draftId ? useComposerDraftStore.getState().getDraftSession(draftId) : null;
    if (draftId === null || session?.environmentId !== environmentId || !session.pendingChat) {
      setState({ status: "failed", message: "Ryco could not start a chat without a project." });
      return;
    }
    setState({ status: "opened" });
    const model = modelRequest(environmentId, draftId);
    placeLinkedPrompt(draftId, prompt, { notes: [model.note], apply: model.apply });
  };

  /** "Start without a project": a pull request link names its pull request in the prompt. */
  const openWithoutProject = () => {
    if (link.kind === "new") return openChat(link.prompt);
    const text = [link.prompt?.text, promptLinkPullRequestUrl(link.pullRequest)]
      .filter(Boolean)
      .join("\n\n");
    return openChat({ text, hiddenCharacters: link.prompt?.hiddenCharacters ?? 0 });
  };

  const start = useEffectEvent(async () => {
    handledLinkKeys.add(locationKey);
    setState({ status: "opening" });
    const store = useStore.getState();
    const projects = selectProjectsAcrossEnvironments(store);
    const threads = selectSidebarThreadsAcrossEnvironments(store);
    const options = {
      isEnvironmentAvailable: (environmentId: EnvironmentId) =>
        selectBootstrapCompleteForEnvironment(store, environmentId),
    };
    if (link.kind === "pull-request") {
      const target = resolvePromptLinkPullRequest({
        projects,
        threads,
        worktrees: selectSidebarWorktreesAcrossEnvironments(store),
        pullRequest: link.pullRequest,
        options,
      });
      if (target === null) {
        setState({ status: "missing-repository", repository: link.pullRequest });
        return;
      }
      if (target.thread !== null) {
        const threadRef = scopeThreadRef(target.thread.environmentId, target.thread.id);
        setState({ status: "opened" });
        await router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
          replace: true,
        });
        if (link.prompt !== null) placeLinkedPrompt(threadRef, link.prompt);
        return;
      }
      await openProjectDraft(target.project, link.prompt, {
        pullRequest: link.pullRequest,
        worktree: target.worktree,
      });
      return;
    }
    if (link.repository === null) {
      await openChat(link.prompt);
      return;
    }
    const project = findPromptLinkProject({
      projects,
      threads,
      repository: link.repository,
      options,
    });
    if (project === null) {
      setState({ status: "missing-repository", repository: link.repository });
      return;
    }
    await openProjectDraft(project, link.prompt, null);
  });

  // Runs once per link, when the lookup may decide. Later shell updates must not open it again.
  useEffect(() => {
    if (state.status !== "waiting" || !lookup.gateOpen) return;
    if (!lookup.settled && !waitedOut) return;
    void start().catch(() =>
      setState({ status: "failed", message: "Ryco could not open a draft for this link." }),
    );
  }, [lookup.gateOpen, lookup.settled, state.status, waitedOut]);

  switch (state.status) {
    case "waiting":
      return (
        <LinkPage
          title="Opening the link…"
          description={
            lookup.gateOpen
              ? "Looking for the project on your machines."
              : "Waiting for your machine to connect."
          }
        />
      );
    case "opening":
      return <LinkPage title="Opening the link…" />;
    case "opened":
      return (
        <LinkPage
          title="This link is open"
          description="Its prompt is in a draft. Nothing is sent until you press Send."
        >
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              handledLinkKeys.delete(locationKey);
              setState({ status: "waiting" });
            }}
          >
            Open it again
          </Button>
        </LinkPage>
      );
    case "failed":
      return <LinkPage title="Could not open the link" description={state.message} />;
    case "missing-repository":
      return (
        <LinkPage
          title={`You don't have ${promptLinkRepositoryName(state.repository)}`}
          description="None of your projects is this repository. Add it as a project, then open the link again, or start without a project."
        >
          <Button size="sm" onClick={() => void openWithoutProject()}>
            Start without a project
          </Button>
        </LinkPage>
      );
  }
}

function LinkPage(props: {
  readonly title: string;
  readonly description?: string;
  readonly children?: ReactNode;
}): ReactElement {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <Empty className="flex-1" data-prompt-link-page="">
        <EmptyHeader className="max-w-md">
          <EmptyTitle>{props.title}</EmptyTitle>
          {props.description ? <EmptyDescription>{props.description}</EmptyDescription> : null}
          {props.children ? (
            <div className="mt-5 flex justify-center gap-2">{props.children}</div>
          ) : null}
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}
