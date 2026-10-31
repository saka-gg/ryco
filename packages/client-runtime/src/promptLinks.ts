import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  RepositoryIdentity,
  ServerProvider,
} from "@ryco/contracts";
import { normalizeGitRemoteUrl } from "@ryco/shared/git";
import { resolveSelectableModel, type SelectableModelOption } from "@ryco/shared/model";
import { isChatProject, type ProjectKindCarrier } from "@ryco/shared/projectKind";
import {
  promptLinkRepositoryKey,
  promptLinkRepositoryName,
  type LinkedPrompt,
  type PromptLinkPullRequest,
  type PromptLinkRepository,
} from "@ryco/shared/promptLinks";
import {
  readWorktreePullRequestLinks,
  type WorktreePullRequestSource,
} from "@ryco/shared/worktreePullRequests";

/**
 * How web and the native app resolve a prompt link (`@ryco/shared/promptLinks`) against what
 * this client knows: the shells' projects, threads and worktrees, and each node's providers.
 * Both read the same store selectors, so a link lands in the same project and thread on every
 * surface. Nothing here writes: the surfaces fill a draft with the answer, and only the user's
 * Send runs anything.
 */

/** How long a link waits for machines still connecting before it decides what the user has. */
export const PROMPT_LINK_LOOKUP_WAIT_MS = 6_000;

/** One machine as a link's lookup sees it. */
export interface PromptLinkLookupEnvironment {
  /** Its projects and threads are the current ones (its shell snapshot was applied). */
  readonly shellCurrent: boolean;
  /** It is on its way to connecting, so its projects may still arrive. */
  readonly connecting: boolean;
}

/**
 * Whether every machine sent its live projects or settled without them. A link waits for this
 * (or {@link PROMPT_LINK_LOOKUP_WAIT_MS}) before it says a repository is missing, so one machine
 * that keeps reconnecting cannot hold a link forever.
 */
export function isPromptLinkLookupSettled(
  environments: ReadonlyArray<PromptLinkLookupEnvironment>,
): boolean {
  return environments.every((environment) => environment.shellCurrent || !environment.connecting);
}

interface PromptLinkProject extends ProjectKindCarrier {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly name: string;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
  readonly createdAt?: string | undefined;
  readonly updatedAt?: string | undefined;
}

interface PromptLinkThread {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly createdAt: string;
  readonly updatedAt?: string | undefined;
  readonly latestUserMessageAt?: string | null | undefined;
  readonly archivedAt: string | null;
  readonly worktreeId?: string | null | undefined;
  readonly worktreePath: string | null;
}

interface PromptLinkWorktree extends WorktreePullRequestSource {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly branch: string;
  readonly worktreePath: string | null;
  readonly archivedAt: string | null;
  readonly checkoutRemovedAt?: string | null | undefined;
  readonly updatedAt: string;
}

export interface PromptLinkLookupOptions {
  /** Machines a draft can open on now come first; others only when no such machine has it. */
  readonly isEnvironmentAvailable?: (environmentId: EnvironmentId) => boolean;
}

/** When a thread last moved: its latest prompt, else its last update, else creation. */
const threadActivityAt = (thread: PromptLinkThread) =>
  thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt;

const projectKey = (environmentId: EnvironmentId, projectId: ProjectId) =>
  `${environmentId}\u0000${projectId}`;

/**
 * The repository the project is itself: its `origin` remote, else the primary remote its
 * identity names. A fork with an `upstream` remote groups with its upstream, but it is the
 * fork's owner's copy, so a link to the upstream repository does not pick it.
 */
export function promptLinkOwnRepositoryKey(
  identity: RepositoryIdentity | null | undefined,
): string | null {
  if (identity == null) return null;
  const origin = identity.remotes?.find((remote) => remote.name === "origin");
  return (origin ? normalizeGitRemoteUrl(origin.url) : identity.canonicalKey).toLowerCase();
}

/**
 * The repository the project's pull request numbers resolve in: the primary remote its identity
 * names (`upstream`, else `origin`), the one a worktree for `#123` is created from.
 */
function pullRequestRepositoryKey(identity: RepositoryIdentity | null | undefined): string | null {
  return identity?.canonicalKey.toLowerCase() ?? null;
}

/**
 * Projects most recently active first: machines a draft can open on now ahead of the others,
 * then by their latest thread (their own update time when they have none).
 */
export function orderPromptLinkProjects<P extends PromptLinkProject>(
  projects: ReadonlyArray<P>,
  threads: ReadonlyArray<PromptLinkThread>,
  options?: PromptLinkLookupOptions,
): P[] {
  const latest = new Map<string, string>();
  for (const thread of threads) {
    const key = projectKey(thread.environmentId, thread.projectId);
    const at = threadActivityAt(thread);
    if (at > (latest.get(key) ?? "")) latest.set(key, at);
  }
  const activityOf = (project: P) =>
    latest.get(projectKey(project.environmentId, project.id)) ??
    project.updatedAt ??
    project.createdAt ??
    "";
  const available = (project: P) =>
    options?.isEnvironmentAvailable?.(project.environmentId) === false ? 1 : 0;
  return projects.toSorted(
    (left, right) =>
      available(left) - available(right) ||
      activityOf(right).localeCompare(activityOf(left)) ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );
}

