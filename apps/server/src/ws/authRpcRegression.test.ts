import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import {
  AuthRpcError,
  AuthSessionId,
  CommandId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
  ProjectId,
  SourceControlProviderError,
  ThreadId,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  WS_METHODS,
} from "@ryco/contracts";

import { ServerConfig } from "../config.ts";
import type { AuthenticatedSession } from "../auth/Services/ServerAuth.ts";
import { authorizeWsRpc, type WsRpcAccess } from "../auth/wsAuthorization.ts";
import { WorkspaceAccessPolicyLayer } from "../workspace/Layers/WorkspaceAccessPolicy.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import type { SourceControlProviderShape } from "../sourceControl/SourceControlProvider.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionWorktreeRepository,
  type ProjectionWorktreeRepositoryShape,
} from "../persistence/Services/ProjectionWorktrees.ts";
import {
  SourceControlProviderRegistry,
  type SourceControlProviderRegistryShape,
} from "../sourceControl/SourceControlProviderRegistry.ts";
import type { WsRpcContext } from "./context.ts";
import { makeOrchestrationHandlers } from "./orchestrationRpc.ts";
import { makeSourceControlHandlers } from "./sourceControlRpc.ts";

const normalizationLayer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "ryco-ws-auth-rpc-test-" }),
  WorkspaceAccessPolicyLayer(undefined),
  WorkspacePathsLive,
).pipe(Layer.provideMerge(NodeServices.layer));

const sourceControlHandlerLayer = Layer.mergeAll(
  Layer.succeed(OrchestrationEngineService, {} as OrchestrationEngineShape),
  Layer.succeed(ProjectionWorktreeRepository, {} as ProjectionWorktreeRepositoryShape),
  Layer.succeed(SourceControlProviderRegistry, {} as SourceControlProviderRegistryShape),
);

const makeSession = (role: AuthenticatedSession["role"]): AuthenticatedSession => ({
  sessionId: AuthSessionId.make(`session-${role}`),
  subject: role,
  method: "browser-session-cookie",
  role,
});

const makeAccessGuards = (role: AuthenticatedSession["role"]) => {
  const session = makeSession(role);

  const withAccess = <A, E, R>(
    access: WsRpcAccess,
    method: string,
    effect: Effect.Effect<A, E, R>,
  ) => authorizeWsRpc(session, access, method).pipe(Effect.flatMap(() => effect));

  const ownerEffect = <A, E, R>(method: string, effect: Effect.Effect<A, E, R>) =>
    withAccess("owner", method, effect);

  return { ownerEffect, withAccess };
};

const dispatchCommand: ClientOrchestrationCommand = {
  type: "thread.manual-position.set",
  commandId: CommandId.make("cmd-dispatch"),
  threadId: ThreadId.make("thread-dispatch"),
  position: 10,
  changedAt: "2026-01-01T00:00:00.000Z",
};

type OrchestrationHandlers = ReturnType<typeof makeOrchestrationHandlers>;

function getTestHandler<Input, Output, Error = unknown>(
  handlers: OrchestrationHandlers,
  method: keyof OrchestrationHandlers,
): (input: Input) => Effect.Effect<Output, Error, never> {
  const handler = handlers[method];
  if (!handler) {
    throw new Error(`Missing RPC handler for ${String(method)}`);
  }
  return handler as unknown as (input: Input) => Effect.Effect<Output, Error, never>;
}

const makeOrchestrationContext = (role: AuthenticatedSession["role"]) => {
  const dispatched: OrchestrationCommand[] = [];
  const ctx = {
    ...makeAccessGuards(role),
    dispatchNormalizedCommand: (command: OrchestrationCommand) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: 7 };
      }),
    projectionSnapshotQuery: {
      getThreadShellById: () => Effect.succeed(Option.none()),
      searchThreadMessages: () => Effect.succeed([]),
    },
    terminalManager: {
      close: () => Effect.void,
    },
  } as unknown as WsRpcContext;

  return { ctx, dispatched };
};

it.effect("allows owner sessions to dispatch orchestration commands", () =>
  Effect.gen(function* () {
    const { ctx, dispatched } = makeOrchestrationContext("owner");
    const handlers = makeOrchestrationHandlers(ctx);
    const dispatchHandler = getTestHandler<
      ClientOrchestrationCommand,
      { readonly sequence: number },
      AuthRpcError | OrchestrationDispatchCommandError
    >(handlers, ORCHESTRATION_WS_METHODS.dispatchCommand);
    const result = yield* dispatchHandler(dispatchCommand).pipe(Effect.provide(normalizationLayer));

    expect(result).toEqual({ sequence: 7 });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.type).toBe("thread.manual-position.set");
  }),
);

