import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { AuthSessionId, WS_METHODS } from "@ryco/contracts";
import { rpcAccessFor } from "@ryco/shared/rpcAccessPolicy";

import type { AuthenticatedSession } from "../auth/Services/ServerAuth.ts";
import { authorizeWsRpc, type WsRpcAccess } from "../auth/wsAuthorization.ts";
import type { SourceControlProviderShape } from "../sourceControl/SourceControlProvider.ts";
import type { WsRpcContext } from "./context.ts";
import { makeSourceControlInvolvedHandlers } from "./sourceControlInvolvedRpc.ts";

function makeContext(role: AuthenticatedSession["role"]) {
  const session: AuthenticatedSession = {
    sessionId: AuthSessionId.make(`session-${role}`),
    chainId: AuthSessionId.make(`session-${role}`),
    subject: role,
    method: "browser-session-cookie",
    role,
  };
  let searches = 0;
  const provider = {
    kind: "github",
    listChangeRequests: () => Effect.succeed([]),
    searchInvolvedChangeRequests: () =>
      Effect.sync(() => {
        searches += 1;
        return {
          host: "github.com",
          viewerLogin: "octocat",
          items: [
            {
              provider: "github" as const,
              number: 12,
              title: "Add the inbox",
              url: "https://github.com/acme/app/pull/12",
              baseRefName: "main",
              headRefName: "feature/inbox",
              state: "open" as const,
              updatedAt: Option.none(),
            },
          ],
          truncated: false,
          skippedRows: 0,
        };
      }),
  } as unknown as SourceControlProviderShape;
  const ctx = {
    // The production guard: the method's tier from the shared access policy.
    ownerEffect: <A, E, R>(method: string, effect: Effect.Effect<A, E, R>) =>
      authorizeWsRpc(session, rpcAccessFor(method) as WsRpcAccess, method).pipe(
        Effect.andThen(effect),
      ),
    sourceControlRegistry: {
      resolveHandle: () =>
        Effect.succeed({
          provider,
          context: {
            provider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
            remoteName: "origin",
            remoteUrl: "git@github.com:acme/app.git",
          },
        }),
    },
    gitWorkflow: {
      cachedInvolvedList: <A, E, R>(input: { readonly load: Effect.Effect<A, E, R> }) => input.load,
    },
  } as unknown as WsRpcContext;
  return {
    handlers: makeSourceControlInvolvedHandlers(ctx),
    searchCount: () => searches,
  };
}

const input = {
  cwds: ["/work/app"],
  state: "open" as const,
  involvements: ["review-requested" as const],
};

describe("sourceControl.listInvolvedChangeRequests", () => {
  it.effect("answers owners with the pull requests that involve them", () =>
    Effect.gen(function* () {
      const { handlers, searchCount } = makeContext("owner");
      const result = yield* handlers[WS_METHODS.sourceControlListInvolvedChangeRequests](input);
      expect(searchCount()).toBe(1);
      expect(result.entries.map((entry) => entry.repositoryLabel)).toEqual(["acme/app"]);
      expect(result.sources).toEqual([
        {
          scope: "host",
          provider: "github",
          name: "github.com",
          status: "ok",
          viewerLogin: "octocat",
          truncated: false,
        },
      ]);
    }),
  );

  it.effect("refuses sessions below the operator tier before reading anything", () =>
    Effect.gen(function* () {
      const { handlers, searchCount } = makeContext("client");
      const error = yield* Effect.flip(
        handlers[WS_METHODS.sourceControlListInvolvedChangeRequests](input),
      );
      expect(error._tag).toBe("AuthRpcError");
      expect(error.message).toBe(
        "Only owner sessions can call sourceControl.listInvolvedChangeRequests.",
      );
      expect(searchCount()).toBe(0);
    }),
  );
});
