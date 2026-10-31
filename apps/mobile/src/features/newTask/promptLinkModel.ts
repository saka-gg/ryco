import {
  findPromptLinkProject,
  isPromptLinkLookupSettled,
  promptLinkModelNote,
  promptLinkNotice,
  resolvePromptLinkModelSelection,
  resolvePromptLinkPullRequest,
} from "@ryco/client-runtime/promptLinks";
import type {
  Project,
  SidebarThreadOrStub,
  SidebarWorktreeSummary,
} from "@ryco/client-runtime/state/threads";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ServerConfig,
  WorktreeId,
} from "@ryco/contracts";
import {
  parseNewThreadLink,
  PROMPT_LINK_PARAM_KEYS,
  promptLinkPullRequestUrl,
  promptLinkRepositoryName,
  type LinkedPrompt,
} from "@ryco/shared/promptLinks";

/**
 * A prompt link on the phone: `ryco://tasks/new?prompt=…&repo=…&provider=…&model=…` or
 * `?pr=owner/name/123`. The New Task sheet reads the same keys through the shared parser and
 * resolver the web app uses, fills its draft and stops there: the user reads the prompt and
 * sends. A link never changes the runtime mode, and moves the task's checkout only to a
 * checkout of the linked pull request that exists already.
 */

interface PromptLinkEnvironment {
  readonly environmentId: EnvironmentId;
  readonly connectionState: "connected" | "reconnecting" | "offline" | "read-only";
  readonly shellCurrent?: boolean;
}

/** Route params that drop a handled link, so it applies once. */
export const CLEARED_PROMPT_LINK_PARAMS: Readonly<Record<string, undefined>> = Object.fromEntries(
  PROMPT_LINK_PARAM_KEYS.map((key) => [key, undefined]),
);

/**
 * Whether the machines sent their projects or settled without them: a link waits for this (or
 * the shared wait) before it decides the user lacks the repository.
 */
export function isMobilePromptLinkLookupSettled(
  environments: ReadonlyArray<PromptLinkEnvironment>,
): boolean {
  return isPromptLinkLookupSettled(
    environments.map((environment) => ({
      shellCurrent: environment.shellCurrent === true,
      connecting: environment.connectionState === "reconnecting",
    })),
  );
}

export type MobilePromptLinkPlan =
  | { readonly kind: "invalid"; readonly message: string }
  | {
      readonly kind: "draft";
      readonly prompt: string;
      /** The project the link names; null keeps the sheet's own choice. */
      readonly target: {
        readonly environmentId: EnvironmentId;
        readonly projectId: ProjectId;
      } | null;
      /** A checkout of the linked pull request that exists already. */
      readonly worktreeId: WorktreeId | null;
      /** The link's model on one of the user's instances; null keeps the default. */
      readonly modelSelection: ModelSelection | null;
      /** The one alert the link shows. */
      readonly notice: string;
    };

/**
 * What a link fills the New Task sheet with. `fallbackEnvironmentId` is the machine the sheet
 * chose itself, whose providers a link without a repository asks for its model.
 */
export function planMobilePromptLink(input: {
  readonly search: URLSearchParams;
  readonly projects: ReadonlyArray<Project>;
  readonly threads: ReadonlyArray<SidebarThreadOrStub>;
  readonly worktrees: ReadonlyArray<SidebarWorktreeSummary>;
  readonly environments: ReadonlyArray<PromptLinkEnvironment>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>;
  readonly fallbackEnvironmentId: EnvironmentId | null;
}): MobilePromptLinkPlan {
  const parsed = parseNewThreadLink(input.search);
  if (!parsed.ok) return { kind: "invalid", message: parsed.error };
  const link = parsed.value;
  const options = {
    isEnvironmentAvailable: (environmentId: EnvironmentId) =>
      input.environments.some(
        (environment) =>
          environment.environmentId === environmentId &&
          environment.connectionState === "connected",
      ),
  };
  const notes: Array<string | null> = [];
  let project: Project | null = null;
  let worktreeId: WorktreeId | null = null;
  let prompt: LinkedPrompt | null = link.prompt;
  if (link.kind === "pull-request") {
    const target = resolvePromptLinkPullRequest({
      projects: input.projects,
      threads: input.threads,
      worktrees: input.worktrees,
      pullRequest: link.pullRequest,
      options,
    });
    const name = `${promptLinkRepositoryName(link.pullRequest)}#${link.pullRequest.number}`;
    if (target === null) {
      // Without its repository the task still says which pull request it meant.
      prompt = {
        text: [link.prompt?.text, promptLinkPullRequestUrl(link.pullRequest)]
          .filter(Boolean)
          .join("\n\n"),
        hiddenCharacters: link.prompt?.hiddenCharacters ?? 0,
      };
      notes.push(
        `You don't have ${promptLinkRepositoryName(link.pullRequest)}, so pick a project for it.`,
      );
    } else {
      project = target.project;
      worktreeId = target.worktree?.id ?? null;
      if (worktreeId === null) {
        notes.push(
          `The phone cannot check out ${name} yet, so this task starts in the project's checkout. Open the link in the web or desktop app to work on its branch.`,
        );
      }
    }
  } else if (link.repository !== null) {
    project = findPromptLinkProject({
      projects: input.projects,
      threads: input.threads,
      repository: link.repository,
      options,
    });
    if (project === null) {
      notes.push(
        `You don't have ${promptLinkRepositoryName(link.repository)}, so pick a project for it.`,
      );
    }
  }
  let modelSelection: ModelSelection | null = null;
  const environmentId = project?.environmentId ?? input.fallbackEnvironmentId;
  if (link.kind === "new" && link.provider !== null && environmentId !== null) {
    const request = { provider: link.provider, model: link.model };
    const resolved = resolvePromptLinkModelSelection(
      input.serverConfigs.get(environmentId)?.providers ?? [],
      request,
    );
    modelSelection = resolved?.selection ?? null;
    notes.unshift(promptLinkModelNote(request, resolved));
  }
  return {
    kind: "draft",
    prompt: prompt?.text ?? "",
    target: project ? { environmentId: project.environmentId, projectId: project.id } : null,
    worktreeId,
    modelSelection,
    notice: promptLinkNotice(prompt, notes),
  };
}