it.effect("routes orchestration message search through the projection query", () =>
  Effect.gen(function* () {
    const { ctx } = makeOrchestrationContext("owner");
    let received: {
      query: string;
      projectId?: ProjectId | undefined;
      limit: number;
    } | null = null;
    const searchResult = {
      threadId: ThreadId.make("thread-search"),
      messageId: MessageId.make("message-search"),
      snippet: "authentication result",
      timestamp: "2026-03-01T00:00:00.000Z",
    };
    const handlers = makeOrchestrationHandlers({
      ...ctx,
      projectionSnapshotQuery: {
        ...ctx.projectionSnapshotQuery,
        searchThreadMessages: (input) =>
          Effect.sync(() => {
            received = input;
            return [searchResult];
          }),
      },
    } as WsRpcContext);
    const searchHandler = getTestHandler<
      {
        readonly query: string;
        readonly projectId?: ProjectId | undefined;
        readonly limit: number;
      },
      readonly (typeof searchResult)[],
      OrchestrationGetSnapshotError
    >(handlers, ORCHESTRATION_WS_METHODS.searchThreadMessages);

    const result = yield* searchHandler({
      query: "authentication",
      projectId: ProjectId.make("project-search"),
      limit: 500,
    });

    expect(received).toEqual({
      query: "authentication",
      projectId: ProjectId.make("project-search"),
      limit: 50,
    });
    expect(result).toEqual([searchResult]);
  }),
);

it.effect("rejects client sessions from orchestration dispatch", () =>
  Effect.gen(function* () {
    const { ctx, dispatched } = makeOrchestrationContext("client");
    const handlers = makeOrchestrationHandlers(ctx);
    const dispatchHandler = getTestHandler<
      ClientOrchestrationCommand,
      { readonly sequence: number },
      AuthRpcError
    >(handlers, ORCHESTRATION_WS_METHODS.dispatchCommand);
    const error = yield* Effect.flip(
      dispatchHandler(dispatchCommand).pipe(Effect.provide(normalizationLayer)),
    );

    if (error._tag !== "AuthRpcError") {
      throw new Error(`Expected AuthRpcError, received ${error._tag}`);
    }
    expect(error.status).toBe(403);
    expect(error.message).toBe("Only owner sessions can call orchestration.dispatchCommand.");
    expect(dispatched).toHaveLength(0);
  }),
);

const makeSourceControlContext = (role: AuthenticatedSession["role"]) => {
  let resolveCalls = 0;
  let refreshCalls = 0;
  let listCalls = 0;
  const provider = {
    kind: "github",
    listChangeRequests: (input) =>
      Effect.sync(() => {
        listCalls += 1;
        expect(input).toEqual({
          cwd: "/tmp/project",
          headSelector: "",
          state: "open",
          limit: 5,
        });
        return [];
      }),
    searchChangeRequests: () => Effect.die("searchChangeRequests should not be called"),
  } satisfies Pick<
    SourceControlProviderShape,
    "kind" | "listChangeRequests" | "searchChangeRequests"
  >;

  const ctx = {
    ...makeAccessGuards(role),
    sourceControlRegistry: {
      resolve: () =>
        Effect.sync(() => {
          resolveCalls += 1;
          return provider as unknown as SourceControlProviderShape;
        }),
    },
    refreshLinkedWorktreeSourceControlStates: () =>
      Effect.sync(() => {
        refreshCalls += 1;
      }),
  } as unknown as WsRpcContext;

  return {
    ctx,
    getState: () => ({ listCalls, refreshCalls, resolveCalls }),
  };
};

it.effect("allows owner sessions to list source-control change requests", () =>
  Effect.gen(function* () {
    const { ctx, getState } = makeSourceControlContext("owner");
    const handlers = makeSourceControlHandlers(ctx);
    const result = yield* handlers[WS_METHODS.sourceControlListChangeRequests]({
      cwd: "/tmp/project",
      state: "open",
      limit: 5,
    }).pipe(Effect.provide(sourceControlHandlerLayer));

    expect(result).toEqual([]);
    expect(getState()).toEqual({ listCalls: 1, refreshCalls: 1, resolveCalls: 1 });
  }),
);

