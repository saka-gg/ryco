import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveHostedRpcCapability } from "@ryco/client-runtime/authorization";
import {
  AuthRpcError,
  AuthSessionId,
  MessageId,
  ProjectId,
  type ThreadForkAttemptState,
  ThreadForkError,
  type ThreadForkInput,
  type ThreadForkResult,
  ThreadId,
  WS_METHODS,
} from "@ryco/contracts";
import { hostedRoleAllows } from "@ryco/shared/rpcAccessPolicy";
import { Cause, Effect, Option } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import type { AuthenticatedSession } from "../auth/Services/ServerAuth.ts";
import { authorizeRpcPrincipal } from "../auth/wsAuthorization.ts";
import { ServerRuntimeStartupError } from "../serverRuntimeStartup.ts";
import type { NativeForkOutcome } from "../threadFork/nativeFork.ts";
import type { ThreadForkShape } from "../threadFork/Services/ThreadFork.ts";
import {
  createForkHarness,
  fakeNative,
  seedCompletedTurn,
  seedNativeBinding,
  seedProject,
  seedThread,
} from "../threadFork/threadFork.fixtures.ts";
import type { WsRpcContext } from "./context.ts";
import { rpcAccessFor } from "./RpcAccessPolicy.ts";
import { directRpcPrincipal, type RpcPrincipal, relayRpcPrincipal } from "./RpcPrincipal.ts";
import { makeThreadForkHandlers } from "./threadForkRpc.ts";

const request: ThreadForkInput = {
  forkKey: "fork-key-rpc-000001",
  sourceThreadId: ThreadId.make("thread-source"),
  sourceMessageId: MessageId.make("message-reply"),
  destination: { kind: "current-checkout" },
};

const forked: ThreadForkResult = {
  threadId: ThreadId.make("fork-thread"),
  projectId: ProjectId.make("project"),
  replayed: false,
  providerContext: "handoff",
  checkout: { kind: "current-checkout", worktreePath: null, branch: null },
  notices: [],
};

/** The handler with ws/context's guard (`ownerEffect` → the policy tier) and counters. */
function fixture(
  principal: RpcPrincipal,
  options: {
    readonly service?: boolean;
    readonly gate?: (
      effect: Effect.Effect<unknown>,
    ) => Effect.Effect<unknown, ServerRuntimeStartupError>;
    readonly attempt?: ThreadForkAttemptState;
  } = {},
) {
  const counts = { fork: 0, gate: 0, forkInsideGate: 0 };
  let insideGate = false;
  const service: ThreadForkShape = {
    fork: () =>
      Effect.sync(() => {
        counts.fork++;
        if (insideGate) counts.forkInsideGate++;
        return forked;
      }),
    attemptState: () => Effect.succeed(options.attempt ?? "none"),
    recover: () => Effect.void,
  };
  const ctx = {
    threadFork: options.service === false ? Option.none() : Option.some(service),
    ownerEffect: <A, E, R>(method: string, effect: Effect.Effect<A, E, R>) =>
      authorizeRpcPrincipal(principal, rpcAccessFor(method) as never, method).pipe(
        Effect.andThen(effect),
      ),
    enqueueStartupCommand: <A, E>(effect: Effect.Effect<A, E>) => {
      counts.gate++;
      const admitted = Effect.sync(() => {
        insideGate = true;
      }).pipe(
        Effect.andThen(effect),
        Effect.ensuring(
          Effect.sync(() => {
            insideGate = false;
          }),
        ),
      );
      return options.gate ? options.gate(admitted as never) : admitted;
    },
  } as unknown as WsRpcContext;
  const handlers = makeThreadForkHandlers(ctx);
  const run = () => Effect.runPromise(Effect.exit(handlers[WS_METHODS.threadsFork](request)));
  return { counts, run };
}

const directSession = (role: "owner" | "client") =>
  ({ sessionId: AuthSessionId.make(`session-${role}`), role }) as unknown as AuthenticatedSession;

