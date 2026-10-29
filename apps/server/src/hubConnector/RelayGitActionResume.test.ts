/**
 * A hosted client's reconnect opens a new relay channel. These tests run recoverable Git
 * actions through the relay's RPC byte sessions, channel by channel, against one runner, as
 * the hub connector does: the channel that started an action closes mid-push and a later
 * channel of the same device (or of hosted web, which identifies none) attaches again.
 */
import { describe, expect, it } from "@effect/vitest";
import {
  type GitActionProgressEvent,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  WS_METHODS,
  WsRpcGroup,
} from "@ryco/contracts";
import { Deferred, Effect, Exit, Queue, Scope } from "effect";

import type { GitActionRunnerShape } from "../git/GitActionRunner.ts";
import { makeGitActionRunner } from "../git/gitActionRunnerCore.ts";
import type { WsRpcContext } from "../ws/context.ts";
import { makeGitHandlers } from "../ws/gitRpc.ts";
import { makeRpcByteSession } from "../ws/RpcByteSession.ts";
import {
  type RelayChannelAuthority,
  relayRpcPrincipal,
  rpcPrincipalOwnerKey,
} from "../ws/RpcPrincipal.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface RpcResponse {
  readonly _tag: string;
  readonly requestId?: string;
  readonly values?: ReadonlyArray<GitActionProgressEvent>;
  readonly exit?: {
    readonly _tag: "Success" | "Failure";
    readonly cause?: ReadonlyArray<{
      readonly _tag: string;
      readonly error?: { readonly _tag?: string };
    }>;
  };
}