it.effect("rejects client sessions from source-control change-request listing", () =>
  Effect.gen(function* () {
    const { ctx, getState } = makeSourceControlContext("client");
    const handlers = makeSourceControlHandlers(ctx);
    const error = yield* Effect.flip(
      handlers[WS_METHODS.sourceControlListChangeRequests]({
        cwd: "/tmp/project",
        state: "open",
        limit: 5,
      }).pipe(Effect.provide(sourceControlHandlerLayer)),
    );

    if (error._tag !== "AuthRpcError") {
      throw new Error(`Expected AuthRpcError, received ${error._tag}`);
    }
    expect(error.status).toBe(403);
    expect(error.message).toBe("Only owner sessions can call sourceControl.listChangeRequests.");
    expect(getState()).toEqual({ listCalls: 0, refreshCalls: 0, resolveCalls: 0 });
  }),
);

it.effect("returns a provider error when pull request merge is unsupported", () =>
  Effect.gen(function* () {
    const provider = { kind: "gitlab" } as SourceControlProviderShape;
    const ctx = {
      ...makeAccessGuards("owner"),
      sourceControlRegistry: { resolve: () => Effect.succeed(provider) },
      refreshStateForLinkedReference: () => Effect.void,
      refreshLinkedWorktreeSourceControlStates: () => Effect.void,
      refreshGitStatus: () => Effect.void,
    } as unknown as WsRpcContext;
    const handlers = makeSourceControlHandlers(ctx);
    const error = yield* handlers[WS_METHODS.sourceControlMergeChangeRequest]({
      cwd: "/tmp/project",
      reference: "42",
      mergeMethod: "merge",
    }).pipe(Effect.flip, Effect.provide(sourceControlHandlerLayer));

    expect(Schema.is(SourceControlProviderError)(error)).toBe(true);
    if (Schema.is(SourceControlProviderError)(error)) {
      expect(error.provider).toBe("gitlab");
      expect(error.detail).toContain("does not support pull request merges");
    }
  }),
);

it.effect("viewed files honor the source-control authorization boundary", () =>
  Effect.gen(function* () {
    let resolveCalls = 0;
    const ctx = {
      ...makeAccessGuards("client"),
      sourceControlRegistry: {
        resolve: () =>
          Effect.suspend(() => {
            resolveCalls += 1;
            return Effect.die("must not resolve");
          }),
      },
    } as unknown as WsRpcContext;
    const handlers = makeSourceControlHandlers(ctx);
    const input = { cwd: "/tmp/project", reference: "42" };
    const readError = yield* handlers[WS_METHODS.sourceControlGetChangeRequestFilesViewed](
      input,
    ).pipe(Effect.flip, Effect.provide(sourceControlHandlerLayer));
    const writeError = yield* handlers[WS_METHODS.sourceControlSetChangeRequestFileViewed]({
      ...input,
      path: "a",
      viewed: true,
      expectedHeadSha: "head",
    }).pipe(Effect.flip, Effect.provide(sourceControlHandlerLayer));
    expect(readError._tag).toBe("AuthRpcError");
    expect(writeError._tag).toBe("AuthRpcError");
    expect(resolveCalls).toBe(0);
  }),
);

it.effect("unsupported providers advertise viewed capability and reject writes", () =>
  Effect.gen(function* () {
    const provider = { kind: "gitlab" } as SourceControlProviderShape;
    const ctx = {
      ...makeAccessGuards("owner"),
      sourceControlRegistry: { resolve: () => Effect.succeed(provider) },
    } as unknown as WsRpcContext;
    const handlers = makeSourceControlHandlers(ctx);
    const input = { cwd: "/tmp/project", reference: "42" };
    const result = yield* handlers[WS_METHODS.sourceControlGetChangeRequestFilesViewed](input).pipe(
      Effect.provide(sourceControlHandlerLayer),
    );
    expect(result).toEqual({
      provider: "gitlab",
      capability: { storage: "unsupported" },
      headSha: null,
      files: [],
    });
    const error = yield* handlers[WS_METHODS.sourceControlSetChangeRequestFileViewed]({
      ...input,
      path: "a",
      viewed: true,
      expectedHeadSha: "head",
    }).pipe(Effect.flip, Effect.provide(sourceControlHandlerLayer));
    expect(error._tag).toBe("SourceControlProviderError");
  }),
);
