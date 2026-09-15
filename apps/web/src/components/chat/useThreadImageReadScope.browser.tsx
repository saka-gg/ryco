import { useEffect } from "react";
import { EnvironmentId } from "@ryco/contracts";
import type { HostedHubNode } from "@ryco/client-runtime/authorization";
import { hostedHubStore } from "@ryco/client-runtime/authorization";
import { appAtomRegistry, wsConnectionStatusForEnvironmentAtom } from "@ryco/client-runtime/rpc";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";

const harness = vi.hoisted(() => ({
  hosted: false,
  connection: {} as object | null,
  listeners: new Set<() => void>(),
}));
vi.mock("../../env", async (original) => ({
  ...(await original<typeof import("../../env")>()),
  isHostedHubMode: () => harness.hosted,
}));
vi.mock("../../environments/runtime", () => ({
  readEnvironmentConnection: () => harness.connection,
  subscribeEnvironmentConnections: (listener: () => void) => {
    harness.listeners.add(listener);
    return () => {
      harness.listeners.delete(listener);
    };
  },
}));
import { useThreadImageReadScope } from "./useThreadImageReadScope";
const env = EnvironmentId.make("gallery-test");
const initialHosted = hostedHubStore.getState();
let result: ReturnType<typeof useThreadImageReadScope>;
function Probe() {
  const value = useThreadImageReadScope(env);
  useEffect(() => {
    result = value;
  }, [value]);
  return null;
}
function connected() {
  const atom = wsConnectionStatusForEnvironmentAtom(env);
  appAtomRegistry.set(atom, {
    ...appAtomRegistry.get(atom),
    phase: "connected",
    connectedAt: "first",
    disconnectedAt: null,
  });
}
afterEach(() => {
  hostedHubStore.setState(initialHosted, true);
  harness.hosted = false;
  harness.connection = {};
});

it("fences same-client socket replacement synchronously and rotates the resource lifetime", async () => {
  connected();
  const screen = await render(
    <AppAtomRegistryProvider>
      <Probe />
    </AppAtomRegistryProvider>,
  );
  expect(result.available).toBe(true);
  const previous = result;
  const atom = wsConnectionStatusForEnvironmentAtom(env);
  appAtomRegistry.set(atom, { ...appAtomRegistry.get(atom), connectedAt: "second" });
  expect(previous.isCurrent()).toBe(false);
  await vi.waitFor(() => expect(result.lifetime).not.toBe(previous.lifetime));
  expect(result.isCurrent()).toBe(true);
  harness.connection = null;
  expect(result.isCurrent()).toBe(false);
  harness.listeners.forEach((listener) => listener());
  await vi.waitFor(() => expect(result.available).toBe(false));
  await screen.unmount();
});

it("requires the authoritative hosted snapshot and fences generation, role, and directory changes", async () => {
  harness.hosted = true;
  connected();
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
  const screen = await render(
    <AppAtomRegistryProvider>
      <Probe />
    </AppAtomRegistryProvider>,
  );
  expect(result.available).toBe(true);
  const previous = result;
  hostedHubStore.setState({ generation: 2, sessionStatus: "replaying" });
  expect(previous.isCurrent()).toBe(false);
  await vi.waitFor(() => expect(result.available).toBe(false));
  hostedHubStore.setState({ sessionStatus: "ready" });
  await vi.waitFor(() => expect(result.available).toBe(true));
  const beforeRole = result;
  hostedHubStore.setState({ effectiveRole: null });
  expect(beforeRole.isCurrent()).toBe(false);
  await vi.waitFor(() => expect(result.available).toBe(false));
  hostedHubStore.setState({ effectiveRole: "operator", selectedNode: null });
  await vi.waitFor(() => expect(result.available).toBe(false));
  await screen.unmount();
});
