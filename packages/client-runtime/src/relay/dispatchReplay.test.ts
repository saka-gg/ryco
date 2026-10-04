import {
  AuthRpcError,
  CommandId,
  EnvironmentId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ThreadId,
  type ClientOrchestrationCommand,
} from "@ryco/contracts";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import * as Socket from "effect/unstable/socket/Socket";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { HostedRuntimeTimers } from "../authorization/runtime";
import { RpcRequestRefusedError } from "../rpc/protocol";
import type { WsRpcClient } from "../rpc/wsRpcClient";
import { RpcTransportDisposedError } from "../rpc/wsTransport";
import {
  bindHostedDispatchReplay,
  HOSTED_DISPATCH_REPLAY_HORIZON_MS,
  HostedDispatchReplay,
  HostedDispatchUnconfirmedError,
  hostedDispatchLineage,
} from "./dispatchReplay";

type Dispatch = WsRpcClient["orchestration"]["dispatchCommand"];

const environmentId = EnvironmentId.make("env_replay");
const otherEnvironmentId = EnvironmentId.make("env_other");
const lineage = "account-1";

const command: ClientOrchestrationCommand = {
  type: "thread.meta.update",
  commandId: CommandId.make("cmd-replay"),
  threadId: ThreadId.make("thread-replay"),
  title: "Renamed",
};

/**
 * What a relay drop really surfaces: the relay facades emit `error` before
 * `close`, which Effect's socket turns into a read error on an open socket.
 */
const relayDrop = () =>
  new RpcClientError({ reason: new Socket.SocketReadError({ cause: new Event("error") }) });
/** What a request in flight gets when its client is disposed (suspend, retry). */
const disposed = () => new Error("All fibers interrupted without error");

const timers: HostedRuntimeTimers = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
  queueMicrotask: (callback) => globalThis.queueMicrotask(callback),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function settled(promise: Promise<unknown>) {
  let state: "pending" | "resolved" | "rejected" = "pending";
  promise.then(
    () => (state = "resolved"),
    () => (state = "rejected"),
  );
  await vi.advanceTimersByTimeAsync(0);
  return state;
}

let replay: HostedDispatchReplay;
let markUncertain: ReturnType<typeof vi.fn<() => void>>;

