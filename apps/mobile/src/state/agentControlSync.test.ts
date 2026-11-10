import { EnvironmentId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// A minimal effect host: each "screen" calls the hook once per render, and the
// harness runs, re-runs (on changed deps) and cleans up its effects the way
// React does, without a renderer.
const host = vi.hoisted(() => ({
  pending: [] as Array<{ readonly effect: () => void | (() => void); readonly deps: unknown[] }>,
}));
vi.mock("react", () => ({
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    host.pending.push({ effect, deps });
  },
}));

const runtime = vi.hoisted(() => ({
  phase: "connected" as string,
  api: null as null | { readonly agentControl: { readonly subscribeProposals: unknown } },
  apiListeners: new Set<() => void>(),
}));
vi.mock("../rpc/wsConnectionState", () => ({
  useWsConnectionStatusForEnvironment: () => ({ phase: runtime.phase }),
}));
vi.mock("../connection/environmentApi", () => ({
  readEnvironmentApi: () => runtime.api ?? undefined,
  subscribeEnvironmentApis: (listener: () => void) => {
    runtime.apiListeners.add(listener);
    return () => runtime.apiListeners.delete(listener);
  },
}));

import { useAgentControlSync } from "./agentControlSync";

const MACHINE = EnvironmentId.make("env-machine");
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

function connect() {
  const subscribeProposals = vi.fn((_listener: unknown, _options?: unknown) => vi.fn());
  runtime.api = { agentControl: { subscribeProposals } };
  return subscribeProposals;
}

/** Mounts one screen that calls `useAgentControlSync`; returns rerender/unmount. */
function mountScreen(environmentId: EnvironmentId, enabled: boolean) {
  let deps: unknown[] | null = null;
  let cleanup: void | (() => void) = undefined;
  const render = () => {
    host.pending.length = 0;
    useAgentControlSync(environmentId, enabled);
    const [next] = host.pending.splice(0);
    if (!next) throw new Error("useAgentControlSync registered no effect");
    const changed =
      deps === null ||
      deps.length !== next.deps.length ||
      deps.some((value, index) => !Object.is(value, next.deps[index]));
    if (!changed) return;
    cleanup?.();
    deps = next.deps;
    cleanup = next.effect();
  };
  render();
  return {
    rerender: render,
    unmount: () => {
      cleanup?.();
      cleanup = undefined;
    },
  };
}

afterEach(async () => {
  runtime.api = null;
  runtime.phase = "connected";
  await flush();
  expect(runtime.apiListeners.size).toBe(0);
});

describe("useAgentControlSync on the phone", () => {
  it("opens one Agent Control stream for three screens of one machine and closes it after the last", async () => {
    const subscribeProposals = connect();
    const threadScreen = mountScreen(MACHINE, true);
    const scheduledTasks = mountScreen(MACHINE, true);
    const scheduleCheckout = mountScreen(MACHINE, true);

    // Every stream opens with a full snapshot, so streams opened = snapshots sent.
    expect(subscribeProposals).toHaveBeenCalledTimes(1);
    const unsubscribe = subscribeProposals.mock.results[0]!.value;

    threadScreen.unmount();
    scheduledTasks.unmount();
    await flush();
    expect(unsubscribe).not.toHaveBeenCalled();

    scheduleCheckout.unmount();
    await flush();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("subscribes nothing while the server-side setting is off", async () => {
    const subscribeProposals = connect();
    const screen = mountScreen(MACHINE, false);
    expect(subscribeProposals).not.toHaveBeenCalled();
    screen.unmount();
  });

  it("opens the stream once the machine's connection arrives, and again on a new connection", async () => {
    runtime.phase = "connecting";
    const first = mountScreen(MACHINE, true);
    const second = mountScreen(MACHINE, true);

    const initial = connect();
    runtime.phase = "connected";
    first.rerender();
    second.rerender();
    expect(initial).toHaveBeenCalledTimes(1);

    // The socket drops and a new connection (a new api object) replaces it.
    runtime.phase = "reconnecting";
    const replacement = connect();
    first.rerender();
    second.rerender();
    await flush();
    expect(initial.mock.results[0]!.value).toHaveBeenCalledTimes(1);
    expect(replacement).toHaveBeenCalledTimes(1);

    first.unmount();
    second.unmount();
    await flush();
    expect(replacement.mock.results[0]!.value).toHaveBeenCalledTimes(1);
  });

  it("follows a replaced connection even before any screen re-renders", async () => {
    const initial = connect();
    const screen = mountScreen(MACHINE, true);
    const replacement = connect();
    for (const listener of runtime.apiListeners) listener();
    expect(initial.mock.results[0]!.value).toHaveBeenCalledTimes(1);
    expect(replacement).toHaveBeenCalledTimes(1);
    screen.unmount();
  });
});
