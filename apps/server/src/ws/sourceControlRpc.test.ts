import * as fs from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Schema } from "effect";
import {
  AuthSessionId,
  SourceControlProviderError,
  WorktreeId,
  WS_METHODS,
  type ChangeRequest,
  type OrchestrationCommand,
} from "@ryco/contracts";

import type { AuthenticatedSession } from "../auth/Services/ServerAuth.ts";
import { authorizeWsRpc, type WsRpcAccess } from "../auth/wsAuthorization.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionWorktreeRepository,
  type ProjectionWorktreeRepositoryShape,
} from "../persistence/Services/ProjectionWorktrees.ts";
import type { SourceControlProviderShape } from "../sourceControl/SourceControlProvider.ts";
import {
  SourceControlProviderRegistry,
  type SourceControlProviderRegistryShape,
} from "../sourceControl/SourceControlProviderRegistry.ts";
import type { WsRpcContext } from "./context.ts";
import { makeSourceControlHandlers, selectCreatedChangeRequest } from "./sourceControlRpc.ts";

const handlerLayer = Layer.mergeAll(
  Layer.succeed(OrchestrationEngineService, {} as OrchestrationEngineShape),
  Layer.succeed(ProjectionWorktreeRepository, {} as ProjectionWorktreeRepositoryShape),
  Layer.succeed(SourceControlProviderRegistry, {} as SourceControlProviderRegistryShape),
);

const ownerSession: AuthenticatedSession = {
  sessionId: AuthSessionId.make("session-owner"),
  subject: "owner",
  method: "browser-session-cookie",
  role: "owner",
};

const ownerEffect = <A, E, R>(method: string, effect: Effect.Effect<A, E, R>) =>
  authorizeWsRpc(ownerSession, "owner" as WsRpcAccess, method).pipe(Effect.flatMap(() => effect));

const changeRequest = (overrides: Partial<ChangeRequest>): ChangeRequest => ({
  provider: "github",
  number: 1,
  title: "Title",
  url: "https://github.com/acme/repo/pull/1",
  baseRefName: "main",
  headRefName: "feature/x",
  state: "open",
  updatedAt: Option.none(),
  ...overrides,
});

function makeContext(
  provider: Partial<SourceControlProviderShape>,
  fileSystem?: FileSystem.FileSystem,
) {
  const refreshes: Array<string> = [];
  const ctx = {
    ownerEffect,
    fileSystem,
    sourceControlRegistry: {
      resolve: () => Effect.succeed({ kind: "github", ...provider } as SourceControlProviderShape),
    },
    refreshStateForLinkedReference: () => Effect.sync(() => refreshes.push("linked")),
    refreshLinkedWorktreeSourceControlStates: (input: { readonly reason: string }) =>
      Effect.sync(() => refreshes.push(`worktrees:${input.reason}`)),
    refreshGitStatus: () => Effect.sync(() => refreshes.push("git-status")),
  } as unknown as WsRpcContext;
  return { handlers: makeSourceControlHandlers(ctx), refreshes };
}

describe("selectCreatedChangeRequest", () => {
  it("prefers the matching head and base, honoring owner:branch selectors", () => {
    const candidates = [
      changeRequest({ number: 3, headRepositoryOwnerLogin: "fork", baseRefName: "main" }),
      changeRequest({ number: 4, headRepositoryOwnerLogin: "acme", baseRefName: "release" }),
      changeRequest({ number: 5, headRepositoryOwnerLogin: "acme", baseRefName: "main" }),
      changeRequest({ number: 6, headRefName: "other" }),
    ];
    expect(
      selectCreatedChangeRequest(candidates, { baseRefName: "main", headRefName: "acme:feature/x" })
        ?.number,
    ).toBe(5);
    expect(
      selectCreatedChangeRequest(candidates, { baseRefName: "main", headRefName: "feature/x" })
        ?.number,
    ).toBe(3);
    expect(
      selectCreatedChangeRequest(candidates, { baseRefName: "main", headRefName: "missing" }),
    ).toBeNull();
  });
});