describe("threads.fork RPC", () => {
  it("requires operator access and refuses viewers before reading or writing anything", async () => {
    expect(rpcAccessFor(WS_METHODS.threadsFork)).toBe("operator");
    const cases: ReadonlyArray<readonly [string, RpcPrincipal, boolean]> = [
      ["relay viewer", relayRpcPrincipal("viewer", "fixture"), false],
      ["direct client", directRpcPrincipal(directSession("client")), false],
      ["relay operator", relayRpcPrincipal("operator", "fixture"), true],
      ["relay owner", relayRpcPrincipal("owner", "fixture"), true],
      ["direct owner", directRpcPrincipal(directSession("owner")), true],
    ];
    for (const [label, principal, allowed] of cases) {
      const { counts, run } = fixture(principal);
      const exit = await run();
      if (allowed) {
        expect(exit, label).toMatchObject({ _tag: "Success", value: forked });
        // Admitted through the startup gate, then run outside it: a long fork never holds up
        // the commands queued behind it.
        expect(counts, label).toEqual({ fork: 1, gate: 1, forkInsideGate: 0 });
      } else {
        const error = exit._tag === "Failure" ? Cause.squash(exit.cause) : null;
        expect(error, label).toBeInstanceOf(AuthRpcError);
        expect(error, label).toMatchObject({ status: 403 });
        expect(counts, label).toEqual({ fork: 0, gate: 0, forkInsideGate: 0 });
      }
    }
    // Hosted clients see the same boundary before they send anything.
    for (const role of ["viewer", "operator", "owner"] as const) {
      expect(hostedRoleAllows(role, WS_METHODS.threadsFork)).toBe(role !== "viewer");
      expect(
        resolveHostedRpcCapability({
          hosted: true,
          role,
          fresh: true,
          browserCurrent: true,
          sessionReady: true,
          method: WS_METHODS.threadsFork,
        }).allowed,
      ).toBe(role !== "viewer");
    }
  });

  it("answers unavailable without the service, and maps a startup gate refusal", async () => {
    const owner = relayRpcPrincipal("owner", "fixture");
    const missing = fixture(owner, { service: false });
    const unavailable = await missing.run();
    expect(unavailable._tag === "Failure" ? Cause.squash(unavailable.cause) : null).toMatchObject({
      reason: "unavailable",
      retryable: false,
      attempt: "none",
    });

    // A refusal before the fork ran still reports what the node holds for the key, e.g. an
    // attempt from before a restart that recovery will finish.
    for (const attempt of ["none", "running", "stopped"] as const) {
      const starting = fixture(owner, {
        attempt,
        gate: () =>
          Effect.fail(
            new ServerRuntimeStartupError({ message: "still starting", reason: "timeout" }),
          ),
      });
      const exit = await starting.run();
      const error = exit._tag === "Failure" ? Cause.squash(exit.cause) : null;
      expect(error).toBeInstanceOf(ThreadForkError);
      expect(error).toMatchObject({ reason: "source-busy", retryable: true, attempt });
      expect(starting.counts.fork).toBe(0);
    }
  });
});

describe("threads.fork RPC with the fork service", () => {
  it("lets a fork finish when the client disconnects while it runs", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "ryco-fork-rpc-detach-")));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const native = fakeNative(() =>
      Effect.sleep("300 millis").pipe(
        Effect.as<NativeForkOutcome>({
          kind: "forked",
          nativeThreadId: "copy",
          ownedCopy: { kind: "codex-thread", threadId: "copy" },
        }),
      ),
    );
    const h = await createForkHarness({ service: { native: native.native } });
    try {
      const projectId = ProjectId.make("fork-rpc-project");
      const sourceThreadId = ThreadId.make("fork-rpc-source");
      await seedProject(h, { projectId, workspaceRoot: workspace });
      await seedThread(h, { threadId: sourceThreadId, projectId });
      const turn = await seedCompletedTurn(h, { threadId: sourceThreadId, index: 1 });
      await seedNativeBinding(h, {
        threadId: sourceThreadId,
        instance: "codex",
        cwd: workspace,
        nativeId: "codex-source",
      });
      const ctx = {
        threadFork: Option.some(h.forks),
        ownerEffect: <A, E, R>(_method: string, effect: Effect.Effect<A, E, R>) => effect,
        enqueueStartupCommand: <A, E>(effect: Effect.Effect<A, E>) => effect,
      } as unknown as WsRpcContext;
      const handlers = makeThreadForkHandlers(ctx);
      const input: ThreadForkInput = {
        forkKey: "fork-key-rpc-detach-0001",
        sourceThreadId,
        sourceMessageId: turn.replyId,
        destination: { kind: "current-checkout" },
      };

      // The connection drops while the provider is copying: the handler fiber is interrupted.
      const dropped = await Effect.runPromise(
        Effect.exit(handlers[WS_METHODS.threadsFork](input).pipe(Effect.timeout("100 millis"))),
      );
      expect(dropped._tag).toBe("Failure");
      expect(native.calls).toHaveLength(1);

      await vi.waitFor(
        async () =>
          expect(await h.ledgerRows()).toEqual([{ forkKey: input.forkKey, phase: "completed" }]),
        { timeout: 10_000, interval: 20 },
      );
      // Reconnected, the client's retry gets the fork the first request created.
      const retried = await Effect.runPromise(handlers[WS_METHODS.threadsFork](input));
      expect(retried).toMatchObject({ replayed: true, providerContext: "native" });
      expect(native.calls).toHaveLength(1);
    } finally {
      await h.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
