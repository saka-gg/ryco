import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, HTMLAttributes } from "react";
import {
  EnvironmentId,
  ProviderInstanceId,
  type AcpRegistryAgent,
  type AcpRegistryAuthMethod,
} from "@ryco/contracts";
import { SettingsTargetProvider, type SettingsTarget } from "../../settingsTarget";

const harness = vi.hoisted(() => ({
  allowed: true,
  servers: new Map<string, unknown>(),
  localApi: vi.fn(() => {
    throw new Error("Unexpected primary-node fallback");
  }),
}));
vi.mock("../../environmentApi", () => ({
  readEnvironmentApi: (id: string) => {
    const server = harness.servers.get(id);
    return server ? { server } : undefined;
  },
}));
vi.mock("../../localApi", () => ({
  ensureLocalApi: harness.localApi,
}));
vi.mock("../../hostedHub/capabilities", () => ({
  useHostedRpcCapability: () => ({
    allowed: harness.allowed,
    reason: harness.allowed ? null : "Read-only access",
  }),
}));

// Keep RPC tests focused on the registry components; shared design controls have their own tests.
vi.mock("../ui/button", () => ({
  Button: ({
    size: _size,
    variant: _variant,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => (
    <button {...props} />
  ),
}));
vi.mock("../ui/input", () => ({
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));
vi.mock("../ui/badge", () => ({
  Badge: ({
    size: _size,
    variant: _variant,
    ...props
  }: HTMLAttributes<HTMLSpanElement> & { size?: string; variant?: string }) => <span {...props} />,
}));

import { AcpRegistrySettings } from "./AcpRegistrySettings";
import { AcpRegistryAuthentication } from "./AcpRegistryAuthentication";

const agent: AcpRegistryAgent = {
  id: "example-agent",
  version: "1.2.3",
  name: "Example agent",
  description: "Registry agent",
  installed: false,
  installable: true,
};
const instanceId = ProviderInstanceId.make("acpRegistry_work");
function target(id: string, patch: Partial<SettingsTarget> = {}): SettingsTarget {
  return {
    environmentId: EnvironmentId.make(id),
    nodeLabel: id,
    serverConfig: null,
    primary: false,
    connected: true,
    canManage: true,
    canMutate: true,
    ...patch,
  };
}
function server() {
  return {
    searchAcpRegistry: vi.fn(async () => ({ agents: [agent] })),
    installAcpRegistry: vi.fn(async () => ({
      agentId: agent.id,
      version: agent.version,
      sha256: "abc",
    })),
    getAcpRegistryAuthMethods: vi.fn(async (): Promise<ReadonlyArray<AcpRegistryAuthMethod>> => [
      { id: "browser", name: "Browser login" },
    ]),
    authenticateAcpRegistry: vi.fn(async () => ({ authenticated: true })),
  };
}
function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  harness.allowed = true;
  harness.servers.clear();
  harness.localApi.mockClear();
});

function registry(node: SettingsTarget, onChange = vi.fn()) {
  return (
    <SettingsTargetProvider value={node}>
      <AcpRegistrySettings value={{}} onChange={onChange} />
    </SettingsTargetProvider>
  );
}
function authentication(node: SettingsTarget) {
  return (
    <SettingsTargetProvider value={node}>
      <AcpRegistryAuthentication instanceId={instanceId} installationKey="example-agent@1.2.3" />
    </SettingsTargetProvider>
  );
}

describe("ACP registry settings boundaries", () => {
  it("searches the selected node and saves only after explicit pinned installation succeeds", async () => {
    const selected = server();
    const pending = deferred<{ agentId: string; version: string; sha256: string }>();
    selected.installAcpRegistry.mockReturnValue(pending.promise);
    harness.servers.set("node-a", selected);
    const onChange = vi.fn();
    const mounted = await render(registry(target("node-a"), onChange));
    await expect.element(mounted.getByRole("button", { name: "Install 1.2.3" })).toBeVisible();
    expect(selected.installAcpRegistry).not.toHaveBeenCalled();
    await mounted.getByRole("textbox", { name: "Search ACP registry" }).fill("Example");
    await vi.waitFor(() =>
      expect(selected.searchAcpRegistry).toHaveBeenLastCalledWith({ query: "Example" }),
    );
    await mounted.getByRole("button", { name: "Install 1.2.3" }).click();
    expect(selected.installAcpRegistry).toHaveBeenCalledExactlyOnceWith({
      agentId: agent.id,
      version: "1.2.3",
    });
    expect(onChange).not.toHaveBeenCalled();
    pending.resolve({ agentId: agent.id, version: "1.2.3", sha256: "verified" });
    await vi.waitFor(() =>
      expect(onChange).toHaveBeenCalledExactlyOnceWith({ agentId: agent.id, version: "1.2.3" }),
    );
    expect(harness.localApi).not.toHaveBeenCalled();
  });

  it("keeps configuration unchanged when checksum verification rejects installation", async () => {
    const selected = server();
    selected.installAcpRegistry.mockRejectedValue(new Error("Checksum mismatch"));
    harness.servers.set("node-a", selected);
    const onChange = vi.fn();
    const mounted = await render(registry(target("node-a"), onChange));
    await mounted.getByRole("button", { name: "Install 1.2.3" }).click();
    await expect.element(mounted.getByRole("alert")).toHaveTextContent("Checksum mismatch");
    expect(onChange).not.toHaveBeenCalled();
    await expect.element(mounted.getByRole("button", { name: "Install 1.2.3" })).toBeEnabled();
  });

  it("discards registry responses from the previously selected node", async () => {
    const first = server();
    const second = server();
    const pending = deferred<{ agents: AcpRegistryAgent[] }>();
    first.searchAcpRegistry.mockReturnValue(pending.promise);
    second.searchAcpRegistry.mockResolvedValue({
      agents: [{ ...agent, name: "Current node agent" }],
    });
    harness.servers.set("node-a", first);
    harness.servers.set("node-b", second);
    const mounted = await render(registry(target("node-a")));
    await vi.waitFor(() => expect(first.searchAcpRegistry).toHaveBeenCalledOnce());
    await mounted.rerender(registry(target("node-b")));
    await expect.element(mounted.getByText("Current node agent", { exact: true })).toBeVisible();
    pending.resolve({ agents: [{ ...agent, name: "Stale agent" }] });
    await pending.promise;
    await expect.element(mounted.getByText("Stale agent", { exact: true })).not.toBeInTheDocument();
    await expect.element(mounted.getByText("Current node agent", { exact: true })).toBeVisible();
  });

  it("does not save an installation completed after switching nodes", async () => {
    const first = server();
    const second = server();
    const pending = deferred<{ agentId: string; version: string; sha256: string }>();
    first.installAcpRegistry.mockReturnValue(pending.promise);
    harness.servers.set("node-a", first);
    harness.servers.set("node-b", second);
    const onChange = vi.fn();
    const mounted = await render(registry(target("node-a"), onChange));
    await mounted.getByRole("button", { name: "Install 1.2.3" }).click();
    await mounted.rerender(registry(target("node-b"), onChange));
    pending.resolve({ agentId: agent.id, version: "1.2.3", sha256: "verified" });
    await pending.promise;
    await vi.waitFor(() => expect(second.searchAcpRegistry).toHaveBeenCalledOnce());
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([
    { allowed: false, patch: {} },
    { allowed: true, patch: { canManage: false } },
    { allowed: true, patch: { canMutate: false } },
    { allowed: true, patch: { connected: false } },
  ])(
    "gates installation and authentication for $patch / allowed=$allowed",
    async ({ allowed, patch }) => {
      harness.allowed = allowed;
      const selected = server();
      harness.servers.set("node-a", selected);
      const node = target("node-a", patch);
      const mounted = await render(
        <>
          {registry(node)}
          {authentication(node)}
        </>,
      );
      await expect.element(mounted.getByRole("button", { name: "Install 1.2.3" })).toBeDisabled();
      await expect
        .element(mounted.getByRole("button", { name: "Check authentication methods" }))
        .toBeDisabled();
      expect(selected.installAcpRegistry).not.toHaveBeenCalled();
      expect(selected.getAcpRegistryAuthMethods).not.toHaveBeenCalled();
      expect(selected.authenticateAcpRegistry).not.toHaveBeenCalled();
    },
  );

  it("negotiates authentication explicitly on the selected node", async () => {
    const selected = server();
    harness.servers.set("node-a", selected);
    const mounted = await render(authentication(target("node-a")));
    expect(selected.getAcpRegistryAuthMethods).not.toHaveBeenCalled();
    await mounted.getByRole("button", { name: "Check authentication methods" }).click();
    expect(selected.getAcpRegistryAuthMethods).toHaveBeenCalledExactlyOnceWith({ instanceId });
    await expect.element(mounted.getByText("Browser login", { exact: true })).toBeVisible();
    expect(selected.authenticateAcpRegistry).not.toHaveBeenCalled();
    await mounted.getByRole("button", { name: "Sign in" }).click();
    expect(selected.authenticateAcpRegistry).toHaveBeenCalledExactlyOnceWith({
      instanceId,
      methodId: "browser",
    });
    await expect.element(mounted.getByRole("status")).toHaveTextContent("Authentication completed");
    expect(harness.localApi).not.toHaveBeenCalled();
  });

  it("discards pending authentication methods after switching the selected node", async () => {
    const first = server();
    const second = server();
    const pending = deferred<{ id: string; name: string }[]>();
    first.getAcpRegistryAuthMethods.mockReturnValue(pending.promise);
    second.getAcpRegistryAuthMethods.mockResolvedValue([{ id: "token", name: "Current sign-in" }]);
    harness.servers.set("node-a", first);
    harness.servers.set("node-b", second);
    const mounted = await render(authentication(target("node-a")));
    await mounted.getByRole("button", { name: "Check authentication methods" }).click();
    await mounted.rerender(authentication(target("node-b")));
    await mounted.getByRole("button", { name: "Check authentication methods" }).click();
    await expect.element(mounted.getByText("Current sign-in", { exact: true })).toBeVisible();
    pending.resolve([{ id: "old", name: "Stale sign-in" }]);
    await pending.promise;
    await expect
      .element(mounted.getByText("Stale sign-in", { exact: true }))
      .not.toBeInTheDocument();
    await expect.element(mounted.getByText("Current sign-in", { exact: true })).toBeVisible();
  });
  it("does not fall back to the primary server when a selected node is unavailable", async () => {
    const onChange = vi.fn();
    const mounted = await render(registry(target("missing-node"), onChange));
    await expect.element(mounted.getByRole("alert")).toHaveTextContent("Reconnect to this node");
    expect(harness.localApi).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not publish successful authentication from the previously selected node", async () => {
    const first = server();
    const second = server();
    const pending = deferred<{ authenticated: boolean }>();
    first.authenticateAcpRegistry.mockReturnValue(pending.promise);
    harness.servers.set("node-a", first);
    harness.servers.set("node-b", second);
    const mounted = await render(authentication(target("node-a")));
    await mounted.getByRole("button", { name: "Check authentication methods" }).click();
    await mounted.getByRole("button", { name: "Sign in" }).click();
    await mounted.rerender(authentication(target("node-b")));
    pending.resolve({ authenticated: true });
    await pending.promise;
    await expect
      .element(mounted.getByRole("button", { name: "Check authentication methods" }))
      .toBeEnabled();
    await expect.element(mounted.getByRole("status")).not.toBeInTheDocument();
    expect(second.authenticateAcpRegistry).not.toHaveBeenCalled();
  });
  it("shows external setup instructions for environment and terminal methods without invoking authenticate", async () => {
    const selected = server();
    selected.getAcpRegistryAuthMethods.mockResolvedValue([
      {
        id: "api-key",
        name: "API key",
        type: "env_var",
        variables: [
          { name: "EXAMPLE_API_KEY", label: "Account API key", optional: false, secret: true },
          { name: "EXAMPLE_ORG", optional: true, secret: false },
        ],
      },
      { id: "cli", name: "CLI login", type: "terminal" },
    ]);
    harness.servers.set("node-a", selected);
    const mounted = await render(authentication(target("node-a")));
    await mounted.getByRole("button", { name: "Check authentication methods" }).click();
    await expect.element(mounted.getByText("EXAMPLE_API_KEY", { exact: true })).toBeVisible();
    await expect.element(mounted.getByText("EXAMPLE_ORG", { exact: true })).toBeVisible();
    await expect
      .element(mounted.getByText("Configure these variables", { exact: false }))
      .toBeVisible();
    await expect
      .element(mounted.getByText("Complete this agent’s sign-in setup", { exact: false }))
      .toBeVisible();
    await expect.element(mounted.getByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
    expect(selected.authenticateAcpRegistry).not.toHaveBeenCalled();
  });
});
