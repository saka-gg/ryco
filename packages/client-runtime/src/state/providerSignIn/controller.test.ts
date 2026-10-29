import {
  EnvironmentId,
  ProviderInstanceId,
  type ProviderSignInRespondInput,
  type ProviderSignInState,
  type ProviderSignInWireEvent,
} from "@ryco/contracts";
import { UnknownUnionMember } from "@ryco/contracts/base-schemas";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createProviderSignInController,
  getProviderSignInController,
  PROVIDER_SIGN_IN_FORBIDDEN,
  PROVIDER_SIGN_IN_INPUT_CHUNK,
  PROVIDER_SIGN_IN_RESIZE_DEBOUNCE_MS,
  type ProviderSignInApi,
  type ProviderSignInOutput,
} from "./controller.ts";

const INSTANCE = ProviderInstanceId.make("codex");

type FailureKind = "unsupported" | "response-too-large" | "failed";

interface FakeSubscription {
  readonly listener: (event: ProviderSignInWireEvent) => void;
  readonly options: {
    readonly onResubscribe?: () => void;
    readonly onError?: (kind?: FailureKind) => void;
    readonly classifyFailure?: (error: unknown) => FailureKind;
  };
  active: boolean;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeApi() {
  const subscriptions: FakeSubscription[] = [];
  const respondCalls: ProviderSignInRespondInput[] = [];
  let respondGate: ((input: ProviderSignInRespondInput) => Promise<void>) | null = null;
  const start = vi.fn(async (): Promise<ProviderSignInState> => state({ phase: "starting" }));
  const api = {
    subscribe: (
      _input: { readonly instanceId: ProviderInstanceId },
      listener: FakeSubscription["listener"],
      options: FakeSubscription["options"] = {},
    ) => {
      const subscription: FakeSubscription = { listener, options, active: true };
      subscriptions.push(subscription);
      return () => {
        subscription.active = false;
      };
    },
    start,
    respond: (input: ProviderSignInRespondInput) => {
      respondCalls.push(input);
      return respondGate ? respondGate(input) : Promise.resolve();
    },
  } as unknown as ProviderSignInApi;
  const latest = () => subscriptions.at(-1)!;
  return {
    api,
    start,
    subscriptions,
    respondCalls,
    latest,
    setRespond: (gate: (input: ProviderSignInRespondInput) => Promise<void>) => {
      respondGate = gate;
    },
    emit: (event: ProviderSignInWireEvent) => latest().listener(event),
    emitState: (next: ProviderSignInState) => latest().listener({ type: "state", state: next }),
    emitOutput: (flowId: string, offset: number, data: string, reset?: boolean) =>
      latest().listener({
        type: "output",
        flowId,
        offset,
        data,
        ...(reset === undefined ? {} : { reset }),
      }),
    /** What the transport does when a stream fails for good. */
    fail: (error: unknown) => {
      const subscription = latest();
      subscription.active = false;
      subscription.options.onError?.(subscription.options.classifyFailure?.(error));
    },
  };
}

function state(patch: Partial<ProviderSignInState> = {}): ProviderSignInState {
  return {
    instanceId: INSTANCE,
    phase: "idle",
    flowId: null,
    method: "codexDeviceCode",
    unavailableReason: null,
    interaction: null,
    expiresAt: null,
    message: null,
    ...patch,
  };
}

const terminalWaiting = (flowId = "flow-1") =>
  state({
    phase: "waiting",
    flowId,
    method: "terminal",
    interaction: { type: "terminal", cols: 100, rows: 30 },
  });

const flushMicrotasks = () => Promise.resolve().then(() => undefined);
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await flushMicrotasks();
};

afterEach(() => {
  vi.useRealTimers();
});

