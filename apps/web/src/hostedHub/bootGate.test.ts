import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const gate = vi.hoisted(() => ({
  accountStatus: "signed-out" as string,
  finishAccess: null as null | (() => void),
  preloadShell: vi.fn(() => Promise.resolve()),
  retainOwners: vi.fn(),
  storeListeners: new Set<() => void>(),
}));

vi.mock("./state", () => ({
  ensureWebHostedRuntimeConfigured: vi.fn(),
  hostedHubController: {
    bootstrapAccess: () =>
      new Promise<void>((resolve) => {
        gate.finishAccess = resolve;
      }),
  },
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
  prefetchHostedRouteCode: vi.fn(),
}));
vi.mock("../components/hostedHub/hostedRootAppShell", () => ({
  preloadHostedRootAppShell: gate.preloadShell,
}));

import { readHostedSignedInHint, resetHostedBootHintsForTests } from "./bootHints";
import { runHostedBootGate } from "./bootGate";

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
  gate.preloadShell.mockClear();
  gate.retainOwners.mockClear();
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
