import * as fs from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Schema } from "effect";
import {
  AuthSessionId,
  SourceControlProviderError,
  WS_METHODS,
  type ChangeRequest,
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
