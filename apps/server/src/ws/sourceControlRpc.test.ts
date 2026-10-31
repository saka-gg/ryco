import * as fs from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChildProcessSpawner } from "effect/process";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Schema } from "effect";
import {
  AuthSessionId,
  GitCommandError,
  SourceControlProviderError,
  ThreadId,
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
import { ProcessLaneRef, type ProcessLane } from "../processGovernor.ts";
import { markServedWhilePaused, pausedUntilOf } from "../sourceControl/lastGoodWhilePaused.ts";
import type { SourceControlProviderShape } from "../sourceControl/SourceControlProvider.ts";
import {
  makeRepositoryListCache,
  type RepositoryListCache,
} from "../sourceControl/repositoryListCache.ts";
import {
  SourceControlProviderRegistry,
  type SourceControlProviderRegistryShape,
} from "../sourceControl/SourceControlProviderRegistry.ts";
import * as GitManager from "../git/GitManager.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import {
  WorkspaceAccessDeniedError,
  WorkspaceAccessPolicy,
  type WorkspaceAccessPolicyShape,
} from "../workspace/Services/WorkspaceAccessPolicy.ts";
import type { WsRpcContext } from "./context.ts";
import { rpcAccessFor } from "./RpcAccessPolicy.ts";
import { makeSourceControlHandlers, selectCreatedChangeRequest } from "./sourceControlRpc.ts";

const handlerLayer = Layer.mergeAll(
  Layer.succeed(OrchestrationEngineService, {} as OrchestrationEngineShape),
  Layer.succeed(ProjectionWorktreeRepository, {} as ProjectionWorktreeRepositoryShape),
  Layer.succeed(SourceControlProviderRegistry, {} as SourceControlProviderRegistryShape),
);

