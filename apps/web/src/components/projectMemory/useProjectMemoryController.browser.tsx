import { useLayoutEffect } from "react";
import {
  EnvironmentId,
  ProjectId,
  type ProjectMemoryApi,
  type ProjectMemoryEntry,
} from "@ryco/contracts";
import { hostedHubStore, type HostedHubNode } from "@ryco/client-runtime/authorization";
import { appAtomRegistry, wsConnectionStatusForEnvironmentAtom } from "@ryco/client-runtime/rpc";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
const harness = vi.hoisted(() => ({
  api: null as ProjectMemoryApi | null,
  connection: {},
  shell: {},
}));
vi.mock("../../env", async (original) => ({
  ...(await original<typeof import("../../env")>()),
  isHostedHubMode: () => true,
}));
vi.mock("../../environmentApi", () => ({
  readEnvironmentApi: () => ({ projectMemory: harness.api }),
}));
vi.mock("../../environments/runtime", () => ({
  readEnvironmentConnection: () => harness.connection,
  subscribeEnvironmentConnections: () => () => {},
}));
vi.mock("../../store", () => ({
  useStore: Object.assign(() => true, { getState: () => harness.shell }),
  selectBootstrapCompleteForEnvironment: () => true,
}));
import { useProjectMemoryController } from "./useProjectMemoryController";
const env = EnvironmentId.make("memory-scope");
const projectId = ProjectId.make("project");
const entry: ProjectMemoryEntry = {
  id: "entry",
  projectId,
  kind: "fact",
  text: "Synthetic fact",
  revision: 2,
  pinned: true,
  createdAt: "2026-09-15T00:00:00Z",
  updatedAt: "2026-09-15T00:00:00Z",
  affirmedAt: "2026-09-15T00:00:00Z",
  provenance: { kind: "user", actorId: "b".repeat(64) },
};
const memoryPage = {
  enabled: true,
  revision: 2,
  entries: [entry],
  total: 1,
  matched: 1,
  nextOffset: null,
  asOf: entry.createdAt,
};
const initial = hostedHubStore.getState();
let result: ReturnType<typeof useProjectMemoryController>;
let mounted: Awaited<ReturnType<typeof render>> | undefined;
function Probe() {
  const controller = useProjectMemoryController(env, projectId, "thread-a");
  useLayoutEffect(() => {
    result = controller;
  }, [controller]);
  return null;
}
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  hostedHubStore.setState(initial, true);
});
for (const operation of ["list", "preview", "mutation"] as const) {
  it(`fences pending ${operation} after hosted generation changes with the same API and socket`, async () => {
    hostedHubStore.setState({
      generation: 1,
      directoryStatus: "ready",
      selectionStatus: "online",
      transportStatus: "online",
      sessionStatus: "ready",
      sessionEstablished: true,
      browserStatus: "current",
      effectiveRole: "operator",
      selectedNode: { environmentId: env } as HostedHubNode,
    });
    const socket = wsConnectionStatusForEnvironmentAtom(env);
    appAtomRegistry.set(socket, {
      ...appAtomRegistry.get(socket),
      phase: "connected",
      connectedAt: "same-socket",
      disconnectedAt: null,
    });
    const api: ProjectMemoryApi = {
      list: vi.fn(async () => memoryPage),
      preview: vi.fn(async () => ({ entries: [entry], envelopeBytes: 420 })),
      mutate: vi.fn(async () => ({ revision: 3 })),
      export: vi.fn(async () => ({
        version: 1 as const,
        projectId,
        enabled: true,
        entries: [entry],
        exportedAt: entry.createdAt,
      })),
    };
    harness.api = api;
    mounted = await render(
      <AppAtomRegistryProvider>
        <Probe />
      </AppAtomRegistryProvider>,
    );
    const controller = result!;
    await controller.refresh();
    controller.toggleRecall(entry);
    await controller.previewRecall();
    expect(controller.reviewedRecall()).not.toBeNull();
    let resolve!: (value: never) => void;
    const promise = new Promise<never>((complete) => {
      resolve = complete;
    });
    const deferred = { promise, resolve };
    if (operation === "list") api.list = () => deferred.promise;
    if (operation === "preview") api.preview = () => deferred.promise;
    if (operation === "mutation") api.mutate = () => deferred.promise;
    const pending =
      operation === "list"
        ? controller.refresh()
        : operation === "preview"
          ? controller.previewRecall()
          : controller.mutate({ operation: "affirm", id: "entry", revision: 2 });
    hostedHubStore.setState({ generation: 2 });
    // Synchronous assertion before React can commit the hosted-store update.
    expect(controller.reviewedRecall()).toBeNull();
    deferred.resolve(
      (operation === "list"
        ? memoryPage
        : operation === "preview"
          ? { entries: [entry], envelopeBytes: 420 }
          : { revision: 3 }) as never,
    );
    await pending;
    expect(controller.getSnapshot().page).toBeNull();
    expect(controller.getSnapshot().preview).toBeNull();
    expect(harness.api).toBe(api);
    expect(appAtomRegistry.get(socket).connectedAt).toBe("same-socket");
  });
}
