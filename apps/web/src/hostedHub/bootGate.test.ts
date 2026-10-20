import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const gate = vi.hoisted(() => ({
  accountStatus: "signed-out" as string,
  finishAccess: null as null | (() => void),
  events: [] as string[],
  bootstrapAccess: vi.fn(),
  openBeside: vi.fn(),
  preloadShell: vi.fn(() => Promise.resolve()),
  retainOwners: vi.fn(),
  prefetchRouteCode: vi.fn(),
  storeListeners: new Set<() => void>(),
}));

vi.mock("./state", () => ({
  ensureWebHostedRuntimeConfigured: vi.fn(),
  hostedHubController: { bootstrapAccess: gate.bootstrapAccess },
  hostedHubStore: {
    getState: () => ({ accountStatus: gate.accountStatus }),
    subscribe: (listener: () => void) => {
      gate.storeListeners.add(listener);
      return () => gate.storeListeners.delete(listener);
    },
  },
}));
vi.mock("./readCache", () => ({
  bootstrapWithHostedReadCache: (bootstrap: () => Promise<void>) => bootstrap(),
  canShowHostedReadPreview: () => false,
}));
vi.mock("./hostedWorkspaceOwners", () => ({
  retainHostedWorkspaceOwners: gate.retainOwners,
  prefetchHostedRouteCode: gate.prefetchRouteCode,
}));
vi.mock("../components/hostedHub/hostedRootAppShell", () => ({
  preloadHostedRootAppShell: gate.preloadShell,
}));
vi.mock("./hubSession", () => ({
  openWebHubSessionBesideAccessCheck: gate.openBeside,
}));

import { readHostedSignedInHint, resetHostedBootHintsForTests } from "./bootHints";
import { runHostedBootGate, startHostedAccessCheck } from "./bootGate";

function installStorage(): void {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
}