/**
 * The project a link's repository names: the user's most recently active project that is that
 * exact repository. Chats never count.
 */
export function findPromptLinkProject<P extends PromptLinkProject>(input: {
  readonly projects: ReadonlyArray<P>;
  readonly threads: ReadonlyArray<PromptLinkThread>;
  readonly repository: PromptLinkRepository;
  readonly options?: PromptLinkLookupOptions;
}): P | null {
  const key = promptLinkRepositoryKey(input.repository);
  const matching = input.projects.filter(
    (project) =>
      !isChatProject(project) && promptLinkOwnRepositoryKey(project.repositoryIdentity) === key,
  );
  return orderPromptLinkProjects(matching, input.threads, input.options)[0] ?? null;
}

/** Where a pull request link opens. */
export interface PromptLinkPullRequestTarget<P, T, W> {
  readonly project: P;
  /** The most recently active thread working on the pull request, when there is one. */
  readonly thread: T | null;
  /** A checkout that already carries the pull request in `project`, when there is one. */
  readonly worktree: W | null;
}

const isLiveWorktree = (worktree: PromptLinkWorktree) =>
  worktree.archivedAt === null && worktree.worktreePath !== null && !worktree.checkoutRemovedAt;

const carriesPullRequest = (worktree: PromptLinkWorktree, number: number) =>
  readWorktreePullRequestLinks(worktree).some(
    (link) => link.number === number && !link.dismissedAt,
  );

/**
 * Where a pull request link opens: the thread most recently working on it (in a live checkout
 * that carries it) on any machine, else the most recently active project of the repository it
 * belongs to, with that project's checkout of it when one exists. Null when no project is that
 * repository. Only a project whose pull request numbers resolve in that repository counts, so
 * the checkout Send makes is the linked pull request.
 */
export function resolvePromptLinkPullRequest<
  P extends PromptLinkProject,
  T extends PromptLinkThread,
  W extends PromptLinkWorktree,
>(input: {
  readonly projects: ReadonlyArray<P>;
  readonly threads: ReadonlyArray<T>;
  readonly worktrees: ReadonlyArray<W>;
  readonly pullRequest: PromptLinkPullRequest;
  readonly options?: PromptLinkLookupOptions;
}): PromptLinkPullRequestTarget<P, T, W> | null {
  const key = promptLinkRepositoryKey(input.pullRequest);
  const candidates = orderPromptLinkProjects(
    input.projects.filter(
      (project) =>
        !isChatProject(project) && pullRequestRepositoryKey(project.repositoryIdentity) === key,
    ),
    input.threads,
    input.options,
  );
  if (candidates.length === 0) return null;
  const carrying = input.worktrees.filter(
    (worktree) =>
      isLiveWorktree(worktree) &&
      carriesPullRequest(worktree, input.pullRequest.number) &&
      candidates.some(
        (project) =>
          project.environmentId === worktree.environmentId && project.id === worktree.projectId,
      ),
  );
  const worktreeOf = (thread: T) =>
    carrying.find(
      (worktree) =>
        worktree.environmentId === thread.environmentId &&
        worktree.projectId === thread.projectId &&
        ((thread.worktreeId != null && thread.worktreeId === worktree.id) ||
          (thread.worktreePath !== null && thread.worktreePath === worktree.worktreePath)),
    ) ?? null;
  const available = (environmentId: EnvironmentId) =>
    input.options?.isEnvironmentAvailable?.(environmentId) !== false;
  let thread: T | null = null;
  let threadWorktree: W | null = null;
  for (const candidate of input.threads) {
    if (candidate.archivedAt !== null || !available(candidate.environmentId)) continue;
    if (thread !== null && threadActivityAt(candidate) <= threadActivityAt(thread)) continue;
    const worktree = worktreeOf(candidate);
    if (worktree === null) continue;
    thread = candidate;
    threadWorktree = worktree;
  }
  if (thread !== null) {
    const owner = candidates.find(
      (project) =>
        project.environmentId === thread.environmentId && project.id === thread.projectId,
    );
    if (owner) return { project: owner, thread, worktree: threadWorktree };
  }
  const latestCheckout = (project: P) =>
    carrying
      .filter(
        (worktree) =>
          worktree.environmentId === project.environmentId && worktree.projectId === project.id,
      )
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  for (const project of candidates) {
    const worktree = latestCheckout(project);
    if (worktree !== null && available(project.environmentId)) {
      return { project, thread: null, worktree };
    }
  }
  return { project: candidates[0]!, thread: null, worktree: null };
}

/**
 * The machine a link without a repository opens its chat on: the one the user worked on last
 * among those that can take a chat, else the first that can.
 */
