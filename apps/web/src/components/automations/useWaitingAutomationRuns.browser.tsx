import { EnvironmentId, type ServerConfig } from "@ryco/contracts";
import { appAtomRegistry, serverConfigAtom } from "@ryco/client-runtime/rpc";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

/* The primary device, connected; every queue subscription is recorded. */
const device = vi.hoisted(() => ({
  client: {},
  subscribeProposals: vi.fn((_listener: unknown, _options: { readonly onError: () => void }) =>
    vi.fn(),
  ),
}));
vi.mock("../../environments/primary", async (original) => ({
  ...(await original<typeof import("../../environments/primary")>()),
  usePrimaryEnvironmentId: () => "env-badge",
}));
vi.mock("../../environments/runtime", () => ({
  listEnvironmentConnections: () => [{ environmentId: "env-badge" }],
  readEnvironmentConnection: () => ({ client: device.client }),
  subscribeEnvironmentConnections: () => () => {},
  useSavedEnvironmentRuntimeStore: <T,>(selector: (state: { byId: object }) => T) =>
    selector({ byId: {} }),
}));
vi.mock("../../environmentApi", () => ({
  readEnvironmentApiForConnection: () => ({
    agentControl: { subscribeProposals: device.subscribeProposals },
  }),
}));

import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { useWaitingAutomationRuns } from "./useWaitingAutomationRuns";

const ENV = EnvironmentId.make("env-badge");

function setAgentControlEnabled(enabled: boolean) {
  appAtomRegistry.set(serverConfigAtom, {
    environment: { environmentId: ENV },
    settings: { agentControl: { enabled } },
  } as unknown as ServerConfig);
}

function Badge() {
  return <p>{useWaitingAutomationRuns()}</p>;
}

afterEach(() => {
  appAtomRegistry.set(serverConfigAtom, null);
  device.subscribeProposals.mockClear();
});

describe("useWaitingAutomationRuns", () => {
  it("holds no queue subscription while the device's Agent Control is off, and opens one when it is turned on", async () => {
    setAgentControlEnabled(false);
    const screen = await render(
      <AppAtomRegistryProvider>
        <Badge />
      </AppAtomRegistryProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(device.subscribeProposals).not.toHaveBeenCalled();

    setAgentControlEnabled(true);
    await expect.poll(() => device.subscribeProposals.mock.calls.length).toBe(1);
    await screen.unmount();
  });
});