/** Lets the gate's chunk imports and their `.then` callbacks settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function answerAccess(accountStatus: string): Promise<void> {
  await vi.waitFor(() => expect(gate.finishAccess).not.toBeNull());
  gate.accountStatus = accountStatus;
  gate.finishAccess?.();
}

beforeEach(() => {
  installStorage();
  resetHostedBootHintsForTests();
  gate.accountStatus = "signed-out";
  gate.finishAccess = null;
  gate.events.length = 0;
  gate.bootstrapAccess.mockReset();
  gate.bootstrapAccess.mockImplementation(() => {
    gate.events.push("access check");
    return new Promise<void>((resolve) => {
      gate.finishAccess = resolve;
    });
  });
  gate.openBeside.mockClear();
  gate.preloadShell.mockReset();
  gate.preloadShell.mockImplementation(() => {
    gate.events.push("workspace shell code");
    return Promise.resolve();
  });
  gate.retainOwners.mockReset();
  gate.retainOwners.mockImplementation(() => gate.events.push("workspace owners"));
  gate.prefetchRouteCode.mockReset();
  gate.prefetchRouteCode.mockImplementation(() => gate.events.push("route code"));
  gate.storeListeners.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runHostedBootGate", () => {
  it("waits for the access check alone on a path that renders no hosted root", async () => {
    let settled = false;
    const done = runHostedBootGate({
      pathname: "/native/authorize/handoff",
      hostedRoot: null,
    }).then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    await answerAccess("authenticated");
    await done;
    // The consent page renders neither the hosted root nor the workspace shell.
    expect(gate.preloadShell).not.toHaveBeenCalled();
    // The single lifecycle owner still starts, as on every hosted boot.
    await vi.waitFor(() => expect(gate.retainOwners).toHaveBeenCalledOnce());
  });

  it("loads the workspace shell only after the answer for a browser without a signed-in hint", async () => {
    const done = runHostedBootGate({ pathname: "/", hostedRoot: Promise.resolve() });
    await flush();
    expect(gate.preloadShell).not.toHaveBeenCalled();

    await answerAccess("authenticated");
    await done;
    expect(gate.preloadShell).toHaveBeenCalledOnce();
    expect(readHostedSignedInHint()).toBe(true);
  });

  it("downloads the workspace shell beside the access check for a browser last seen signed in", async () => {
    localStorage.setItem("ryco:hosted-signed-in:v1", "1");
    const done = runHostedBootGate({ pathname: "/", hostedRoot: Promise.resolve() });
    await vi.waitFor(() => expect(gate.preloadShell).toHaveBeenCalledOnce());
    // Still waiting on the answer: the hint only moved the code download.
    expect(gate.finishAccess).not.toBeNull();

    await answerAccess("authenticated");
    await done;
    expect(gate.preloadShell).toHaveBeenCalledOnce();
  });

  it("drops the hint when the answer is signed out", async () => {
    localStorage.setItem("ryco:hosted-signed-in:v1", "1");
    const done = runHostedBootGate({ pathname: "/", hostedRoot: Promise.resolve() });
    await answerAccess("signed-out");
    await done;
    expect(readHostedSignedInHint()).toBe(false);
  });

  it("keeps the hint current as the account signs out on the page", async () => {
    const done = runHostedBootGate({ pathname: "/", hostedRoot: Promise.resolve() });
    await answerAccess("authenticated");
    await done;
    expect(readHostedSignedInHint()).toBe(true);

    gate.accountStatus = "signing-out";
    for (const listener of gate.storeListeners) listener();
    expect(readHostedSignedInHint()).toBe(false);
  });

  it("downloads the handoff sign-in beside the access check for a browser last seen signed out", async () => {
    const preloadSignIn = vi.fn(() => Promise.resolve());
    const done = runHostedBootGate({
      pathname: "/native/authorize/handoff",
      hostedRoot: null,
      preloadSignIn,
    });
    expect(preloadSignIn).toHaveBeenCalledOnce();
    // Still waiting on the answer: the hint only moved the code download.
    expect(gate.finishAccess).not.toBeNull();

    await answerAccess("signed-out");
    await done;
    expect(preloadSignIn).toHaveBeenCalledOnce();
  });

  it("sends the access check before it fetches any code", async () => {
    const preloadSignIn = vi.fn(() => {
      gate.events.push("sign-in code");
      return Promise.resolve();
    });
    const done = runHostedBootGate({
      pathname: "/native/authorize/handoff",
      hostedRoot: null,
      preloadSignIn,
    });
    expect(gate.events).toEqual(["access check", "sign-in code"]);

    await answerAccess("signed-out");
    await done;
    expect(gate.bootstrapAccess).toHaveBeenCalledOnce();
  });

  it("sends the access check before the hosted root's code prefetches", async () => {
    // A browser last seen signed in prefetches the most code beside the check.
    localStorage.setItem("ryco:hosted-signed-in:v1", "1");
    const done = runHostedBootGate({ pathname: "/", hostedRoot: Promise.resolve() });
    // Sent before the gate's first await, ahead of the chunk imports below it.
    expect(gate.events).toEqual(["access check"]);
    await vi.waitFor(() => expect(gate.events).toHaveLength(4));
    expect(gate.events[0]).toBe("access check");
    expect(gate.events.slice(1).toSorted()).toEqual([
      "route code",
      "workspace owners",
      "workspace shell code",
    ]);
    // The prefetches moved only code: the gate still waits on the answer.
    expect(gate.finishAccess).not.toBeNull();

    await answerAccess("authenticated");
    await done;
    expect(gate.bootstrapAccess).toHaveBeenCalledOnce();
  });

  it("waits for the access check the entry module sent instead of sending another", async () => {
    startHostedAccessCheck();
    startHostedAccessCheck();
    expect(gate.bootstrapAccess).toHaveBeenCalledOnce();
    // Sent before the router exists: no code is fetched for it.
    await flush();
    expect(gate.preloadShell).not.toHaveBeenCalled();
    expect(gate.retainOwners).not.toHaveBeenCalled();

    let settled = false;
    const done = runHostedBootGate({ pathname: "/", hostedRoot: Promise.resolve() }).then(() => {
      settled = true;
    });
    await flush();
    expect(gate.bootstrapAccess).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    await answerAccess("authenticated");
    await done;
    expect(gate.bootstrapAccess).toHaveBeenCalledOnce();
  });

  it("leaves a failure to send the entry module's access check to the gate", async () => {
    const failure = new Error("hosted runtime unavailable");
    gate.bootstrapAccess.mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => startHostedAccessCheck()).not.toThrow();

    await expect(runHostedBootGate({ pathname: "/", hostedRoot: Promise.resolve() })).rejects.toBe(
      failure,
    );
    // A retry of the failed root load checks access again.
    const retry = runHostedBootGate({ pathname: "/pair", hostedRoot: null });
    await answerAccess("signed-out");
    await retry;
    expect(gate.bootstrapAccess).toHaveBeenCalledTimes(2);
  });

  it("checks access again when the gate runs again", async () => {
    const first = runHostedBootGate({ pathname: "/pair", hostedRoot: null });
    await answerAccess("signed-out");
    await first;

    gate.finishAccess = null;
    const retry = runHostedBootGate({ pathname: "/pair", hostedRoot: null });
    await answerAccess("signed-out");
    await retry;
    expect(gate.bootstrapAccess).toHaveBeenCalledTimes(2);
  });

  it("opens the account socket beside the access check for a browser last seen signed in", async () => {
    localStorage.setItem("ryco:hosted-signed-in:v1", "1");
    startHostedAccessCheck();
    // Bound to whatever this check answers, and to nothing before it does.
    expect(gate.openBeside).toHaveBeenCalledExactlyOnceWith(
      gate.bootstrapAccess.mock.results[0]!.value,
    );
    const done = runHostedBootGate({ pathname: "/", hostedRoot: Promise.resolve() });
    await answerAccess("authenticated");
    await done;
    expect(gate.openBeside).toHaveBeenCalledOnce();
  });

  it("leaves the account socket to the answer for a browser without a signed-in hint", async () => {
    const done = runHostedBootGate({ pathname: "/", hostedRoot: Promise.resolve() });
    await answerAccess("authenticated");
    await done;
    expect(gate.openBeside).not.toHaveBeenCalled();
  });

  it("leaves the handoff sign-in to the route for a browser last seen signed in", async () => {
    localStorage.setItem("ryco:hosted-signed-in:v1", "1");
    const preloadSignIn = vi.fn(() => Promise.resolve());
    const done = runHostedBootGate({
      pathname: "/native/authorize/handoff",
      hostedRoot: null,
      preloadSignIn,
    });
    await answerAccess("authenticated");
    await done;
    expect(preloadSignIn).not.toHaveBeenCalled();
  });
});
