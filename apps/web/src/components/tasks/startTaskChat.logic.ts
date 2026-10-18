import {
  extractThreadReferences,
  type SendTurnBootstrap,
} from "@ryco/client-runtime/state/composer";
import { initialDraftModelSelection } from "@ryco/client-runtime/state/settings";
import { nextTaskBranchName, taskBranchSlug } from "@ryco/client-runtime/state/tasks";
import {
  CommandId,
  DEFAULT_RUNTIME_MODE,
  PROVIDER_SEND_TURN_MAX_SOURCE_CONTROL_CONTEXTS,
  type AgentTokenMode,
  type ComposerSourceControlContext,
  type EffectiveProjectPreferences,
  type LocalTaskDelegateInput,
  type LocalTaskLink,
  type MessageId,
  type ModelSelection,
  type RepositoryIdentity,
  type ServerConfig,
  type SourceControlChangeRequestDetail,
  type SourceControlIssueDetail,
  type ThreadId,
} from "@ryco/contracts";
import { normalizeGitRemoteUrl } from "@ryco/shared/git";
import { truncate } from "@ryco/shared/String";
import { DateTime } from "effect";

import type { TaskWhereOption } from "./tasksViewModel";

/**
 * The pure half of starting a chat from a task: where it can start, what
 * the first message and its command carry, and what the toasts say.
 * `startTaskChat.ts` does the reads and writes around it.
 */

/** Where a task's chat starts. */
export type TaskStartPlace =
  /** A pull request's own worktree (created, or reused when it exists). */
  | { readonly kind: "pr"; readonly number: number }
  /** A new worktree branched from a linked branch. */
  | { readonly kind: "branch"; readonly name: string }
  /** A new worktree on the task's own branch (`task/<slug>`). */
  | { readonly kind: "worktree" }
  /** The project's checkout, on whatever it has checked out. */
  | { readonly kind: "project" };

export function taskWhereOptionId(place: TaskStartPlace): string {
  switch (place.kind) {
    case "pr":
      return `pr:${place.number}`;
    case "branch":
      return `branch:${place.name}`;
    case "worktree":
    case "project":
      return place.kind;
  }
}

/** The place an option id names; `null` for an id no option of this shape has. */
export function parseTaskWhereOptionId(id: string): TaskStartPlace | null {
  if (id === "worktree" || id === "project") return { kind: id };
  if (id.startsWith("pr:")) {
    const number = Number(id.slice(3));
    return Number.isSafeInteger(number) && number > 0 ? { kind: "pr", number } : null;
  }
  if (id.startsWith("branch:") && id.length > 7) return { kind: "branch", name: id.slice(7) };
  return null;
}

/**
 * The branch a task's next "New worktree" chat gets: `task/<slug>` for the
 * task's first worktree, `task/<slug>-<n>` after that, moved on past any
 * branch that exists already or that an earlier start of the task asked for.
 * Chats started in the project folder or an existing branch's worktree asked
 * for no new branch, so they don't count.
 */
export function taskWorktreeBranch(input: {
  readonly title: string;
  readonly startBranches: ReadonlyArray<string>;
  readonly existingRefNames: ReadonlyArray<string>;
}): string {
  return nextTaskBranchName({
    slug: taskBranchSlug(input.title),
    delegationCount: input.startBranches.length,
    existingRefNames: [...input.existingRefNames, ...input.startBranches],
  });
}

/** The local branch names a ref listing holds, remote refs without their remote. */
export function localRefNames(
  refs: ReadonlyArray<{
    readonly name: string;
    readonly isRemote?: boolean | undefined;
    readonly remoteName?: string | undefined;
  }>,
): string[] {
  return refs.map((ref) => {
    const prefix = ref.isRemote && ref.remoteName ? `${ref.remoteName}/` : null;
    return prefix && ref.name.startsWith(prefix) ? ref.name.slice(prefix.length) : ref.name;
  });
}