const requestBytes = (id: string, tag: string, payload: unknown) =>
  encoder.encode(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
const ackBytes = (requestId: string) => encoder.encode(JSON.stringify({ _tag: "Ack", requestId }));

const pushed = (action: GitRunStackedActionInput["action"]): GitRunStackedActionResult => ({
  action,
  branch: { status: "skipped_not_requested" },
  commit: { status: "skipped_not_requested" },
  push: { status: "pushed", branch: "feature/demo" },
  pr: { status: "skipped_not_requested" },
  toast: { title: "Pushed feature/demo", cta: { kind: "none" } },
});

/** A push that reports its start and phase, then waits for `release`. */
const makeHeldPush = Effect.gen(function* () {
  const release = yield* Deferred.make<void>();
  const interrupted = yield* Deferred.make<void>();
  const state = { runs: 0 };
  const gitWorkflow = {
    runStackedAction: (
      input: GitRunStackedActionInput,
      options: {
        readonly progressReporter: {
          readonly publish: (event: GitActionProgressEvent) => Effect.Effect<void>;
        };
      },
    ) =>
      Effect.gen(function* () {
        state.runs += 1;
        const base = { actionId: input.actionId, cwd: input.cwd, action: input.action };
        const publish = options.progressReporter.publish;
        yield* publish({ ...base, kind: "action_started", phases: ["push"] });
        yield* publish({ ...base, kind: "phase_started", phase: "push", label: "Pushing..." });
        yield* Deferred.await(release);
        const result = pushed(input.action);
        yield* publish({ ...base, kind: "action_finished", result });
        return result;
      }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
  };
  return { release, interrupted, state, gitWorkflow };
});

/**
 * One relay channel: the git handlers over this channel's principal (its own channel id, the
 * device authority it read), served through an RPC byte session like the hub connector's.
 */
const openChannel = (input: {
  readonly channelId: string;
  readonly authority: () => RelayChannelAuthority;
  readonly runner: GitActionRunnerShape;
  readonly gitWorkflow: unknown;
}) =>
  Effect.gen(function* () {
    const principal = relayRpcPrincipal("operator", input.channelId, input.authority);
    const handlers = makeGitHandlers({
      ownerStream: (_method: string, stream: unknown) => stream,
      ownerEffect: (_method: string, effect: unknown) => effect,
      gitWorkflow: input.gitWorkflow,
      attachLinkedIssuesToPrAction: (command: GitRunStackedActionInput) => Effect.succeed(command),
      refreshGitStatus: () => Effect.void,
      gitActionRunner: input.runner,
      gitActionOwner: () => rpcPrincipalOwnerKey(principal),
    } as unknown as WsRpcContext);
    const handlerLayer = WsRpcGroup.toLayer(
      Effect.succeed(
        WsRpcGroup.of({
          [WS_METHODS.gitRunStackedAction]: handlers[WS_METHODS.gitRunStackedAction],
          [WS_METHODS.gitResumeStackedAction]: handlers[WS_METHODS.gitResumeStackedAction],
          [WS_METHODS.gitCancelStackedAction]: handlers[WS_METHODS.gitCancelStackedAction],
        } as never),
      ),
    );
    const scope = yield* Scope.make("sequential");
    const outputs = yield* Queue.unbounded<RpcResponse>();
    const session = yield* makeRpcByteSession(
      WsRpcGroup,
      handlerLayer,
      (bytes) =>
        Queue.offer(outputs, JSON.parse(decoder.decode(bytes)) as RpcResponse).pipe(Effect.asVoid),
      { queueCapacity: 8 },
    ).pipe(Scope.provide(scope));

    /**
     * Sends a stream request and collects its events, acknowledging each chunk, until it exits.
     * With `take`, stops reading after that many events (the caller then drops the channel);
     * with `onEvents`, runs `effect` once that many arrived and reads on.
     */
    const stream = (
      id: string,
      tag: string,
      payload: unknown,
      options?: {
        readonly take?: number;
        readonly onEvents?: { readonly count: number; readonly effect: Effect.Effect<void> };
      },
    ) =>
      Effect.gen(function* () {
        yield* session.receive(requestBytes(id, tag, payload));
        const events: GitActionProgressEvent[] = [];
        let notified = false;
        for (;;) {
          const response = yield* Queue.take(outputs);
          if (response.requestId !== id) continue;
          if (response._tag === "Chunk") {
            events.push(...(response.values ?? []));
            if (options?.take !== undefined && events.length >= options.take) {
              return { events, exit: undefined };
            }
            if (options?.onEvents && !notified && events.length >= options.onEvents.count) {
              notified = true;
              yield* options.onEvents.effect;
            }
            yield* session.receive(ackBytes(id));
          }
          if (response._tag === "Exit") return { events, exit: response.exit };
        }
      });

    return { stream, close: Scope.close(scope, Exit.void) };
  });

const enrolled =
  (fingerprint: Uint8Array): (() => RelayChannelAuthority) =>
  () => ({
    trustSource: "account-enrolled",
    enrollmentId: "enrollment-1",
    clientIdentityFingerprint: fingerprint,
    role: "operator",
  });

const recoverablePush = (): GitRunStackedActionInput => ({
  actionId: crypto.randomUUID(),
  cwd: "/repo",
  action: "push",
  recoverable: true,
});

describe("recoverable git actions over relay channels", () => {
  it.live("resume on a device's new channel after the starting channel closed mid-push", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runner = yield* makeGitActionRunner;
        const push = yield* makeHeldPush;
        const device = enrolled(Uint8Array.of(0x0a, 0x0b));
        const input = recoverablePush();

        const channelA = yield* openChannel({
          channelId: "channel-a",
          authority: device,
          runner,
          gitWorkflow: push.gitWorkflow,
        });
        const started = yield* channelA.stream("1", WS_METHODS.gitRunStackedAction, input, {
          take: 2,
        });
        expect(started.events.map((event) => event.kind)).toEqual([
          "action_started",
          "phase_started",
        ]);
        // The relay drops: the channel's session ends, and its requests with it.
        yield* channelA.close;
        expect(yield* Deferred.isDone(push.interrupted)).toBe(false);

        // The same device comes back on another channel, here vouched for locally.
        const channelB = yield* openChannel({
          channelId: "channel-b",
          authority: () => ({
            trustSource: "locally-verified",
            clientIdentityFingerprint: Uint8Array.of(0x0a, 0x0b),
            role: "operator",
          }),
          runner,
          gitWorkflow: push.gitWorkflow,
        });
        // The replay brings it up to date; then the push finishes on this channel.
        const resumed = yield* channelB.stream("1", WS_METHODS.gitResumeStackedAction, input, {
          onEvents: { count: 2, effect: Deferred.succeed(push.release, undefined) },
        });
        expect(resumed.exit?._tag).toBe("Success");
        expect(resumed.events.map((event) => event.kind)).toEqual([
          "action_started",
          "phase_started",
          "action_finished",
        ]);
        expect(push.state.runs).toBe(1);

        // Another device cannot attach to it.
        const otherDevice = yield* openChannel({
          channelId: "channel-c",
          authority: enrolled(Uint8Array.of(0x0c)),
          runner,
          gitWorkflow: push.gitWorkflow,
        });
        const foreign = yield* otherDevice.stream("1", WS_METHODS.gitResumeStackedAction, input);
        expect(foreign.exit?._tag).toBe("Failure");
        expect(JSON.stringify(foreign.exit)).toContain("GitActionResultUnavailableError");
        yield* channelB.close;
        yield* otherDevice.close;
      }),
    ),
  );

  it.live("finds a hosted web channel's action again by its action id alone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runner = yield* makeGitActionRunner;
        const push = yield* makeHeldPush;
        const unidentified = (): RelayChannelAuthority => ({ trustSource: "none" });
        const input = recoverablePush();

        const channelA = yield* openChannel({
          channelId: "channel-a",
          authority: unidentified,
          runner,
          gitWorkflow: push.gitWorkflow,
        });
        yield* channelA.stream("1", WS_METHODS.gitRunStackedAction, input, { take: 2 });
        yield* channelA.close;

        const channelB = yield* openChannel({
          channelId: "channel-b",
          authority: unidentified,
          runner,
          gitWorkflow: push.gitWorkflow,
        });
        // Without the starting client's random id there is nothing to find.
        const guessed = yield* channelB.stream("1", WS_METHODS.gitResumeStackedAction, {
          ...input,
          actionId: crypto.randomUUID(),
        });
        expect(JSON.stringify(guessed.exit)).toContain("GitActionResultUnavailableError");

        const resumed = yield* channelB.stream("2", WS_METHODS.gitResumeStackedAction, input, {
          onEvents: { count: 2, effect: Deferred.succeed(push.release, undefined) },
        });
        expect(resumed.exit?._tag).toBe("Success");
        expect(resumed.events.map((event) => event.kind)).toEqual([
          "action_started",
          "phase_started",
          "action_finished",
        ]);
        expect(push.state.runs).toBe(1);
        expect(yield* Deferred.isDone(push.interrupted)).toBe(false);
        yield* channelB.close;
      }),
    ),
  );
});
