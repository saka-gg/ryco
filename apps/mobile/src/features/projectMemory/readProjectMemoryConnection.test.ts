import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type ProjectMemoryApi } from "@ryco/contracts";
import { hostedHubStore } from "@ryco/client-runtime/authorization";
import { captureProjectMemoryConnection } from "@ryco/client-runtime/state/project-memory";
const fixture = vi.hoisted(() => ({
  api: {} as ProjectMemoryApi,
  connection: {},
  node: {
    environmentId: "memory-node",
    generation: 1,
    effectiveRole: "operator",
    transportStatus: "online",
    sessionStatus: "ready",
    sessionEstablished: true,
    attemptPrepared: true,
  },
  e2ee: {},
  shell: true,
}));
vi.mock("../../connection/environmentApi", () => ({
  readEnvironmentApi: () => ({ projectMemory: fixture.api }),
}));
vi.mock("../../connection/hostedConnectionCoordinator", () => ({
  mobileHostedConnectionsStore: {
    getState: () => ({ selectedNodes: [fixture.node], deliveryUnknownEnvironmentIds: [] }),
  },
}));
vi.mock("../../hostedHub/primaryEnvironment", () => ({ readEnvironmentDescriptor: () => ({}) }));
vi.mock("../../hostedHub/e2eeSession", () => ({ getMobileE2eeSessionState: () => fixture.e2ee }));
vi.mock("../../hostedHub/e2eeEnrollment", () => ({
  getMobileNativeE2eeEnrollmentState: () => ({ generation: 1 }),
}));
vi.mock("../home/authoritativeNodeTrustSource", () => ({
  authoritativeNodeTrustSourceRevision: () => 1,
}));
vi.mock("../../runtime/bootstrap", () => ({
  createMobileConnectionRegistry: () => ({
    driver: { supervisor: { read: () => fixture.connection } },
  }),
}));
vi.mock("../../state/threadsRuntime", () => ({
  useStore: {
    getState: () => ({
      environmentStateById: { "memory-node": { bootstrapComplete: fixture.shell } },
    }),
  },
}));
vi.mock("@ryco/client-runtime/rpc", () => ({
  getWsConnectionStatusForEnvironment: () => ({
    phase: "connected",
    connectedAt: "same",
    disconnectedAt: null,
  }),
}));
import { readProjectMemoryConnection } from "./readProjectMemoryConnection";
const initial = hostedHubStore.getState();
afterEach(() => {
  hostedHubStore.setState(initial, true);
  fixture.node.effectiveRole = "operator";
  fixture.shell = true;
});
it("uses current shared capability and hosted generation even with the same native API/socket", () => {
  hostedHubStore.setState({ generation: 1, directoryStatus: "ready", browserStatus: "current" });
  const env = EnvironmentId.make("memory-node");
  const read = captureProjectMemoryConnection(() => readProjectMemoryConnection(env));
  expect(read()?.ready).toBe(true);
  hostedHubStore.setState({ generation: 2 });
  expect(read()?.api).toBe(fixture.api);
  expect(read()?.ready).toBe(false);
  const next = captureProjectMemoryConnection(() => readProjectMemoryConnection(env));
  expect(next()?.ready).toBe(true);
  fixture.node.effectiveRole = "viewer";
  expect(next()?.ready).toBe(false);
  fixture.node.effectiveRole = "operator";
  fixture.shell = false;
  expect(readProjectMemoryConnection(env)?.ready).toBe(false);
});