describe("attach", () => {
  it("follows one stream for every attach and stops after the last detach", async () => {
    const controller = createProviderSignInController(INSTANCE);
    const fake = fakeApi();
    const first = controller.attach(fake.api);
    const second = controller.attach(fake.api);
    expect(fake.subscriptions).toHaveLength(1);

    fake.emitState(state());
    expect(controller.getSnapshot().state?.phase).toBe("idle");

    first();
    await flushMicrotasks();
    expect(fake.latest().active).toBe(true);

    second();
    await flushMicrotasks();
    expect(fake.latest().active).toBe(false);
    expect(controller.getSnapshot().state).toBeNull();
    expect(controller.canDispose()).toBe(true);
  });

  it("hands the stream over when an effect re-runs: detach, then attach in the same tick", async () => {
    const controller = createProviderSignInController(INSTANCE);
    const fake = fakeApi();
    const detach = controller.attach(fake.api);
    fake.emitState(state());
    detach();
    const again = controller.attach(fake.api);
    await flushMicrotasks();
    expect(fake.subscriptions).toHaveLength(1);
    expect(fake.latest().active).toBe(true);
    expect(controller.getSnapshot().state?.phase).toBe("idle");
    again();
  });

  it("follows a new connection's api instead, keeping the last state until it reports", () => {
    const controller = createProviderSignInController(INSTANCE);
    const before = fakeApi();
    const after = fakeApi();
    controller.attach(before.api);
    before.emitState(state({ phase: "waiting", flowId: "flow-1" }));

    controller.attach(after.api);
    expect(before.latest().active).toBe(false);
    expect(after.subscriptions).toHaveLength(1);
    expect(controller.getSnapshot().state?.flowId).toBe("flow-1");

    after.emitState(state({ phase: "succeeded", flowId: "flow-1", message: "Signed in." }));
    expect(controller.getSnapshot().state?.phase).toBe("succeeded");
  });

  it("publishes a new snapshot only when the state changed", () => {
    const controller = createProviderSignInController(INSTANCE);
    const fake = fakeApi();
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.attach(fake.api);
    fake.emitState(state());
    const first = controller.getSnapshot();
    fake.emitState(state());
    expect(controller.getSnapshot()).toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("skips events and interactions a newer node added", () => {
    const controller = createProviderSignInController(INSTANCE);
    const fake = fakeApi();
    controller.attach(fake.api);
    fake.emit(new UnknownUnionMember("type", "qrCode") as unknown as ProviderSignInWireEvent);
    expect(controller.getSnapshot().state).toBeNull();

    const unknownInteraction = state({
      phase: "waiting",
      flowId: "flow-1",
      interaction: new UnknownUnionMember("type", "qrCode") as never,
    });
    fake.emitState(unknownInteraction);
    expect(controller.getSnapshot().state?.phase).toBe("waiting");
    controller.sendInput("x");
    expect(fake.respondCalls).toEqual([]);
  });
});

describe("following failures", () => {
  it("marks a node without the methods unsupported, and a session it refuses forbidden", () => {
    const old = createProviderSignInController(INSTANCE);
    const oldNode = fakeApi();
    old.attach(oldNode.api);
    oldNode.fail(new Error('RpcClientError: Unknown request tag "provider.signIn.subscribe"'));
    expect(old.getSnapshot()).toMatchObject({ unsupported: true, forbidden: false, state: null });

    const viewer = createProviderSignInController(INSTANCE);
    const node = fakeApi();
    viewer.attach(node.api);
    node.fail({ _tag: "AuthRpcError", message: "Forbidden", status: 403 });
    expect(viewer.getSnapshot()).toMatchObject({ unsupported: false, forbidden: true });
    expect(PROVIDER_SIGN_IN_FORBIDDEN).toMatch(/owner/u);
  });

  it("shows a node's own refusal and follows again when the user starts", async () => {
    const controller = createProviderSignInController(INSTANCE);
    const fake = fakeApi();
    controller.attach(fake.api);
    fake.fail({ _tag: "ProviderSignInError", message: "Sign-in is unavailable on this node." });
    expect(controller.getSnapshot().error).toBe("Sign-in is unavailable on this node.");

    await controller.start();
    expect(fake.subscriptions).toHaveLength(2);
    expect(fake.latest().active).toBe(true);
    expect(fake.start).toHaveBeenCalledTimes(1);
  });

  it("follows again on retry when the stream failed before the node reported", () => {
    const controller = createProviderSignInController(INSTANCE);
    const fake = fakeApi();
    controller.retryFollowing();
    expect(fake.subscriptions).toHaveLength(0);

    const detach = controller.attach(fake.api);
    fake.fail({ _tag: "ProviderSignInError", message: "Sign-in is unavailable on this node." });
    expect(controller.getSnapshot()).toMatchObject({
      state: null,
      error: "Sign-in is unavailable on this node.",
    });

    controller.retryFollowing();
    expect(fake.subscriptions).toHaveLength(2);
    expect(fake.latest().active).toBe(true);
    expect(controller.getSnapshot().error).toBeNull();
    expect(fake.start).not.toHaveBeenCalled();

    // A stream that still runs is left alone.
    controller.retryFollowing();
    expect(fake.subscriptions).toHaveLength(2);
    fake.emitState(state());
    expect(controller.getSnapshot().state?.phase).toBe("idle");
    detach();
  });

  it("never shows a transport failure's own text", () => {
    const controller = createProviderSignInController(INSTANCE);
    const fake = fakeApi();
    controller.attach(fake.api);
    fake.fail(new Error("socket closed: secret-token"));
    expect(controller.getSnapshot().error).not.toContain("secret-token");
  });
});

describe("start and cancel", () => {
  it("applies the node's answer to start unless the stream spoke since", async () => {
    const controller = createProviderSignInController(INSTANCE);
    const fake = fakeApi();
    controller.attach(fake.api);
    fake.emitState(state());

    await controller.start();
    expect(controller.getSnapshot()).toMatchObject({
      pending: null,
      state: { phase: "starting" },
    });

    const answer = deferred<ProviderSignInState>();
    fake.start.mockImplementationOnce(() => answer.promise);
    const running = controller.start();
    expect(controller.getSnapshot().pending).toBe("start");
    fake.emitState(state({ phase: "waiting", flowId: "flow-1" }));
    answer.resolve(state({ phase: "starting", flowId: "flow-1" }));
    await running;
    expect(controller.getSnapshot().state?.phase).toBe("waiting");
  });

  it("shows why the node refused a start and nothing else on a transport failure", async () => {
    const controller = createProviderSignInController(INSTANCE);
    const fake = fakeApi();
    controller.attach(fake.api);
    fake.start.mockRejectedValueOnce({
      _tag: "ProviderSignInError",
      message: "Another sign-in for this account store is running.",
    });
    await controller.start();
    expect(controller.getSnapshot().error).toBe(
      "Another sign-in for this account store is running.",
    );

    fake.start.mockRejectedValueOnce(new Error("WebSocket closed with token abc"));
    await controller.start();
    expect(controller.getSnapshot().error).toMatch(/^Could not start the sign-in/u);

    fake.start.mockRejectedValueOnce(new Error("Unknown request tag"));
    await controller.start();
    expect(controller.getSnapshot()).toMatchObject({ unsupported: true, error: null });
  });

  it("tells a flow the node dropped (a restart) from one that ended", async () => {
    const controller = createProviderSignInController(INSTANCE);
    const fake = fakeApi();
    controller.attach(fake.api);
    fake.emitState(state({ phase: "waiting", flowId: "flow-1" }));
    fake.emitState(state({ phase: "expired", flowId: "flow-1" }));
    fake.emitState(state());
    expect(controller.getSnapshot().interrupted).toBe(false);

    fake.emitState(state({ phase: "waiting", flowId: "flow-2" }));
    fake.latest().options.onResubscribe?.();
    fake.emitState(state());
    expect(controller.getSnapshot().interrupted).toBe(true);

    await controller.start();
    expect(controller.getSnapshot()).toMatchObject({
      interrupted: false,
      state: { phase: "starting" },
    });
  });

  it("still tells a dropped flow after following paused, as over a lost connection", async () => {
    const controller = createProviderSignInController(INSTANCE);
    const fake = fakeApi();
    let detach = controller.attach(fake.api);
    fake.emitState(state({ phase: "waiting", flowId: "flow-1" }));
    detach();
    await flushMicrotasks();
    expect(controller.getSnapshot().state).toBeNull();

    // The node restarted meanwhile: it reports idle.
    detach = controller.attach(fake.api);
    fake.emitState(state());
    expect(controller.getSnapshot().interrupted).toBe(true);

    // It stays across another pause until a flow starts.
    detach();
    await flushMicrotasks();
    detach = controller.attach(fake.api);
    fake.emitState(state());
    expect(controller.getSnapshot().interrupted).toBe(true);
    await controller.start();
    expect(controller.getSnapshot().interrupted).toBe(false);

    // The flow is still there, or ended in its own way: nothing was interrupted.
    fake.emitState(state({ phase: "waiting", flowId: "flow-2" }));
    detach();
    await flushMicrotasks();
    detach = controller.attach(fake.api);
    fake.emitState(state({ phase: "waiting", flowId: "flow-2" }));
    expect(controller.getSnapshot().interrupted).toBe(false);
    fake.emitState(state({ phase: "expired", flowId: "flow-2" }));
    detach();
    await flushMicrotasks();
    detach = controller.attach(fake.api);
    fake.emitState(state());
    expect(controller.getSnapshot().interrupted).toBe(false);
    detach();
  });

  it("does nothing without a connection", async () => {
    const controller = createProviderSignInController(INSTANCE);
    await controller.start();
    expect(controller.getSnapshot()).toMatchObject({ pending: null, error: null });
  });

  it("cancels the running flow by its id", async () => {
    const controller = createProviderSignInController(INSTANCE);
    const fake = fakeApi();
    controller.attach(fake.api);
    fake.emitState(state());
    await controller.cancel();
    expect(fake.respondCalls).toEqual([]);

    fake.emitState(state({ phase: "waiting", flowId: "flow-1" }));
    await controller.cancel();
    expect(fake.respondCalls).toEqual([
      { instanceId: INSTANCE, flowId: "flow-1", action: { type: "cancel" } },
    ]);

    fake.setRespond(() =>
      Promise.reject({
        _tag: "ProviderSignInError",
        message: "The sign-in is being checked and can no longer be cancelled.",
      }),
    );
    fake.emitState(state({ phase: "verifying", flowId: "flow-1" }));
    await controller.cancel();
    expect(controller.getSnapshot().error).toMatch(/can no longer be cancelled/u);
    fake.emitState(state({ phase: "succeeded", flowId: "flow-1" }));
    expect(controller.getSnapshot().error).toBeNull();
  });
});

describe("terminal output", () => {
  it("appends deltas, skips what it already has, and replaces it all on reset", () => {
    const controller = createProviderSignInController(INSTANCE);
    const fake = fakeApi();
    const outputs: ProviderSignInOutput[] = [];
    controller.onOutput((output) => outputs.push(output));
    controller.attach(fake.api);
    fake.emitState(terminalWaiting());

    fake.emitOutput("flow-1", 0, "Open ");
    fake.emitOutput("flow-1", 5, "https://example.com");
    fake.emitOutput("flow-1", 0, "Open https://exa");
    fake.emitOutput("flow-1", 16, "mple.com\r\n");
    expect(controller.output()).toBe("Open https://example.com\r\n");
    // The first output of a flow starts its terminal over, but is live.
    expect(outputs).toEqual([
      { reset: true, replay: false, data: "Open " },
      { reset: false, replay: false, data: "https://example.com" },
      { reset: false, replay: false, data: "\r\n" },
    ]);

    // The tail a node resends was live before: a terminal must not answer its queries again.
    fake.emitOutput("flow-1", 2, "en https://example.com\r\nCode: ", true);
    expect(controller.output()).toBe("en https://example.com\r\nCode: ");
    expect(outputs.at(-1)).toEqual({
      reset: true,
      replay: true,
      data: "en https://example.com\r\nCode: ",
    });
  });

  it("drops what an old subscription left after a re-subscribe until the reset arrives", () => {
    const controller = createProviderSignInController(INSTANCE);
    const fake = fakeApi();
    const outputs: ProviderSignInOutput[] = [];
    controller.onOutput((output) => outputs.push(output));
    controller.attach(fake.api);
    fake.emitState(terminalWaiting());
    fake.emitOutput("flow-1", 0, "one\r\n");

    fake.latest().options.onResubscribe?.();
    fake.emitOutput("flow-1", 9, "late");
    expect(controller.output()).toBe("one\r\n");

    fake.emitState(terminalWaiting());
    fake.emitOutput("flow-1", 0, "one\r\ntwo\r\n", true);
    fake.emitOutput("flow-1", 10, "three");
    expect(controller.output()).toBe("one\r\ntwo\r\nthree");
    expect(outputs.map(({ reset, replay }) => ({ reset, replay }))).toEqual([
      { reset: true, replay: false },
      { reset: true, replay: true },
      { reset: false, replay: false },
    ]);
  });

  it("starts over for a new flow and clears once the flow is gone", () => {
    const controller = createProviderSignInController(INSTANCE);
    const fake = fakeApi();
    const outputs: ProviderSignInOutput[] = [];
    controller.onOutput((output) => outputs.push(output));
    controller.attach(fake.api);
    fake.emitState(terminalWaiting("flow-1"));
    fake.emitOutput("flow-1", 0, "first");
    fake.emitState(terminalWaiting("flow-2"));
    expect(controller.output()).toBe("");
    fake.emitOutput("flow-2", 0, "second");
    expect(controller.output()).toBe("second");
    fake.emitState(state());
    expect(controller.output()).toBe("");
    expect(outputs).toEqual([
      { reset: true, replay: false, data: "first" },
      { reset: true, replay: false, data: "" },
      { reset: true, replay: false, data: "second" },
      { reset: true, replay: false, data: "" },
    ]);
  });

  it("reads the transcript as plain lines", () => {
    const controller = createProviderSignInController(INSTANCE);
    const fake = fakeApi();
    controller.attach(fake.api);
    fake.emitState(terminalWaiting());
    fake.emitOutput(
      "flow-1",
      0,
      "\u001b[1mOpen\u001b[0m https://example.com\r\n\u001b]0;title\u0007Waiting 1\rWaiting 2\r\n> ",
    );
    expect(controller.transcriptText()).toBe("Open https://example.com\nWaiting 2\n> ");

    fake.emitOutput("flow-1", 0, "x".repeat(40_000), true);
    expect(controller.transcriptText()).toHaveLength(16 * 1024);
  });
});

describe("terminal input", () => {
  it("sends input in order, one call at a time, in chunks the node takes", async () => {
    const controller = createProviderSignInController(INSTANCE);
    const fake = fakeApi();
    const gates: Array<() => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    fake.setRespond(
      () =>
        new Promise<void>((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          gates.push(() => {
            inFlight -= 1;
            resolve();
          });
        }),
    );
    controller.attach(fake.api);
    fake.emitState(terminalWaiting());

    const long = "a".repeat(PROVIDER_SIGN_IN_INPUT_CHUNK) + "b".repeat(10);
    controller.sendInput(long);
    controller.sendInput("\r");
    for (let i = 0; i < 3; i += 1) {
      await settle();
      gates.shift()?.();
    }
    await settle();

    const sent = fake.respondCalls.map((call) =>
      call.action.type === "input" ? call.action.data : call.action.type,
    );
    expect(sent).toEqual(["a".repeat(PROVIDER_SIGN_IN_INPUT_CHUNK), "b".repeat(10), "\r"]);
    expect(maxInFlight).toBe(1);
    expect(fake.respondCalls.every((call) => call.flowId === "flow-1")).toBe(true);
  });

  it("never splits a surrogate pair across chunks", async () => {
    const controller = createProviderSignInController(INSTANCE);
    const fake = fakeApi();
    controller.attach(fake.api);
    fake.emitState(terminalWaiting());
    controller.sendInput(`${"a".repeat(PROVIDER_SIGN_IN_INPUT_CHUNK - 1)}😀b`);
    await settle();
    const chunks = fake.respondCalls.map((call) =>
      call.action.type === "input" ? call.action.data : "",
    );
    expect(chunks).toEqual(["a".repeat(PROVIDER_SIGN_IN_INPUT_CHUNK - 1), "😀b"]);
  });

  it("drops what is queued when the flow changes or a send fails", async () => {
    const controller = createProviderSignInController(INSTANCE);
    const fake = fakeApi();
    const first = deferred<void>();
    fake.setRespond(() => first.promise);
    controller.attach(fake.api);
    fake.emitState(terminalWaiting());

    controller.sendInput("x".repeat(PROVIDER_SIGN_IN_INPUT_CHUNK * 3));
    await settle();
    expect(fake.respondCalls).toHaveLength(1);
    fake.emitState(state({ phase: "cancelled", flowId: "flow-1" }));
    first.resolve();
    await settle();
    expect(fake.respondCalls).toHaveLength(1);

    fake.emitState(terminalWaiting("flow-2"));
    fake.setRespond(() => Promise.reject({ _tag: "ProviderSignInError", message: "gone" }));
    controller.sendInput("y".repeat(PROVIDER_SIGN_IN_INPUT_CHUNK * 2));
    await settle();
    expect(fake.respondCalls).toHaveLength(2);
    expect(controller.getSnapshot().error).toBe("gone");

    fake.setRespond(() => Promise.resolve());
    controller.sendInput("z");
    await settle();
    expect(fake.respondCalls.at(-1)?.action).toEqual({ type: "input", data: "z" });
  });

  it("ignores input while no terminal flow waits", async () => {
    const controller = createProviderSignInController(INSTANCE);
    const fake = fakeApi();
    controller.attach(fake.api);
    fake.emitState(state({ phase: "waiting", flowId: "flow-1" }));
    controller.sendInput("x");
    await settle();
    expect(fake.respondCalls).toEqual([]);
  });

  it("resizes once the size settles, the last size winning", async () => {
    vi.useFakeTimers();
    const controller = createProviderSignInController(INSTANCE);
    const fake = fakeApi();
    controller.attach(fake.api);
    fake.emitState(terminalWaiting());

    controller.resize(80, 24);
    vi.advanceTimersByTime(PROVIDER_SIGN_IN_RESIZE_DEBOUNCE_MS - 1);
    controller.resize(120, 40);
    controller.resize(900, 0);
    vi.advanceTimersByTime(PROVIDER_SIGN_IN_RESIZE_DEBOUNCE_MS);
    expect(fake.respondCalls).toEqual([
      {
        instanceId: INSTANCE,
        flowId: "flow-1",
        action: { type: "resize", cols: 500, rows: 1 },
      },
    ]);

    controller.resize(500, 1);
    vi.advanceTimersByTime(PROVIDER_SIGN_IN_RESIZE_DEBOUNCE_MS);
    expect(fake.respondCalls).toHaveLength(1);
  });
});

describe("getProviderSignInController", () => {
  it("shares one controller per node and instance", () => {
    const env = EnvironmentId.make("env-sign-in");
    const other = EnvironmentId.make("env-sign-in-other");
    const controller = getProviderSignInController(env, INSTANCE);
    expect(getProviderSignInController(env, INSTANCE)).toBe(controller);
    expect(getProviderSignInController(other, INSTANCE)).not.toBe(controller);
    expect(getProviderSignInController(env, ProviderInstanceId.make("codex_work"))).not.toBe(
      controller,
    );
  });
});