function attach(
  dispatch: Dispatch,
  input: { lineage?: string; environmentId?: EnvironmentId } = {},
) {
  return replay.attach({
    environmentId: input.environmentId ?? environmentId,
    lineage: input.lineage ?? lineage,
    dispatch,
    markUncertain,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  replay = new HostedDispatchReplay(() => timers);
  markUncertain = vi.fn<() => void>();
});

afterEach(() => {
  replay.resetForTests();
  vi.useRealTimers();
});

describe("HostedDispatchReplay", () => {
  it.each([
    ["a relay drop (socket read error)", relayDrop],
    [
      "a relay close",
      () => new RpcClientError({ reason: new Socket.SocketCloseError({ code: 1006 }) }),
    ],
    ["a disposed client", disposed],
    ["a disposed transport", () => new RpcTransportDisposedError()],
  ])(
    "holds the caller through %s and replays the identical envelope once ready",
    async (_, fail) => {
      replay.markReady(environmentId);
      const first = vi.fn<Dispatch>(() => Promise.reject(fail()));
      const { dispatch } = attach(first);

      const result = dispatch(command);
      expect(await settled(result)).toBe("pending");

      const second = vi.fn<Dispatch>(async () => ({ sequence: 12 }));
      attach(second);
      // A replacement that has not accepted its snapshot yet is not enough.
      expect(await settled(result)).toBe("pending");
      expect(second).not.toHaveBeenCalled();

      replay.markReady(environmentId);
      await expect(result).resolves.toEqual({ sequence: 12 });
      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledExactlyOnceWith(command);
      expect(markUncertain).not.toHaveBeenCalled();
    },
  );

  it("replays on the same attempt when its own socket recovers", async () => {
    const raw = vi
      .fn<Dispatch>()
      .mockRejectedValueOnce(relayDrop())
      .mockResolvedValue({ sequence: 3 });
    const { dispatch } = attach(raw);

    const result = dispatch(command);
    expect(await settled(result)).toBe("pending");
    replay.markReady(environmentId);

    await expect(result).resolves.toEqual({ sequence: 3 });
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["the node's command error", () => new OrchestrationDispatchCommandError({ message: "busy" })],
    ["the node's role check", () => new AuthRpcError({ message: "Forbidden", status: 403 })],
    ["a local refusal before sending", () => new RpcRequestRefusedError("forbidden")],
    [
      "a refusal before sending while the session synchronizes",
      () => new RpcRequestRefusedError("awaiting-session"),
    ],
  ])("never replays a command whose outcome is definite: %s", async (_, fail) => {
    const error = fail();
    const raw = vi.fn<Dispatch>(() => Promise.reject(error));
    const { dispatch } = attach(raw);

    await expect(dispatch(command)).rejects.toBe(error);
    replay.markReady(environmentId);
    expect(raw).toHaveBeenCalledOnce();
    expect(markUncertain).not.toHaveBeenCalled();
  });

  it.each([
    ["a defect for a payload it cannot decode", () => "Expected a known command type"],
    ["a protocol defect", () => new Error("Unknown request tag: orchestration.next")],
  ])("reports what the node answered on a live connection at once: %s", async (_, fail) => {
    const error = fail();
    const raw = vi.fn<Dispatch>(() => Promise.reject(error));
    const { dispatch } = attach(raw);

    await expect(dispatch(command)).rejects.toBe(error);
    replay.markReady(environmentId);
    expect(raw).toHaveBeenCalledOnce();
    expect(markUncertain).not.toHaveBeenCalled();
  });

  it("holds any failure once the attempt's connection was lost after the send", async () => {
    const pending = deferred<{ readonly sequence: number }>();
    const { dispatch, lost } = attach(() => pending.promise);
    const result = dispatch(command);

    lost();
    // A drop surfacing in a shape the classification does not know.
    pending.reject(new Error("socket went away"));
    expect(await settled(result)).toBe("pending");

    const second = vi.fn<Dispatch>(async () => ({ sequence: 6 }));
    attach(second);
    replay.markReady(environmentId);
    await expect(result).resolves.toEqual({ sequence: 6 });
    expect(second).toHaveBeenCalledExactlyOnceWith(command);
  });

  it("does not count a readiness published between sending and the drop", async () => {
    const pending = deferred<{ readonly sequence: number }>();
    const raw = vi
      .fn<Dispatch>()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue({ sequence: 9 });
    const { dispatch } = attach(raw);

    const result = dispatch(command);
    // A shell re-snapshot on the still-live session.
    replay.markReady(environmentId);
    pending.reject(relayDrop());
    expect(await settled(result)).toBe("pending");
    expect(raw).toHaveBeenCalledOnce();

    replay.markReady(environmentId);
    await expect(result).resolves.toEqual({ sequence: 9 });
  });

  it("fails closed, without marking, when the environment is left", async () => {
    const { dispatch } = attach(() => Promise.reject(relayDrop()));
    const result = dispatch(command);
    expect(await settled(result)).toBe("pending");

    replay.end(otherEnvironmentId);
    expect(await settled(result)).toBe("pending");
    replay.end(environmentId);
    await expect(result).rejects.toBeInstanceOf(HostedDispatchUnconfirmedError);
    expect(markUncertain).not.toHaveBeenCalled();
  });

  it("never replays a command still in flight when the environment is left", async () => {
    const pending = deferred<{ readonly sequence: number }>();
    const { dispatch, detach } = attach(() => pending.promise);
    const result = dispatch(command);

    // The node is left first; disposing its client cuts the command off after.
    replay.end(environmentId);
    detach();
    pending.reject(disposed());
    expect(await settled(result)).toBe("rejected");

    // Returning to the node within the horizon is a new visit.
    const returned = vi.fn<Dispatch>(async () => ({ sequence: 1 }));
    attach(returned);
    replay.markReady(environmentId);
    await expect(result).rejects.toBeInstanceOf(HostedDispatchUnconfirmedError);
    expect(returned).not.toHaveBeenCalled();
    expect(markUncertain).not.toHaveBeenCalled();
  });

  it("does not mark an environment it left when a replay in flight there fails", async () => {
    const { dispatch } = attach(() => Promise.reject(relayDrop()));
    const result = dispatch(command);
    expect(await settled(result)).toBe("pending");
    const replayed = deferred<{ readonly sequence: number }>();
    const { detach } = attach(() => replayed.promise);
    replay.markReady(environmentId);
    await vi.advanceTimersByTimeAsync(0);

    replay.end(environmentId);
    detach();
    replayed.reject(disposed());
    await expect(result).rejects.toBeInstanceOf(HostedDispatchUnconfirmedError);
    expect(markUncertain).not.toHaveBeenCalled();
  });

  it("never replays into a different account", async () => {
    const { dispatch } = attach(() => Promise.reject(relayDrop()));
    const result = dispatch(command);
    expect(await settled(result)).toBe("pending");

    const foreign = vi.fn<Dispatch>(async () => ({ sequence: 1 }));
    attach(foreign, { lineage: "account-2" });
    replay.markReady(environmentId);

    await expect(result).rejects.toBeInstanceOf(HostedDispatchUnconfirmedError);
    expect(foreign).not.toHaveBeenCalled();
  });

  it("never replays across a sign-out, even into the same account", async () => {
    const pending = deferred<{ readonly sequence: number }>();
    const { dispatch } = attach(() => pending.promise);
    const result = dispatch(command);

    replay.endAccountSession();
    pending.reject(disposed());
    const next = vi.fn<Dispatch>(async () => ({ sequence: 1 }));
    attach(next);
    replay.markReady(environmentId);

    await expect(result).rejects.toBeInstanceOf(HostedDispatchUnconfirmedError);
    expect(next).not.toHaveBeenCalled();
  });

  it("keeps replaying within one account session when the Hub session id rotates", () => {
    // `restoreSession` re-mints the Hub session id on every resume.
    expect(
      hostedDispatchLineage({
        accountStatus: "authenticated",
        account: {
          id: "account-1",
          displayName: "A",
          role: "owner",
          createdAt: 1,
          disabledAt: null,
        },
      }),
    ).toBe(lineage);
    expect(hostedDispatchLineage({ accountStatus: "signed-out", account: null })).toBeNull();
  });

  it("never replays into a different environment", async () => {
    const { dispatch } = attach(() => Promise.reject(relayDrop()));
    const result = dispatch(command);
    const other = vi.fn<Dispatch>(async () => ({ sequence: 1 }));
    attach(other, { environmentId: otherEnvironmentId });
    replay.markReady(otherEnvironmentId);

    expect(await settled(result)).toBe("pending");
    expect(other).not.toHaveBeenCalled();
  });

  it("gives up as unconfirmed and marks the environment once the horizon passes", async () => {
    const { dispatch } = attach(() => Promise.reject(relayDrop()));
    const result = dispatch(command);
    const assertion = expect(result).rejects.toBeInstanceOf(HostedDispatchUnconfirmedError);

    await vi.advanceTimersByTimeAsync(HOSTED_DISPATCH_REPLAY_HORIZON_MS - 1);
    expect(await settled(result)).toBe("pending");
    expect(markUncertain).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(markUncertain).toHaveBeenCalledOnce();

    const late = vi.fn<Dispatch>(async () => ({ sequence: 1 }));
    attach(late);
    replay.markReady(environmentId);
    expect(late).not.toHaveBeenCalled();
  });

  it.each([
    ["a second drop", relayDrop],
    ["a local refusal of the replay", () => new RpcRequestRefusedError("forbidden")],
    [
      "the node's role check refusing the replay",
      () => new AuthRpcError({ message: "Forbidden", status: 403 }),
    ],
  ])("replays only once: %s leaves the outcome unconfirmed", async (_, fail) => {
    const { dispatch } = attach(() => Promise.reject(relayDrop()));
    const result = dispatch(command);
    expect(await settled(result)).toBe("pending");
    const second = vi.fn<Dispatch>(() => Promise.reject(fail()));
    attach(second);
    replay.markReady(environmentId);

    await expect(result).rejects.toBeInstanceOf(HostedDispatchUnconfirmedError);
    expect(second).toHaveBeenCalledOnce();
    expect(markUncertain).toHaveBeenCalledOnce();
  });

  it.each(["awaiting-session", "awaiting-acknowledgement"] as const)(
    "waits for the next readiness when the replay is refused for now (%s)",
    async (admission) => {
      const { dispatch } = attach(() => Promise.reject(relayDrop()));
      const result = dispatch(command);
      expect(await settled(result)).toBe("pending");
      const second = vi
        .fn<Dispatch>()
        .mockRejectedValueOnce(new RpcRequestRefusedError(admission))
        .mockResolvedValue({ sequence: 14 });
      attach(second);
      replay.markReady(environmentId);
      expect(await settled(result)).toBe("pending");
      expect(second).toHaveBeenCalledOnce();

      replay.markReady(environmentId);
      await expect(result).resolves.toEqual({ sequence: 14 });
      expect(second).toHaveBeenCalledTimes(2);
      expect(markUncertain).not.toHaveBeenCalled();
    },
  );

  it("reports a replayed command's own rejection as it is", async () => {
    const rejection = new OrchestrationDispatchCommandError({
      message: "Command previously rejected (cmd-replay): thread was busy",
    });
    const { dispatch } = attach(() => Promise.reject(relayDrop()));
    const result = dispatch(command);
    expect(await settled(result)).toBe("pending");
    attach(() => Promise.reject(rejection));
    replay.markReady(environmentId);

    await expect(result).rejects.toBe(rejection);
    expect(markUncertain).not.toHaveBeenCalled();
  });

  it("reports a failed replay of a bootstrap turn start as unconfirmed", async () => {
    const bootstrap = {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-bootstrap"),
      threadId: ThreadId.make("thread-new"),
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-1"),
          title: "New thread",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
    } as unknown as ClientOrchestrationCommand;
    const { dispatch } = attach(() => Promise.reject(relayDrop()));
    const result = dispatch(bootstrap);
    expect(await settled(result)).toBe("pending");
    // A node restart cut the first attempt off after it created the thread.
    attach(() =>
      Promise.reject(
        new OrchestrationDispatchCommandError({
          message: "Thread 'thread-new' already exists and cannot be created twice.",
        }),
      ),
    );
    replay.markReady(environmentId);

    await expect(result).rejects.toBeInstanceOf(HostedDispatchUnconfirmedError);
    expect(markUncertain).toHaveBeenCalledOnce();
  });
});

describe("bindHostedDispatchReplay", () => {
  it("claims the connection's commands only once it wraps an attached client", async () => {
    const dispose = vi.fn(async () => undefined);
    const getTurnDiff = vi.fn();
    const raw = vi.fn<Dispatch>(() => Promise.reject(relayDrop()));
    const client = {
      dispose,
      orchestration: { dispatchCommand: raw, getTurnDiff },
    } as unknown as WsRpcClient;

    const binding = bindHostedDispatchReplay({ environmentId, lineage, markUncertain, replay });
    expect(binding.ownsReceiptedRequests()).toBe(false);
    const wrapped = binding.wrap(client);
    expect(binding.ownsReceiptedRequests()).toBe(true);
    expect(wrapped.orchestration.getTurnDiff).toBe(getTurnDiff);
    expect(wrapped.orchestration.dispatchCommand).not.toBe(raw);

    const result = wrapped.orchestration.dispatchCommand(command);
    await wrapped.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    // The disposed attempt is no longer a replay target.
    replay.markReady(environmentId);
    expect(await settled(result)).toBe("pending");
    expect(raw).toHaveBeenCalledOnce();
  });

  it("counts its connection's unexpected close, its disposal, and a reconnect as losses", async () => {
    const odd = () => new Error("socket went away");
    const pending = [
      deferred<{ readonly sequence: number }>(),
      deferred<{ readonly sequence: number }>(),
    ];
    const raw = vi
      .fn<Dispatch>()
      .mockImplementationOnce(() => pending[0]!.promise)
      .mockImplementationOnce(() => pending[1]!.promise);
    const reconnect = vi.fn(async () => undefined);
    const client = {
      dispose: async () => undefined,
      reconnect,
      orchestration: { dispatchCommand: raw },
    } as unknown as WsRpcClient;
    const binding = bindHostedDispatchReplay({ environmentId, lineage, markUncertain, replay });
    const wrapped = binding.wrap(client);

    // Reported by the relay attempt factory when the socket closes unexpectedly.
    const closed = wrapped.orchestration.dispatchCommand(command);
    binding.connectionLost();
    pending[0]!.reject(odd());
    expect(await settled(closed)).toBe("pending");

    const reconnected = wrapped.orchestration.dispatchCommand(command);
    await wrapped.reconnect();
    expect(reconnect).toHaveBeenCalledOnce();
    pending[1]!.reject(odd());
    expect(await settled(reconnected)).toBe("pending");

    // Without a loss the same failure is the node's answer.
    raw.mockRejectedValueOnce(odd());
    await expect(wrapped.orchestration.dispatchCommand(command)).rejects.toThrow(
      "socket went away",
    );
  });

  it.each([
    ["no authenticated account", { environmentId, lineage: null }],
    ["no environment", { environmentId: null, lineage }],
  ])("claims nothing with %s, leaving the commands tracked", (_, input) => {
    const raw = vi.fn<Dispatch>();
    const client = { orchestration: { dispatchCommand: raw } } as unknown as WsRpcClient;
    const binding = bindHostedDispatchReplay({ ...input, markUncertain, replay });

    expect(binding.wrap(client)).toBe(client);
    expect(binding.ownsReceiptedRequests()).toBe(false);
  });
});