describe("pull request page handlers", () => {
  it.effect("creates a change request from a temp body file and returns it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      let stagedBody: string | null = null;
      let stagedPath: string | null = null;
      const { handlers, refreshes } = makeContext(
        {
          createChangeRequest: (input) =>
            Effect.sync(() => {
              expect(input).toMatchObject({
                baseRefName: "main",
                headSelector: "feature/x",
                title: "Add things",
                draft: true,
              });
              stagedPath = input.bodyFile;
              stagedBody = fs.readFileSync(input.bodyFile, "utf8");
            }),
          listChangeRequests: (input) =>
            Effect.sync(() => {
              expect(input).toMatchObject({ headSelector: "feature/x", state: "open" });
              return [changeRequest({ number: 12, isDraft: true })];
            }),
        },
        fileSystem,
      );
      const created = yield* handlers[WS_METHODS.sourceControlCreateChangeRequest]({
        cwd: "/repo",
        baseRefName: "main",
        headRefName: "feature/x",
        title: "Add things",
        body: "## Summary\n\nDetails `$(not argv)`",
        draft: true,
      }).pipe(Effect.provide(handlerLayer));

      expect(created.number).toBe(12);
      expect(stagedBody).toBe("## Summary\n\nDetails `$(not argv)`");
      expect(fs.existsSync(stagedPath!)).toBe(false);
      expect(refreshes).toEqual(["worktrees:sourceControl.createChangeRequest", "git-status"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("routes involvement lists to the provider's server-side filter", () =>
    Effect.gen(function* () {
      const seen: Array<unknown> = [];
      const { handlers } = makeContext({
        listChangeRequests: (input) => Effect.sync(() => (seen.push(input), [])),
        searchChangeRequests: () => Effect.die("must not search without involvement"),
      });
      yield* handlers[WS_METHODS.sourceControlListChangeRequests]({
        cwd: "/repo",
        state: "all",
        query: " flaky ",
        involvement: "authored",
        limit: 30,
      }).pipe(Effect.provide(handlerLayer));
      expect(seen).toEqual([
        {
          cwd: "/repo",
          headSelector: "",
          state: "all",
          involvement: "authored",
          query: "flaky",
          limit: 30,
        },
      ]);
    }),
  );

  it.effect("passes commit scope through to the diff", () =>
    Effect.gen(function* () {
      const seen: Array<unknown> = [];
      const { handlers } = makeContext({
        getChangeRequestDiff: (input) => Effect.sync(() => (seen.push(input), "diff")),
      });
      const diff = yield* handlers[WS_METHODS.sourceControlGetChangeRequestDiff]({
        cwd: "/repo",
        reference: "7",
        commitSha: "abc1234",
      }).pipe(Effect.provide(handlerLayer));
      expect(diff).toBe("diff");
      expect(seen).toEqual([{ cwd: "/repo", reference: "7", commitSha: "abc1234" }]);
    }),
  );

  it.effect("refreshes linked worktrees fully only for lifecycle-changing updates", () =>
    Effect.gen(function* () {
      const detail = { detail: {} } as never;
      const { handlers, refreshes } = makeContext({
        updateChangeRequest: () => Effect.succeed(detail),
      });
      yield* handlers[WS_METHODS.sourceControlUpdateChangeRequest]({
        cwd: "/repo",
        reference: "7",
        action: { kind: "labels", add: ["bug"], remove: [] },
      }).pipe(Effect.provide(handlerLayer));
      expect(refreshes).toEqual(["linked"]);

      refreshes.length = 0;
      yield* handlers[WS_METHODS.sourceControlUpdateChangeRequest]({
        cwd: "/repo",
        reference: "7",
        action: { kind: "close", deleteBranch: true },
      }).pipe(Effect.provide(handlerLayer));
      expect(refreshes.toSorted()).toEqual([
        "git-status",
        "linked",
        "worktrees:sourceControl.updateChangeRequest",
      ]);
    }),
  );

  it.effect("fails fast from the host capability matrix before reaching the provider", () =>
    Effect.gen(function* () {
      const unreachable = () => Effect.die("must not reach the provider");
      const providerFor = (kind: "azure-devops" | "bitbucket" | "unknown") =>
        makeContext({
          kind,
          listChangeRequests: unreachable,
          getChangeRequestDiff: unreachable,
          submitChangeRequestReview: unreachable,
          updateChangeRequest: unreachable,
          mergeChangeRequest: unreachable,
          getChangeRequestFilesViewed: unreachable,
          listWorkflowRuns: unreachable,
        }).handlers;
      const detailOf = (error: unknown) =>
        Schema.is(SourceControlProviderError)(error) ? error.detail : String(error);
      const run = <A, E>(effect: Effect.Effect<A, E, never>) =>
        effect.pipe(Effect.flip, Effect.map(detailOf));
      const provide = Effect.provide(handlerLayer);
      const azure = providerFor("azure-devops");
      const bitbucket = providerFor("bitbucket");
      const unknown = providerFor("unknown");

      expect(
        yield* run(
          azure[WS_METHODS.sourceControlUpdateChangeRequest]({
            cwd: "/repo",
            reference: "7",
            action: { kind: "update-branch", method: "merge", expectedHeadSha: "abc1234" },
          }).pipe(provide),
        ),
      ).toBe("Azure DevOps does not support updating branches from their base.");
      expect(
        yield* run(
          azure[WS_METHODS.sourceControlUpdateChangeRequest]({
            cwd: "/repo",
            reference: "7",
            action: { kind: "assignees", add: ["octocat"], remove: [] },
          }).pipe(provide),
        ),
      ).toBe("Azure DevOps does not support assigning pull requests.");
      expect(
        yield* run(
          bitbucket[WS_METHODS.sourceControlUpdateChangeRequest]({
            cwd: "/repo",
            reference: "7",
            action: { kind: "reopen" },
          }).pipe(provide),
        ),
      ).toBe("Bitbucket does not support reopening pull requests.");
      expect(
        yield* run(
          unknown[WS_METHODS.sourceControlListChangeRequests]({
            cwd: "/repo",
            state: "open",
            involvement: "review-requested",
          }).pipe(provide),
        ),
      ).toBe(
        "This source control provider does not support filtering change requests by involvement.",
      );
      expect(
        yield* run(
          unknown[WS_METHODS.sourceControlGetChangeRequestDiff]({
            cwd: "/repo",
            reference: "7",
            commitSha: "abc1234",
          }).pipe(provide),
        ),
      ).toBe("This source control provider does not support single-commit diffs.");
      expect(
        yield* run(
          unknown[WS_METHODS.sourceControlSubmitChangeRequestReview]({
            cwd: "/repo",
            reference: "7",
            event: "approve",
            comments: [],
            expectedHeadSha: "abc1234",
          }).pipe(provide),
        ),
      ).toBe("This source control provider does not support approving reviews.");
      expect(
        yield* run(
          unknown[WS_METHODS.sourceControlMergeChangeRequest]({
            cwd: "/repo",
            reference: "7",
            mergeMethod: "squash",
          }).pipe(provide),
        ),
      ).toBe("This source control provider does not support merging change requests.");
      // Viewed files degrade to "unsupported" storage rather than failing the Files tab.
      expect(
        yield* azure[WS_METHODS.sourceControlGetChangeRequestFilesViewed]({
          cwd: "/repo",
          reference: "7",
        }).pipe(provide),
      ).toEqual({
        provider: "azure-devops",
        capability: { storage: "unsupported" },
        headSha: null,
        files: [],
      });
    }),
  );

  it.effect("gates update-branch on the host's update methods", () =>
    Effect.gen(function* () {
      const { handlers } = makeContext({
        kind: "gitlab",
        updateChangeRequest: () => Effect.die("must not reach the provider"),
      });
      const error = yield* handlers[WS_METHODS.sourceControlUpdateChangeRequest]({
        cwd: "/repo",
        reference: "7",
        action: { kind: "update-branch", method: "merge", expectedHeadSha: "abc1234" },
      }).pipe(Effect.flip, Effect.provide(handlerLayer));
      expect(Schema.is(SourceControlProviderError)(error) ? error.detail : String(error)).toBe(
        "GitLab does not support updating branches by merging the base in.",
      );
    }),
  );

  it.effect("fails clearly when the provider lacks a page capability", () =>
    Effect.gen(function* () {
      const { handlers } = makeContext({ kind: "gitlab" });
      const error = yield* handlers[WS_METHODS.sourceControlGetChangeRequestActivity]({
        cwd: "/repo",
        reference: "7",
      }).pipe(Effect.flip, Effect.provide(handlerLayer));
      expect(Schema.is(SourceControlProviderError)(error)).toBe(true);
      if (Schema.is(SourceControlProviderError)(error)) {
        expect(error.provider).toBe("gitlab");
        expect(error.operation).toBe("getChangeRequestActivity");
      }
    }),
  );
});

describe("workspace pull request links", () => {
  const worktreeId = WorktreeId.make("wt-lifecycle");
  function makeLinkContext(
    changeRequests: Record<string, ChangeRequest>,
    worktree: { readonly checkoutRemovedAt?: string | null } = {},
    host: { readonly kind?: string; readonly remoteUrl?: string } = {},
  ) {
    const dispatched: OrchestrationCommand[] = [];
    const resolvedCwds: string[] = [];
    const provider = {
      kind: host.kind ?? "github",
      getChangeRequest: (input: { readonly reference: string }) => {
        const found = changeRequests[input.reference];
        return found
          ? Effect.succeed(found)
          : Effect.fail(
              new SourceControlProviderError({
                provider: "github",
                operation: "getChangeRequest",
                detail: "not found",
              }),
            );
      },
      getPullRequestState: () =>
        Effect.fail(
          new SourceControlProviderError({
            provider: "github",
            operation: "getPullRequestState",
            detail: "unavailable",
          }),
        ),
    } as unknown as SourceControlProviderShape;
    const ctx = {
      ownerEffect,
      sourceControlRegistry: {
        resolveHandle: (input: { readonly cwd: string }) =>
          Effect.sync(() => resolvedCwds.push(input.cwd)).pipe(
            Effect.as({
              provider,
              context: host.remoteUrl ? { remoteName: "origin", remoteUrl: host.remoteUrl } : null,
            }),
          ),
      },
      projectionSnapshotQuery: {
        getProjectShellById: () => Effect.succeed(Option.some({ workspaceRoot: "/repo" })),
      },
      projectionWorktrees: {
        getById: () =>
          Effect.succeed(
            Option.some({
              worktreeId,
              projectId: "project-1",
              worktreePath: "/repo/lifecycle",
              archivedAt: null,
              origin: "branch",
              prNumber: null,
              prTitle: null,
              pullRequests: [],
              checkoutRemovedAt: worktree.checkoutRemovedAt ?? null,
            }),
          ),
      },
      dispatchNormalizedCommand: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: 1 };
        }),
      serverCommandId: (tag: string) => `${tag}-1`,
    } as unknown as WsRpcContext;
    return { handlers: makeSourceControlHandlers(ctx), dispatched, resolvedCwds };
  }

  it.effect("links by hand, bringing a dismissed link back", () =>
    Effect.gen(function* () {
      const { handlers, dispatched } = makeLinkContext({
        "677": changeRequest({ number: 677, url: "https://github.com/acme/repo/pull/677" }),
      });
      const linked = yield* handlers[WS_METHODS.sourceControlLinkWorktreePullRequest]({
        worktreeId,
        reference: "#677",
      }).pipe(Effect.provide(handlerLayer));

      expect(linked).toMatchObject({ number: 677, source: "manual", dismissedAt: null });
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({
        type: "worktree.pull-requests.update",
        worktreeId,
        upserts: [{ number: 677, source: "manual", restore: true }],
      });
    }),
  );

  it.effect("links a workspace whose checkout was removed through the project root", () =>
    Effect.gen(function* () {
      const { handlers, dispatched, resolvedCwds } = makeLinkContext(
        { "677": changeRequest({ number: 677 }) },
        { checkoutRemovedAt: "2026-10-06T09:00:00.000Z" },
      );
      yield* handlers[WS_METHODS.sourceControlLinkWorktreePullRequest]({
        worktreeId,
        reference: "677",
      }).pipe(Effect.provide(handlerLayer));

      expect(resolvedCwds).toEqual(["/repo"]);
      expect(dispatched).toHaveLength(1);
    }),
  );

  it.effect("refuses a pasted link to another repository's pull request", () =>
    Effect.gen(function* () {
      const foreign = "https://github.com/other/repo/pull/5";
      const { handlers, dispatched } = makeLinkContext({
        [foreign]: changeRequest({ number: 5, url: foreign }),
        "5": changeRequest({ number: 5, url: "https://github.com/acme/repo/pull/5" }),
      });
      const error = yield* handlers[WS_METHODS.sourceControlLinkWorktreePullRequest]({
        worktreeId,
        reference: foreign,
      }).pipe(Effect.provide(handlerLayer), Effect.flip);

      expect(Schema.is(SourceControlProviderError)(error)).toBe(true);
      expect((error as SourceControlProviderError).detail).toBe(
        "#5 belongs to another repository.",
      );
      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("refuses another repository's URL on hosts that resolve URLs by number", () =>
    Effect.gen(function* () {
      // Bitbucket/Forgejo-style: the URL's own repository is ignored, the number
      // is looked up in the checkout's repository.
      const own = changeRequest({
        number: 5,
        url: "https://bitbucket.org/acme/repo/pull-requests/5",
      });
      const pasted = "https://bitbucket.org/other/repo/pull-requests/5";
      const { handlers, dispatched } = makeLinkContext({ [pasted]: own, "5": own });
      const error = yield* handlers[WS_METHODS.sourceControlLinkWorktreePullRequest]({
        worktreeId,
        reference: pasted,
      }).pipe(Effect.provide(handlerLayer), Effect.flip);

      expect((error as SourceControlProviderError).detail).toBe(
        "#5 belongs to another repository.",
      );
      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("checks Azure DevOps links against the checkout's own repository", () =>
    Effect.gen(function* () {
      const azure = { kind: "azure-devops", remoteUrl: "git@ssh.dev.azure.com:v3/acme/Shop/shop" };
      const own = changeRequest({
        number: 9,
        url: "https://dev.azure.com/acme/Shop/_git/shop/pullrequest/9",
      });
      // Its own pull request, pasted in another of Azure's URL forms.
      const pastedOwn =
        "https://acme.visualstudio.com/DefaultCollection/Shop/_git/shop/pullrequest/9";
      const first = makeLinkContext({ [pastedOwn]: own, "9": own }, {}, azure);
      yield* first.handlers[WS_METHODS.sourceControlLinkWorktreePullRequest]({
        worktreeId,
        reference: pastedOwn,
      }).pipe(Effect.provide(handlerLayer));
      expect(first.dispatched).toHaveLength(1);

      // Ids are organisation-wide: a sibling repository's #12, pasted or typed.
      const siblingUrl = "https://dev.azure.com/acme/Shop/_git/other/pullrequest/12";
      const sibling = changeRequest({ number: 12, url: siblingUrl });
      for (const reference of [siblingUrl, "#12"]) {
        const attempt = makeLinkContext({ [siblingUrl]: sibling, "12": sibling }, {}, azure);
        const error = yield* attempt.handlers[WS_METHODS.sourceControlLinkWorktreePullRequest]({
          worktreeId,
          reference,
        }).pipe(Effect.provide(handlerLayer), Effect.flip);
        expect((error as SourceControlProviderError).detail).toBe(
          "#12 belongs to another repository.",
        );
        expect(attempt.dispatched).toEqual([]);
      }
    }),
  );

  it.effect(
    "says when it could not confirm a pasted pull request, rather than blaming its repository",
    () =>
      Effect.gen(function* () {
        const own = "https://github.com/acme/repo/pull/5";
        // The URL resolves; the number lookup in the checkout fails (rate limit, network).
        const { handlers, dispatched } = makeLinkContext({
          [own]: changeRequest({ number: 5, url: own }),
        });
        const error = yield* handlers[WS_METHODS.sourceControlLinkWorktreePullRequest]({
          worktreeId,
          reference: own,
        }).pipe(Effect.provide(handlerLayer), Effect.flip);

        expect((error as SourceControlProviderError).detail).toBe(
          "Couldn't confirm #5 is this repository's pull request.",
        );
        expect(dispatched).toEqual([]);
      }),
  );

  it.effect("accepts a pasted link to the workspace's own repository", () =>
    Effect.gen(function* () {
      const own = "https://github.com/acme/repo/pull/5/files";
      const { handlers, dispatched } = makeLinkContext({
        [own]: changeRequest({ number: 5, url: "https://github.com/acme/repo/pull/5" }),
        "5": changeRequest({ number: 5, url: "https://github.com/Acme/repo/pull/5/" }),
      });
      yield* handlers[WS_METHODS.sourceControlLinkWorktreePullRequest]({
        worktreeId,
        reference: own,
      }).pipe(Effect.provide(handlerLayer));

      expect(dispatched).toHaveLength(1);
    }),
  );
});