export function promptLinkChatEnvironmentId(
  threads: ReadonlyArray<PromptLinkThread>,
  chatEnvironmentIds: ReadonlyArray<EnvironmentId>,
): EnvironmentId | null {
  let latest: PromptLinkThread | null = null;
  for (const thread of threads) {
    if (!chatEnvironmentIds.includes(thread.environmentId)) continue;
    if (latest === null || threadActivityAt(thread) > threadActivityAt(latest)) latest = thread;
  }
  return latest?.environmentId ?? chatEnvironmentIds[0] ?? null;
}

// People write the name they know; driver kinds are what the node reports.
const PROVIDER_ALIASES: Readonly<Record<string, string>> = { claude: "claudeagent" };

type PromptLinkProvider = Pick<
  ServerProvider,
  "instanceId" | "driver" | "enabled" | "availability" | "status"
> & {
  readonly models: ReadonlyArray<
    SelectableModelOption & {
      readonly isDefault?: boolean | undefined;
      readonly aliases?: ReadonlyArray<string> | undefined;
    }
  >;
};

export interface PromptLinkModelResolution {
  readonly selection: ModelSelection;
  /** False when the instance exists but the model does not, so its default model stands in. */
  readonly exact: boolean;
}

/**
 * The selection a link asks for, on one of the user's own provider instances: the instance it
 * names by id, else a usable instance of the driver it names (ready before warning). Null when
 * no usable instance exists; the user's default applies then.
 */
export function resolvePromptLinkModelSelection(
  providers: ReadonlyArray<PromptLinkProvider>,
  request: { readonly provider: string; readonly model: string | null },
): PromptLinkModelResolution | null {
  const requested = request.provider.toLowerCase();
  const usable = providers.filter(
    (provider) =>
      provider.enabled &&
      provider.availability !== "unavailable" &&
      (provider.status === "ready" || provider.status === "warning"),
  );
  const driver = PROVIDER_ALIASES[requested] ?? requested;
  const ofDriver = usable.filter((provider) => provider.driver.toLowerCase() === driver);
  const instance =
    usable.find((provider) => provider.instanceId.toLowerCase() === requested) ??
    ofDriver.find((provider) => provider.status === "ready") ??
    ofDriver[0];
  if (instance === undefined) return null;
  const wanted = request.model;
  const named =
    wanted === null
      ? null
      : (resolveSelectableModel(instance.driver, wanted, instance.models) ??
        instance.models.find((model) => model.aliases?.includes(wanted))?.slug ??
        null);
  const model =
    named ?? (instance.models.find((candidate) => candidate.isDefault) ?? instance.models[0])?.slug;
  if (model === undefined) return null;
  return {
    selection: { instanceId: instance.instanceId, model },
    exact: wanted === null || named !== null,
  };
}

/** How a linked prompt lands in a composer that may hold a draft already. */
export function linkedPromptDraftAction(
  currentText: string,
  prompt: string,
): "fill" | "keep" | "ask" {
  if (currentText.trim().length === 0) return "fill";
  return currentText === prompt ? "keep" : "ask";
}

/** The warning a prompt with hidden characters gets, or null when it had none. */
export function promptLinkHiddenCharactersWarning(prompt: LinkedPrompt | null): string | null {
  const count = prompt?.hiddenCharacters ?? 0;
  if (count === 0) return null;
  return `This prompt had ${count} hidden character${count === 1 ? "" : "s"}, so it may be malicious. Ryco removed ${count === 1 ? "it" : "them"}. Read the prompt before you send it.`;
}

/** What the user is told when the link's provider or model is not the one the draft uses. */
export function promptLinkModelNote(
  request: { readonly provider: string; readonly model: string | null },
  resolved: PromptLinkModelResolution | null,
): string | null {
  if (resolved === null) {
    return `The link asked for ${request.provider}, which is not set up here, so your default model is used.`;
  }
  if (!resolved.exact && request.model !== null) {
    return `The link asked for ${request.model}, which ${request.provider} does not offer here, so its default model is used.`;
  }
  return null;
}

/** Said whenever Send would check a pull request out, because that runs code from it. */
export function promptLinkPullRequestCheckoutNote(pullRequest: PromptLinkPullRequest): string {
  return `Send checks out ${promptLinkRepositoryName(pullRequest)}#${pullRequest.number} into a new worktree first, which runs your project's setup script on its code.`;
}

/**
 * The one notice a link shows: that its prompt came from a link (or the stronger hidden
 * character warning), then anything the link asked for and did not get. A link without a
 * prompt (a pull request link may have none) only says the rest.
 */
export function promptLinkNotice(
  prompt: LinkedPrompt | null,
  notes: ReadonlyArray<string | null> = [],
): string {
  const lead =
    prompt === null
      ? null
      : (promptLinkHiddenCharactersWarning(prompt) ??
        "This prompt came from a link. Read it before you send it.");
  return [lead, ...notes, prompt === null ? "Nothing is sent until you press Send." : null]
    .filter((line): line is string => line !== null && line.length > 0)
    .join(" ");
}