/** The path a pull/merge request or issue adds to its repository's URL, on every host the app links. */
const CHANGE_REQUEST_URL_PATH =
  /\/(?:-\/)?(?:merge_requests|pulls?|pullrequest|issues)\/\d+(?:[/?#].*)?$/i;

/**
 * The repository a pull request or issue URL belongs to, named the way
 * `normalizeGitRemoteUrl` names a remote (`github.com/owner/repo`); `null`
 * for a URL of no known shape.
 */
export function changeRequestRepositoryKey(url: string): string | null {
  const match = CHANGE_REQUEST_URL_PATH.exec(url);
  return match ? normalizeGitRemoteUrl(url.slice(0, match.index)) : null;
}

/**
 * The repository the project's pull requests live in: its primary remote's
 * (`upstream`, else `origin`), the one a pull request number resolves in.
 * `null` while the project's repository is unknown.
 */
export function projectRepositoryKey(
  identity: RepositoryIdentity | null | undefined,
): string | null {
  return identity?.canonicalKey ?? null;
}

/**
 * Whether a linked pull request is the project's own, so its number names it
 * there: one linked by number is, one linked by URL is when the URL is in the
 * project's repository. Another repository's #N is a different pull request
 * (or none) in this checkout.
 */
export function isProjectPullRequest(
  link: Extract<LocalTaskLink, { kind: "pr" }>,
  repositoryKey: string | null,
): boolean {
  if (link.url === undefined) return true;
  return repositoryKey !== null && changeRequestRepositoryKey(link.url) === repositoryKey;
}

export interface TaskWhereInput {
  readonly title: string;
  readonly links: ReadonlyArray<LocalTaskLink>;
  /** The project's repository (`projectRepositoryKey`); a pull request elsewhere has no worktree here. */
  readonly projectRepository?: string | null;
  /** The branches the task's earlier starts asked for (new worktrees only). */
  readonly startBranches: ReadonlyArray<string>;
  /** The node can check a pull request or a branch out into its own worktree. */
  readonly linkedWorktrees: boolean;
  /** The branch of a pull request's existing worktree, when this client knows one. */
  readonly pullRequestBranch?: (number: number) => string | null;
}

/**
 * Where a task's chat can start, the default first: each linked pull
 * request's worktree (the project's own pull requests only), a worktree from
 * each linked branch, a new worktree, the project folder. The new worktree's
 * branch here is the one the task itself would take next; the start checks it
 * against the refs that exist.
 */
export function buildTaskWhereOptions(input: TaskWhereInput): TaskWhereOption[] {
  const options: TaskWhereOption[] = [];
  const seen = new Set<string>();
  const add = (place: TaskStartPlace, option: Omit<TaskWhereOption, "id">) => {
    const id = taskWhereOptionId(place);
    if (seen.has(id)) return;
    seen.add(id);
    options.push({ id, ...option });
  };
  if (input.linkedWorktrees) {
    for (const link of input.links) {
      if (link.kind !== "pr" || !isProjectPullRequest(link, input.projectRepository ?? null))
        continue;
      add(
        { kind: "pr", number: link.number },
        {
          kind: "pr",
          label: `PR #${link.number} worktree`,
          detail: "Pushes update the pull request",
          hintPrefix: `the PR #${link.number} worktree`,
          hintRef: input.pullRequestBranch?.(link.number) ?? null,
        },
      );
    }
    for (const link of input.links) {
      if (link.kind !== "branch") continue;
      add(
        { kind: "branch", name: link.name },
        {
          kind: "branch",
          label: `${link.name} worktree`,
          detail: `A new branch from ${link.name}`,
          hintPrefix: "a worktree from",
          hintRef: link.name,
        },
      );
    }
  }
  const branch = taskWorktreeBranch({
    title: input.title,
    startBranches: input.startBranches,
    existingRefNames: [],
  });
  add(
    { kind: "worktree" },
    {
      kind: "worktree",
      label: "New worktree",
      detail: `${branch} from the default branch`,
      hintPrefix: "a new worktree",
      hintRef: branch,
    },
  );
  add(
    { kind: "project" },
    {
      kind: "project",
      label: "Project folder",
      detail: "No worktree, current branch",
      hintPrefix: "the project folder",
      hintRef: null,
    },
  );
  return options;
}

/** The place an option (or, without one, the default) starts in; `null` when it is gone. */
export function resolveTaskStartPlace(
  options: ReadonlyArray<TaskWhereOption>,
  whereId: string | undefined,
): TaskStartPlace | null {
  const option = whereId === undefined ? options[0] : options.find((each) => each.id === whereId);
  return option ? parseTaskWhereOptionId(option.id) : null;
}

/** One command id per start: a retry of the same start resends it unchanged. */
export function taskStartCommandId(taskId: string, messageId: MessageId): CommandId {
  return CommandId.make(`task-start:${taskId}:${messageId}`);
}

/**
 * The model and token mode a task's chat starts with: the ones a new
 * thread's draft opens with in the same project (`useHandleNewThread`).
 * `null` when the node names no model at all.
 */
export function resolveTaskStartDefaults(input: {
  readonly config: ServerConfig;
  readonly effective: EffectiveProjectPreferences | null;
}): { readonly modelSelection: ModelSelection; readonly tokenMode: AgentTokenMode } | null {
  const fallback =
    input.effective?.initialModelSelection.value ?? input.config.settings.initialModelSelection;
  if (!fallback) return null;
  return {
    modelSelection: initialDraftModelSelection({ effective: input.effective, fallback }),
    tokenMode: input.config.settings.defaultAgentTokenMode,
  };
}

/** How long attached detail counts as fresh, the composer's `#` picker window. */
const SOURCE_CONTROL_CONTEXT_FRESH_MS = 5 * 60 * 1000;

/** A linked pull request or issue as the message's attached context, the way the composer attaches it. */
export function taskSourceControlContext(input: {
  readonly id: string;
  readonly kind: ComposerSourceControlContext["kind"];
  readonly detail: SourceControlIssueDetail | SourceControlChangeRequestDetail;
  readonly nowMs: number;
}): ComposerSourceControlContext {
  return {
    id: input.id,
    kind: input.kind,
    provider: input.detail.provider,
    reference: `${input.detail.provider}#${input.detail.number}`,
    detail: input.detail,
    fetchedAt: DateTime.fromDateUnsafe(new Date(input.nowMs)),
    staleAfter: DateTime.fromDateUnsafe(new Date(input.nowMs + SOURCE_CONTROL_CONTEXT_FRESH_MS)),
  };
}

/**
 * The pull requests and issues a task links to, the ones whose detail its
 * first message attaches. `reference` is what the detail is read by: the
 * link's URL when it has one, so a link to another repository reads that
 * repository's item rather than the project's item of the same number.
 */
export function taskSourceControlLinks(links: ReadonlyArray<LocalTaskLink>): ReadonlyArray<{
  readonly kind: ComposerSourceControlContext["kind"];
  readonly number: number;
  readonly reference: string;
}> {
  const picked: Array<{
    kind: ComposerSourceControlContext["kind"];
    number: number;
    reference: string;
  }> = [];
  const seen = new Set<string>();
  for (const link of links) {
    if (link.kind !== "pr" && link.kind !== "issue") continue;
    const kind = link.kind === "pr" ? "change-request" : "issue";
    const key = `${kind}:${link.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push({ kind, number: link.number, reference: link.url ?? String(link.number) });
    if (picked.length === PROVIDER_SEND_TURN_MAX_SOURCE_CONTROL_CONTEXTS) break;
  }
  return picked;
}

export interface TaskTurnStartInput {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  /** The first message (`buildTaskStartPrompt`). */
  readonly text: string;
  /** The task's title: the chat's title seed. */
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly tokenMode: AgentTokenMode;
  /** Creates the thread (and its worktree); absent when the thread exists already. */
  readonly bootstrap: SendTurnBootstrap;
  readonly sourceControlContexts: ReadonlyArray<ComposerSourceControlContext>;
  readonly createdAt: string;
}

/**
 * The `thread.turn.start` a task's chat starts with. It runs unattended, so
 * in full access and the default interaction mode, like a new thread. It
 * carries no attachments: the node adds the task's files itself. Linked
 * chats travel as thread references, read from the `@thread:` mentions the
 * prompt writes.
 */
export function buildTaskTurnStartCommand(
  input: TaskTurnStartInput,
): LocalTaskDelegateInput["command"] {
  const threadReferences = extractThreadReferences(input.text, input.threadId);
  const titleSeed = truncate(input.title);
  return {
    type: "thread.turn.start",
    commandId: input.commandId,
    threadId: input.threadId,
    message: {
      messageId: input.messageId,
      role: "user",
      text: input.text,
      attachments: [],
    },
    modelSelection: input.modelSelection,
    ...(titleSeed ? { titleSeed } : {}),
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: "default",
    tokenMode: input.tokenMode,
    ...(input.bootstrap ? { bootstrap: input.bootstrap } : {}),
    ...(input.sourceControlContexts.length > 0
      ? { sourceControlContexts: input.sourceControlContexts }
      : {}),
    ...(threadReferences.length > 0 ? { threadReferences } : {}),
    createdAt: input.createdAt,
  };
}

/** What the toast says once a chat is under way. */
export function taskStartedMessage(place: TaskStartPlace, branch: string | null): string {
  const where = (() => {
    switch (place.kind) {
      case "pr":
        return `in the PR #${place.number} worktree`;
      case "branch":
        return `in a worktree from ${place.name}`;
      case "worktree":
        return branch ? `in worktree ${branch}` : "in a new worktree";
      case "project":
        return "in the project folder";
    }
  })();
  return `Chat started ${where} · it keeps running in the background`;
}
