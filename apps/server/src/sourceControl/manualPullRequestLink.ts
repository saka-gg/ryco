/**
 * Link a pull request to a workspace by hand (`source: "manual"`), refusing one of another
 * repository. Shared by the link RPC and the pull request watch, which links a pull request the
 * agent or the user names before watching it (a main checkout never discovers its own).
 *
 * @module manualPullRequestLink
 */
import { DateTime, Effect, Exit, Option } from "effect";
import {
  SourceControlProviderError,
  type OrchestrationCommand,
  type Worktree,
  type WorktreePullRequestLink,
} from "@ryco/contracts";
import {
  applyPullRequestLinkChanges,
  readWorktreePullRequestLinks,
} from "@ryco/shared/worktreePullRequests";

import {
  azureRemoteRepositoryKey,
  changeRequestRepositoryKey,
} from "./changeRequestRepositoryKey.ts";
import type { SourceControlProviderRegistryShape } from "./SourceControlProviderRegistry.ts";

export type PullRequestLinkUpdate = Omit<
  Extract<OrchestrationCommand, { readonly type: "worktree.pull-requests.update" }>,
  "type" | "commandId" | "updatedAt"
>;

export const pullRequestLinkFailure = (operation: string, detail: string, cause?: unknown) =>
  new SourceControlProviderError({
    provider: "unknown",
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });

/** The refusals below that say the pull request is not the checkout repository's. */
const wrongRepositoryFailures = new WeakSet<SourceControlProviderError>();

const wrongRepositoryFailure = (operation: string, detail: string, cause?: unknown) => {
  const failure = pullRequestLinkFailure(operation, detail, cause);
  wrongRepositoryFailures.add(failure);
  return failure;
};

/**
 * Whether `linkPullRequestToWorkspace` refused the pull request as another repository's (or
 * could not tell it is this checkout's), rather than failing to read it.
 */
export const isWrongRepositoryLinkFailure = (error: SourceControlProviderError): boolean =>
  wrongRepositoryFailures.has(error);

/**
 * Resolve `reference` (a number or a pasted URL) in `cwd`'s repository and link it to
 * `worktree`. A pasted URL must name what it resolved to, and on Azure DevOps (organisation-wide
 * ids) the checkout's own remote decides which repository the workspace is.
 */
export const linkPullRequestToWorkspace = (input: {
  readonly registry: Pick<SourceControlProviderRegistryShape, "resolveHandle">;
  readonly worktree: Worktree;
  readonly cwd: string;
  readonly reference: string;
  readonly operation: string;
  readonly dispatch: (
    update: PullRequestLinkUpdate,
  ) => Effect.Effect<void, SourceControlProviderError>;
  /**
   * Bring back a link the user removed (default). An agent's link passes false, so a removal
   * that lands while the host is read still wins.
   */
  readonly restore?: boolean;
}): Effect.Effect<WorktreePullRequestLink, SourceControlProviderError> =>
  Effect.gen(function* () {
    const { cwd, operation } = input;
    const handle = yield* input.registry.resolveHandle({ cwd });
    const provider = handle.provider;
    const reference = input.reference.replace(/^#/u, "").trim();
    const changeRequest = yield* provider.getChangeRequest({ cwd, reference });
    const pastedUrl = /^https?:\/\//iu.test(reference);
    const resolvedRepository = changeRequestRepositoryKey(changeRequest.url);
    const foreign = wrongRepositoryFailure(
      operation,
      `#${changeRequest.number} belongs to another repository.`,
    );
    // A pasted URL must name what it resolved to (some hosts resolve a
    // URL by its number alone, in the checkout's repository).
    if (pastedUrl) {
      const pasted = changeRequestRepositoryKey(reference);
      if (pasted === null || pasted !== resolvedRepository) return yield* foreign;
    }
    if (provider.kind === "azure-devops") {
      // Azure pull request ids are organisation-wide (a number or a
      // URL can resolve in a sibling repository): only the checkout's
      // own remote says which repository the workspace is.
      const own = azureRemoteRepositoryKey(handle.context?.remoteUrl);
      if (own === null) {
        return yield* wrongRepositoryFailure(
          operation,
          "Couldn't tell which Azure DevOps repository this checkout is.",
        );
      }
      if (own !== resolvedRepository) return yield* foreign;
    } else if (pastedUrl) {
      // Elsewhere a number names the checkout repository's pull request:
      // the pasted one must be that very one.
      const own = yield* Effect.exit(
        provider.getChangeRequest({ cwd, reference: String(changeRequest.number) }),
      );
      if (Exit.isFailure(own)) {
        return yield* wrongRepositoryFailure(
          operation,
          `Couldn't confirm #${changeRequest.number} is this repository's pull request.`,
          own.cause,
        );
      }
      if (changeRequestRepositoryKey(own.value.url) !== resolvedRepository) {
        return yield* foreign;
      }
    }
    const state = yield* provider
      .getPullRequestState({ number: changeRequest.number, cwd })
      .pipe(Effect.option);
    const upsert = {
      number: changeRequest.number,
      title: changeRequest.title,
      url: changeRequest.url,
      state: Option.match(state, {
        onNone: () => changeRequest.state,
        onSome: (value) => value.state,
      }),
      isDraft: Option.match(state, {
        onNone: () => changeRequest.isDraft ?? null,
        onSome: (value) => value.isDraft,
      }),
      ...Option.match(state, {
        onNone: () => ({}),
        onSome: (value) =>
          value.terminalAt ? { terminalAt: DateTime.formatIso(value.terminalAt) } : {},
      }),
      headRefName: changeRequest.headRefName,
      baseRefName: changeRequest.baseRefName,
      source: "manual" as const,
      restore: input.restore !== false,
    };
    yield* input.dispatch({ worktreeId: input.worktree.worktreeId, upserts: [upsert] });
    const linked = applyPullRequestLinkChanges(
      readWorktreePullRequestLinks(input.worktree),
      { upserts: [upsert] },
      new Date().toISOString(),
    ).find((link) => link.number === changeRequest.number);
    if (!linked) {
      return yield* pullRequestLinkFailure(operation, "The pull request could not be linked.");
    }
    return linked;
  });