const ownerSession: AuthenticatedSession = {
  sessionId: AuthSessionId.make("session-owner"),
  chainId: AuthSessionId.make("session-owner"),
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
  options?: {
    /** The repository index's open/recent listing; null when it cannot answer. */
    readonly indexed?: ReadonlyArray<ChangeRequest> | null;
    /** The repository index's listing fails with this instead. */
    readonly indexedError?: SourceControlProviderError;
    /** A real repository list cache (one repository) instead of reading through. */
    readonly listCache?: RepositoryListCache;
  },
) {
  const refreshes: Array<string> = [];
  const listInvalidations: Array<string> = [];
  const resolved = { kind: "github", ...provider } as SourceControlProviderShape;
  const listCache = options?.listCache;
  const ctx = {
    ownerEffect,
    fileSystem,
    gitWorkflow: {
      cachedRepositoryList: <A, E, R>(input: {
        readonly key: string;
        readonly load: Effect.Effect<A, E, R>;
        readonly ttlMs?: number;
      }) => (listCache ? listCache.get({ repository: "repo", ...input }) : input.load),
      invalidateRepositoryLists: (cwd: string) =>
        Effect.sync(() => listInvalidations.push(cwd)).pipe(
          Effect.andThen(listCache ? listCache.invalidate("repo") : Effect.void),
        ),
      indexedChangeRequests: () =>
        options?.indexedError
          ? Effect.fail(options.indexedError)
          : Effect.succeed(options?.indexed ?? null),
    },
    sourceControlRegistry: {
      resolve: () => Effect.succeed(resolved),
    },
    callSourceControlWorkflowMethod: <A>(input: {
      readonly invoke: (
        provider: SourceControlProviderShape,
      ) => Effect.Effect<A, SourceControlProviderError> | undefined;
    }) => input.invoke(resolved) ?? Effect.die("provider lacks the workflow method"),
    refreshStateForLinkedReference: () => Effect.sync(() => refreshes.push("linked")),
    refreshLinkedWorktreeSourceControlStates: (input: { readonly reason: string }) =>
      Effect.sync(() => refreshes.push(`worktrees:${input.reason}`)),
    refreshGitStatus: () => Effect.sync(() => refreshes.push("git-status")),
  } as unknown as WsRpcContext;
  return { handlers: makeSourceControlHandlers(ctx), ctx, refreshes, listInvalidations };
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

  it.effect("serves every list surface the one default list shape", () =>
    Effect.gen(function* () {
      const changeRequests: Array<unknown> = [];
      const issues: Array<unknown> = [];
      const { handlers, refreshes } = makeContext({
        listChangeRequests: (input) =>
          Effect.sync(() => (changeRequests.push(input), [changeRequest({ number: 4 })])),
        listIssues: (input) => Effect.sync(() => (issues.push(input), [])),
      });
      yield* handlers[WS_METHODS.sourceControlListChangeRequests]({
        cwd: "/repo",
        state: "open",
        limit: 100,
      }).pipe(Effect.provide(handlerLayer));
      yield* handlers[WS_METHODS.sourceControlListIssues]({
        cwd: "/repo",
        state: "open",
        limit: 100,
      }).pipe(Effect.provide(handlerLayer));
      // No per-surface field or stack variants: the provider's default list is
      // already lean (comment counts, stack summaries in the same request).
      expect(changeRequests).toEqual([
        { cwd: "/repo", headSelector: "", state: "open", limit: 100 },
      ]);
      expect(issues).toEqual([{ cwd: "/repo", state: "open", limit: 100 }]);
      expect(refreshes).toContain("worktrees:sourceControl.listChangeRequests");
    }),
  );

  it.effect("serves the # picker from the repository index, else lean host rows", () =>
    Effect.gen(function* () {
      const listed: Array<unknown> = [];
      const indexed = [1, 2, 3].map((number) => changeRequest({ number }));
      const provider = {
        listChangeRequests: (input: unknown) =>
          Effect.sync(() => (listed.push(input), [changeRequest({ number: 9 })])),
      } as Partial<SourceControlProviderShape>;
      const fromIndex = makeContext(provider, undefined, { indexed });
      const open = yield* fromIndex.handlers[WS_METHODS.sourceControlListChangeRequests]({
        cwd: "/repo",
        state: "open",
        limit: 2,
        view: "picker",
      }).pipe(Effect.provide(handlerLayer));
      expect(open.map((item) => item.number)).toEqual([1, 2]);
      expect(listed).toEqual([]);

      // Merged rows are not indexed: the host is asked for the lean field set.
      yield* fromIndex.handlers[WS_METHODS.sourceControlListChangeRequests]({
        cwd: "/repo",
        state: "merged",
        limit: 50,
        view: "picker",
      }).pipe(Effect.provide(handlerLayer));
      expect(listed).toEqual([
        {
          cwd: "/repo",
          headSelector: "",
          state: "merged",
          limit: 50,
          includeStackSummary: false,
          fields: "summary",
        },
      ]);

      // No index (unknown remote, failed listing): lean host rows as well.
      const withoutIndex = makeContext(provider, undefined, { indexed: null });
      yield* withoutIndex.handlers[WS_METHODS.sourceControlListChangeRequests]({
        cwd: "/repo",
        state: "open",
        view: "picker",
      }).pipe(Effect.provide(handlerLayer));
      expect(listed.at(-1)).toMatchObject({ state: "open", limit: 20, fields: "summary" });
    }),
  );

  it.effect("keeps rows served while the forge is paused marked and out of link writes", () =>
    Effect.gen(function* () {
      const indexed = markServedWhilePaused(
        [1, 2, 3].map((number) => changeRequest({ number })),
        1_000_000,
      );
      const { handlers, refreshes } = makeContext({}, undefined, { indexed });
      const rows = yield* handlers[WS_METHODS.sourceControlListChangeRequests]({
        cwd: "/repo",
        state: "open",
        limit: 2,
        view: "picker",
      }).pipe(Effect.provide(handlerLayer));
      expect(rows.map((item) => item.number)).toEqual([1, 2]);
      expect(pausedUntilOf(rows)).toBe(1_000_000);
      expect(refreshes).not.toContain("worktrees:sourceControl.listChangeRequests");
    }),
  );

  it.effect(
    "does not ask a rate-limiting host again for picker rows the index could not read",
    () =>
      Effect.gen(function* () {
        const listed: Array<unknown> = [];
        const provider = {
          listChangeRequests: (input: unknown) =>
            Effect.sync(() => (listed.push(input), [changeRequest({ number: 9 })])),
        } as Partial<SourceControlProviderShape>;
        const readPicker = (indexedError: SourceControlProviderError) =>
          makeContext(provider, undefined, { indexedError })
            .handlers[WS_METHODS.sourceControlListChangeRequests]({
              cwd: "/repo",
              state: "open",
              view: "picker",
            })
            .pipe(Effect.provide(handlerLayer));

        const rateLimited = new SourceControlProviderError({
          provider: "github",
          operation: "listChangeRequests",
          detail: "GitHub API rate limit exceeded.",
          reason: "rate-limited",
          retryAt: 1_000_000,
        });
        expect(yield* Effect.flip(readPicker(rateLimited))).toBe(rateLimited);
        expect(listed).toEqual([]);

        // Any other failed listing still falls back to lean host rows.
        const offline = new SourceControlProviderError({
          provider: "github",
          operation: "listChangeRequests",
          detail: "host unreachable",
        });
        expect((yield* readPicker(offline)).map((item) => item.number)).toEqual([9]);
        expect(listed).toHaveLength(1);
      }),
  );

  it.effect("keeps a row's last good detail while the forge is rate limiting", () =>
    Effect.gen(function* () {
      let now = 1_000_000;
      let limited = false;
      const listCache = makeRepositoryListCache({ nowMs: () => now });
      const { handlers } = makeContext(
        {
          getChangeRequestDetail: (input) =>
            limited
              ? Effect.fail(
                  new SourceControlProviderError({
                    provider: "github",
                    operation: "getChangeRequestDetail",
                    detail: "GitHub requests are paused after a rate limit.",
                    reason: "rate-limited",
                    retryAt: now + 60_000,
                  }),
                )
              : Effect.succeed({ number: Number(input.reference) } as never),
        },
        undefined,
        { listCache },
      );
      const read = (fullContent?: boolean) =>
        handlers[WS_METHODS.sourceControlGetChangeRequestDetail]({
          cwd: "/repo",
          reference: "42",
          view: "row",
          ...(fullContent !== undefined ? { fullContent } : {}),
        }).pipe(Effect.provide(handlerLayer));

      yield* read();
      yield* read(true);
      limited = true;
      now += 60_000;
      const kept = yield* read();
      expect(kept).toMatchObject({ number: 42 });
      expect(pausedUntilOf(kept)).toBe(now + 60_000);
      // A full-content detail is too large to keep.
      expect(yield* Effect.flip(read(true))).toMatchObject({ reason: "rate-limited" });
    }),
  );

  it.effect("shares list reads per repository until a change request mutation", () =>
    Effect.gen(function* () {
      let lists = 0;
      const { handlers, listInvalidations } = makeContext(
        {
          listChangeRequests: () => Effect.sync(() => (lists++, [changeRequest({ number: 4 })])),
          addChangeRequestComment: () => Effect.succeed({} as never),
        },
        undefined,
        { listCache: makeRepositoryListCache() },
      );
      const list = handlers[WS_METHODS.sourceControlListChangeRequests]({
        cwd: "/repo",
        state: "open",
        limit: 100,
      }).pipe(Effect.provide(handlerLayer));
      yield* Effect.all([list, list, list], { concurrency: "unbounded" });
      yield* list;
      expect(lists).toBe(1);
      // Another state or involvement is another list.
      yield* handlers[WS_METHODS.sourceControlListChangeRequests]({
        cwd: "/repo",
        state: "open",
        limit: 100,
        involvement: "authored",
      }).pipe(Effect.provide(handlerLayer));
      expect(lists).toBe(2);

      yield* handlers[WS_METHODS.sourceControlAddChangeRequestComment]({
        cwd: "/repo",
        reference: "4",
        body: "LGTM",
      }).pipe(Effect.provide(handlerLayer));
      expect(listInvalidations).toEqual(["/repo"]);
      yield* list;
      expect(lists).toBe(3);
    }),
  );

  it.effect("reads row details in the background lane and shares them briefly", () =>
    Effect.gen(function* () {
      const lanes: Array<ProcessLane> = [];
      const listCache = makeRepositoryListCache();
      const { handlers, refreshes } = makeContext(
        {
          getChangeRequestDetail: (input) =>
            ProcessLaneRef.pipe(
              Effect.tap((lane) => Effect.sync(() => lanes.push(lane))),
              Effect.as({ number: Number(input.reference) } as never),
            ),
        },
        undefined,
        { listCache },
      );
      const read = (reference: string, view?: "row") =>
        handlers[WS_METHODS.sourceControlGetChangeRequestDetail]({
          cwd: "/repo",
          reference,
          ...(view ? { view } : {}),
        }).pipe(Effect.provide(handlerLayer));

      yield* read("42", "row");
      yield* read("42", "row");
      expect(lanes).toEqual(["background"]);
      expect(refreshes).toEqual(["linked"]);
      // Another change request is its own read; a mutation or refresh drops the share.
      yield* read("43", "row");
      yield* listCache.invalidate("repo");
      yield* read("42", "row");
      expect(lanes).toEqual(["background", "background", "background"]);

      // Focused surfaces read fresh, in the interactive lane.
      yield* read("42");
      yield* read("42");
      expect(lanes.slice(3)).toEqual(["interactive", "interactive"]);
    }),
  );

  it.effect("reads a row again only when the host's fingerprint moved", () =>
    Effect.gen(function* () {
      let now = 1_000_000;
      let details = 0;
      let fingerprint: { status: string; remarks: string; revision?: string } = {
        status: "OPEN MERGEABLE abc SUCCESS:3",
        remarks: "0  0  0",
        revision: "2026-10-30T00:00:00Z ready",
      };
      const asked: Array<{ readonly number: number; readonly reuseSinceMs?: number | undefined }> =
        [];
      const listCache = makeRepositoryListCache({ nowMs: () => now });
      const { handlers } = makeContext(
        {
          getChangeRequestDetail: (input) =>
            Effect.sync(
              () =>
                ({
                  number: Number(input.reference),
                  url: `https://github.com/acme/repo/pull/${input.reference}`,
                  version: ++details,
                }) as never,
            ),
          getChangeRequestWatchFingerprint: (input) =>
            Effect.sync(() => {
              asked.push({ number: input.number, reuseSinceMs: input.reuseSinceMs });
              return fingerprint;
            }),
          addChangeRequestComment: () => Effect.succeed({} as never),
        },
        undefined,
        { listCache },
      );
      const read = handlers[WS_METHODS.sourceControlGetChangeRequestDetail]({
        cwd: "/repo",
        reference: "42",
        view: "row",
      }).pipe(Effect.provide(handlerLayer));
      const poll = () => {
        now += 30_000;
        return read;
      };

      expect(yield* read).toMatchObject({ number: 42, version: 1 });
      // The first fingerprint comes before the second full read, which it then stands for.
      expect(yield* poll()).toMatchObject({ version: 2 });
      expect(yield* poll()).toMatchObject({ version: 2 });
      expect(yield* poll()).toMatchObject({ version: 2 });
      expect(details).toBe(2);
      expect(asked.at(-1)).toEqual({ number: 42, reuseSinceMs: 0 });

      // A check finished: the fingerprint moved.
      fingerprint = { ...fingerprint, status: "OPEN MERGEABLE abc FAILURE:1,SUCCESS:2" };
      expect(yield* poll()).toMatchObject({ version: 3 });
      // So does a new title (the revision).
      fingerprint = { ...fingerprint, revision: "2026-10-30T01:00:00Z ready" };
      expect(yield* poll()).toMatchObject({ version: 4 });
      expect(yield* poll()).toMatchObject({ version: 4 });

      // A push or an agent turn refreshes the repository: the next fingerprint must be newer.
      yield* listCache.invalidate("repo", { revalidate: "fresh" });
      const refreshedAt = now;
      expect(yield* poll()).toMatchObject({ version: 4 });
      expect(asked.at(-1)?.reuseSinceMs).toBe(refreshedAt);

      // A change Ryco made reads the row in full at once, whatever the fingerprint says.
      yield* handlers[WS_METHODS.sourceControlAddChangeRequestComment]({
        cwd: "/repo",
        reference: "42",
        body: "LGTM",
      }).pipe(Effect.provide(handlerLayer));
      expect(yield* read).toMatchObject({ version: 5 });

      // A fingerprint without a revision (a host that offers none) never stands for a row.
      fingerprint = { status: fingerprint.status, remarks: fingerprint.remarks };
      expect(yield* poll()).toMatchObject({ version: 6 });
      expect(yield* poll()).toMatchObject({ version: 7 });
    }),
  );

  it.effect("shares what rows learned across the server's connections", () =>
    Effect.gen(function* () {
      let now = 1_000_000;
      let details = 0;
      const listCache = makeRepositoryListCache({ nowMs: () => now });
      const { handlers, ctx } = makeContext(
        {
          getChangeRequestDetail: (input) =>
            Effect.sync(
              () => ({ number: Number(input.reference), url: "u", version: ++details }) as never,
            ),
          getChangeRequestWatchFingerprint: () =>
            Effect.succeed({
              status: "OPEN MERGEABLE abc SUCCESS:3",
              remarks: "0  0  0",
              revision: "2026-10-30T00:00:00Z ready",
            }),
        },
        undefined,
        { listCache },
      );
      const pollOn = (connection: typeof handlers) => {
        now += 30_000;
        return connection[WS_METHODS.sourceControlGetChangeRequestDetail]({
          cwd: "/repo",
          reference: "42",
          view: "row",
        }).pipe(Effect.provide(handlerLayer));
      };

      expect(yield* pollOn(handlers)).toMatchObject({ version: 1 });
      expect(yield* pollOn(handlers)).toMatchObject({ version: 2 });
      // Another window, a phone or a reconnect polls the same row: the fingerprint the first
      // connection's rows took still stands for it.
      const other = makeSourceControlHandlers(ctx);
      expect(yield* pollOn(other)).toMatchObject({ version: 2 });
      expect(details).toBe(2);
    }),
  );

  it.effect("reads rows of a host without a fingerprint in full, as before", () =>
    Effect.gen(function* () {
      let now = 1_000_000;
      let details = 0;
      const listCache = makeRepositoryListCache({ nowMs: () => now });
      const { handlers } = makeContext(
        {
          getChangeRequestDetail: (input) =>
            Effect.sync(
              () => ({ number: Number(input.reference), url: "u", version: ++details }) as never,
            ),
        },
        undefined,
        { listCache },
      );
      const read = handlers[WS_METHODS.sourceControlGetChangeRequestDetail]({
        cwd: "/repo",
        reference: "42",
        view: "row",
      }).pipe(Effect.provide(handlerLayer));
      for (let poll = 0; poll < 4; poll += 1) {
        yield* read;
        now += 30_000;
      }
      expect(details).toBe(4);
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
      gitWorkflow: {
        cachedRepositoryList: <A, E, R>(input: { readonly load: Effect.Effect<A, E, R> }) =>
          input.load,
        invalidateRepositoryLists: () => Effect.void,
        indexedChangeRequests: () => Effect.succeed(null),
      },
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

describe("checkout without a recognized hosting provider", () => {
  const unreachable = () => Effect.die("must not reach the provider");
  const detailOf = (error: unknown) =>
    Schema.is(SourceControlProviderError)(error) ? error.detail : String(error);
  const failureDetail = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof handlerLayer>>) =>
    effect.pipe(Effect.provide(handlerLayer), Effect.flip, Effect.map(detailOf));

  // A promoted chat's folder is a git repository with no remote: it resolves to `unknown`.
  it.effect("answers every list and search read empty instead of failing", () =>
    Effect.gen(function* () {
      const { handlers, refreshes } = makeContext({
        kind: "unknown",
        listIssues: unreachable,
        searchIssues: unreachable,
        listChangeRequests: unreachable,
        searchChangeRequests: unreachable,
        listLabels: unreachable,
        listAssignees: unreachable,
        listWorkflowRuns: unreachable,
      });
      const provide = Effect.provide(handlerLayer);

      expect(
        yield* handlers[WS_METHODS.sourceControlListChangeRequests]({
          cwd: "/repo",
          state: "open",
          limit: 50,
        }).pipe(provide),
      ).toEqual([]);
      // Filters and search narrow nothing, so they cannot widen an empty answer either.
      expect(
        yield* handlers[WS_METHODS.sourceControlListChangeRequests]({
          cwd: "/repo",
          state: "open",
          involvement: "review-requested",
        }).pipe(provide),
      ).toEqual([]);
      expect(
        yield* handlers[WS_METHODS.sourceControlListChangeRequests]({
          cwd: "/repo",
          state: "all",
          query: "flaky",
        }).pipe(provide),
      ).toEqual([]);
      expect(
        yield* handlers[WS_METHODS.sourceControlSearchChangeRequests]({
          cwd: "/repo",
          query: "flaky",
        }).pipe(provide),
      ).toEqual([]);
      expect(
        yield* handlers[WS_METHODS.sourceControlListIssues]({
          cwd: "/repo",
          state: "open",
          limit: 50,
        }).pipe(provide),
      ).toEqual([]);
      expect(
        yield* handlers[WS_METHODS.sourceControlSearchIssues]({
          cwd: "/repo",
          query: "flaky",
        }).pipe(provide),
      ).toEqual([]);
      expect(
        yield* handlers[WS_METHODS.sourceControlListIssueLabels]({ cwd: "/repo" }).pipe(provide),
      ).toEqual([]);
      expect(
        yield* handlers[WS_METHODS.sourceControlListIssueAssignees]({ cwd: "/repo" }).pipe(provide),
      ).toEqual([]);
      expect(
        yield* handlers[WS_METHODS.sourceControlListWorkflowRuns]({
          cwd: "/repo",
          pullRequestNumber: 7,
          limit: 20,
        }).pipe(provide),
      ).toEqual({
        provider: "unknown",
        repository: Option.none(),
        pullRequestNumber: Option.some(7),
        headSha: Option.none(),
        runs: [],
      });
      // The lists still refresh linked worktrees as before; that work is a no-op here.
      expect(refreshes).toContain("worktrees:sourceControl.listChangeRequests");
    }),
  );

  it.effect("still fails explicit operations with a clear message", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { handlers } = makeContext(
        {
          kind: "unknown",
          createChangeRequest: unreachable,
          listChangeRequests: unreachable,
          mergeChangeRequest: unreachable,
        },
        fileSystem,
      );

      expect(
        yield* failureDetail(
          handlers[WS_METHODS.sourceControlCreateChangeRequest]({
            cwd: "/repo",
            baseRefName: "main",
            headRefName: "feature/x",
            title: "Add things",
            body: "Body",
          }),
        ),
      ).toBe("This source control provider does not support opening change requests.");
      expect(
        yield* failureDetail(
          handlers[WS_METHODS.sourceControlMergeChangeRequest]({
            cwd: "/repo",
            reference: "7",
            mergeMethod: "squash",
          }),
        ),
      ).toBe("This source control provider does not support merging change requests.");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not hide a recognized host's list failures", () =>
    Effect.gen(function* () {
      const hostError = (operation: string) =>
        new SourceControlProviderError({
          provider: "github",
          operation,
          detail: "gh: authentication required",
        });
      const { handlers } = makeContext({
        kind: "github",
        listChangeRequests: () => Effect.fail(hostError("listChangeRequests")),
        listIssues: () => Effect.fail(hostError("listIssues")),
        listWorkflowRuns: () => Effect.fail(hostError("listWorkflowRuns")),
      });

      expect(
        yield* failureDetail(
          handlers[WS_METHODS.sourceControlListChangeRequests]({ cwd: "/repo", state: "open" }),
        ),
      ).toBe("gh: authentication required");
      expect(
        yield* failureDetail(
          handlers[WS_METHODS.sourceControlListIssues]({ cwd: "/repo", state: "open" }),
        ),
      ).toBe("gh: authentication required");
      expect(
        yield* failureDetail(handlers[WS_METHODS.sourceControlListWorkflowRuns]({ cwd: "/repo" })),
      ).toBe("gh: authentication required");
    }),
  );
});

describe("pull request watch", () => {
  const threadId = ThreadId.make("thread-watch");
  const watchContext = (service: Option.Option<unknown>) => {
    const ctx = { ownerEffect, pullRequestWatch: service } as unknown as WsRpcContext;
    return makeSourceControlHandlers(ctx);
  };

  it.effect("starts the watch as the user's switch", () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const handlers = watchContext(
        Option.some({
          setWatch: (input: unknown) =>
            Effect.sync(() => {
              calls.push(input);
              return { watch: null, now: "All 3 checks passed." };
            }),
        }),
      );
      const result = yield* handlers[WS_METHODS.sourceControlSetPullRequestWatch]({
        threadId,
        autoFix: true,
      });
      expect(result.now).toBe("All 3 checks passed.");
      expect(calls).toEqual([{ threadId, autoFix: true, origin: "user" }]);
    }),
  );

  it.effect("answers plainly on a node without pull request watches", () =>
    Effect.gen(function* () {
      const handlers = watchContext(Option.none());
      const error = yield* handlers[WS_METHODS.sourceControlSetPullRequestWatch]({
        threadId,
        news: true,
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "PullRequestWatchError", reason: "unsupported" });
    }),
  );
});

describe("change request template listing", () => {
  const input = { cwd: "/requested", baseRefName: "main" };
  for (const denied of ["role", "workspace", "none"] as const) {
    it.effect(`checks role and workspace before any git read (${denied} denied)`, () =>
      Effect.gen(function* () {
        let pathReads = 0;
        let gitReads = 0;
        const listed: Array<{ readonly cwd: string; readonly baseRefName?: string | undefined }> =
          [];
        const gitWorkflow = yield* GitWorkflowService.make().pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
                resolve: () => Effect.succeed({ kind: "git" } as never),
              }),
              Layer.mock(GitVcsDriver.GitVcsDriver)({
                execute: () =>
                  Effect.sync(() => {
                    gitReads++;
                    return {
                      exitCode: ChildProcessSpawner.ExitCode(0),
                      stdout: "/canonical\n",
                      stderr: "",
                      stdoutTruncated: false,
                      stderrTruncated: false,
                    };
                  }),
              }),
              Layer.mock(GitManager.GitManager)({
                listChangeRequestTemplates: (request) =>
                  Effect.sync(() => {
                    listed.push(request);
                    return { templates: [], generationTemplatePath: null };
                  }),
              }),
            ),
          ),
        );
        const ctx = {
          ownerEffect: <A, E, R>(_method: string, work: Effect.Effect<A, E, R>) =>
            denied === "role"
              ? Effect.fail(
                  new GitCommandError({
                    cwd: input.cwd,
                    command: "test",
                    operation: "authorization",
                    detail: "denied",
                  }),
                )
              : work,
          gitWorkflow,
        } as unknown as WsRpcContext;
        const policy = {
          assertExistingPath: () =>
            Effect.suspend(() => {
              pathReads++;
              return denied === "workspace"
                ? Effect.fail(
                    new WorkspaceAccessDeniedError({
                      operation: "listChangeRequestTemplates",
                      requestedPath: input.cwd,
                      accessRoot: "/allowed",
                      reason: "outsideRoot",
                    }),
                  )
                : Effect.succeed("/canonical");
            }),
        } as unknown as WorkspaceAccessPolicyShape;
        const outcome = yield* makeSourceControlHandlers(ctx)
          [WS_METHODS.sourceControlListChangeRequestTemplates](input)
          .pipe(
            Effect.provideService(WorkspaceAccessPolicy, policy),
            Effect.provide(handlerLayer),
            Effect.result,
          );
        expect(outcome._tag).toBe(denied === "none" ? "Success" : "Failure");
        expect(pathReads).toBe(denied === "role" ? 0 : denied === "workspace" ? 1 : 3);
        // One `rev-parse --show-toplevel`, only once the path was allowed.
        expect(gitReads).toBe(denied === "none" ? 1 : 0);
        expect(listed).toEqual(denied === "none" ? [{ ...input, cwd: "/canonical" }] : []);
        expect(rpcAccessFor(WS_METHODS.sourceControlListChangeRequestTemplates)).toBe("operator");
      }),
    );
  }
});
