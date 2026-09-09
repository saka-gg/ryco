import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => {
  const node = { id: "node-1", environmentId: "env-1", revokedAt: null };
  return {
    state: {
      generation: 1,
      accountStatus: "authenticated",
      directoryStatus: "ready",
      browserStatus: "current",
      sessionStatus: "ready",
      selectedNode: node,
    },
    record: { transportStatus: "online", sessionStatus: "ready" },
    existing: true,
    retained: true,
    work: Promise.resolve(),
    release: vi.fn(async () => true),
    ensureRecord: vi.fn(),
    connectPrimary: vi.fn(),
    reconnect: vi.fn(),
  };
});
vi.mock("@ryco/client-runtime/authorization", () => ({
  hostedHubStore: { getState: () => fixture.state },
}));
vi.mock("../connection/hostedConnectionCoordinator", () => ({
  getMobileHostedConnectionCoordinator: () => ({
    shouldActivate: () => fixture.retained,
    ensureRecord: fixture.ensureRecord,
    releaseEnvironment: fixture.release,
  }),
}));
vi.mock("../runtime/bootstrap", () => ({
  createMobileConnectionRegistry: () => ({
    driver: {
      supervisor: {
        read: () => (fixture.existing ? { reconnect: fixture.reconnect } : null),
        connectPrimary: fixture.connectPrimary,
      },
    },
  }),
}));
vi.mock("../runtime/startupBarrier", () => ({
  mobileRuntimeStartupBarrier: {
    runAfterHydration: (work: () => Promise<void>) => {
      fixture.work = Promise.resolve().then(work);
    },
  },
}));
vi.mock("../state/threadsRuntime", () => ({ useStore: {} }));
vi.mock("./nodeStateCleanup", () => ({ demoteMobileHostedEnvironmentState: vi.fn() }));
vi.mock("./primaryEnvironment", () => ({ writePrimaryEnvironmentDescriptor: vi.fn() }));

import { mobileHostedNodeLifecycle } from "./nodeLifecycle";

beforeEach(() => {
  vi.clearAllMocks();
  fixture.state = {
    generation: 1,
    accountStatus: "authenticated",
    directoryStatus: "ready",
    browserStatus: "current",
    sessionStatus: "ready",
    selectedNode: { id: "node-1", environmentId: "env-1", revokedAt: null },
  };
  fixture.record = { transportStatus: "online", sessionStatus: "ready" };
  fixture.existing = true;
  fixture.retained = true;
  fixture.release.mockResolvedValue(true);
  fixture.ensureRecord.mockImplementation(() => fixture.record);
});

async function connect() {
  mobileHostedNodeLifecycle.connectPrimaryEnvironment();
  await fixture.work;
}

describe("mobile hosted node lifecycle recovery", () => {
  it("preserves a healthy retained connection", async () => {
    await connect();
    expect(fixture.release).not.toHaveBeenCalled();
    expect(fixture.connectPrimary).not.toHaveBeenCalled();
  });

  it("requires a fresh snapshot when the shared foreground lifecycle revalidates", async () => {
    fixture.state.sessionStatus = "synchronizing";
    await connect();
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith("env-1");
    expect(fixture.connectPrimary).toHaveBeenCalledOnce();
  });

  it("replaces ended subscriptions after shared lifecycle recovery", async () => {
    fixture.record.sessionStatus = "stale";
    await connect();
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith("env-1");
    expect(fixture.connectPrimary).toHaveBeenCalledOnce();
    expect(fixture.reconnect).not.toHaveBeenCalled();
    expect(fixture.ensureRecord).toHaveBeenLastCalledWith(fixture.state.selectedNode);
  });

  it.each(["selection", "account", "directory", "background", "lease"])(
    "does not publish a replacement after %s changes during teardown",
    async (change) => {
      fixture.record.sessionStatus = "stale";
      fixture.release.mockImplementationOnce(async () => {
        if (change === "selection") fixture.state = { ...fixture.state, generation: 2 };
        if (change === "account") fixture.state.accountStatus = "signed-out";
        if (change === "directory") fixture.state.directoryStatus = "stale";
        if (change === "background") fixture.state.browserStatus = "suspended";
        if (change === "lease") fixture.retained = false;
        return true;
      });
      await connect();
      expect(fixture.connectPrimary).not.toHaveBeenCalled();
    },
  );

  it("does not replace a connection when teardown fails", async () => {
    fixture.record.sessionStatus = "stale";
    fixture.release.mockResolvedValueOnce(false);
    await connect();
    expect(fixture.connectPrimary).not.toHaveBeenCalled();
  });
});
