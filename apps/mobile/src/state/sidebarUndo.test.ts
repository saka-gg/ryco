import { beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@ryco/contracts";
const state = vi.hoisted(() => ({
  generation: {} as object | null,
  thread: { title: "Synthetic", projectId: "project" } as object | null,
  project: {} as object | null,
  role: "owner",
  sessionStatus: "ready",
  transportStatus: "online",
  prepared: true,
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("../connection/environmentApi", () => ({
  readEnvironmentApi: () => ({ orchestration: { dispatchCommand: vi.fn() } }),
}));
vi.mock("../runtime/bootstrap", () => ({
  createMobileConnectionRegistry: () => ({
    driver: {
      supervisor: {
        read: () => ({
          knownEnvironment: { source: "hub-hosted" },
          shellSnapshotReadiness: { read: () => state.generation },
        }),
      },
    },
  }),
}));
vi.mock("../connection/hostedConnectionCoordinator", () => ({
  getMobileHostedConnectionCoordinator: () => ({
    read: () => ({
      effectiveRole: state.role,
      sessionStatus: state.sessionStatus,
      transportStatus: state.transportStatus,
      attemptPrepared: state.prepared,
      sessionEstablished: true,
    }),
  }),
}));
vi.mock("./environmentServerConfigs", () => ({
  readEnvironmentServerConfig: () => ({
    environment: { capabilities: { threadSidebarUndo: true } },
  }),
}));
vi.mock("./threadsRuntime", () => ({
  useStore: { getState: () => ({}) },
  selectSidebarThreadSummaryByRef: () => state.thread,
  selectProjectByRef: () => state.project,
}));
vi.mock("../lib/ids", () => ({ newCommandId: () => "command" }));
import { readMobileSidebarUndoContext } from "./sidebarUndo";
const target = {
  environmentId: EnvironmentId.make("synthetic-node"),
  threadId: ThreadId.make("synthetic-thread"),
};
beforeEach(() => {
  state.generation = {};
  state.thread = { title: "Synthetic", projectId: "project" };
  state.project = {};
  state.role = "owner";
  state.sessionStatus = "ready";
  state.transportStatus = "online";
  state.prepared = true;
});
it.each(["owner", "operator"])("uses shared %s authorization for a ready owning node", (role) => {
  state.role = role;
  expect(readMobileSidebarUndoContext(target)?.generation).toBe(state.generation);
});
it.each([
  "viewer",
  "replaying",
  "delivery-unknown",
  "connecting",
  "attempt",
  "shell",
  "thread",
  "project",
])("refuses %s rather than using retained native state as mutation authority", (reason) => {
  if (reason === "viewer") state.role = reason;
  if (reason === "replaying" || reason === "delivery-unknown") state.sessionStatus = reason;
  if (reason === "connecting") state.transportStatus = reason;
  if (reason === "attempt") state.prepared = false;
  if (reason === "shell") state.generation = null;
  if (reason === "thread") state.thread = null;
  if (reason === "project") state.project = null;
  expect(readMobileSidebarUndoContext(target)).toBeNull();
});
