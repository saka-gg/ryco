import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import {
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type HTMLAttributes,
} from "react";
import {
  EnvironmentId,
  ProviderInstanceId,
  type AcpRegistryAgent,
  type AcpRegistryAuthMethod,
} from "@ryco/contracts";
import { SettingsTargetProvider, type SettingsTarget } from "../../settingsTarget";

const harness = vi.hoisted(() => ({
  allowed: true,
  kind: "stale" as "stale" | "establishing",
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
    kind: harness.allowed ? "ready" : harness.kind,
    reason: harness.allowed ? null : "Read-only access",
  }),
}));
vi.mock("../../hostedHub/switchTarget", () => ({
  hostedCapabilityCopy: (
    capability: { kind?: string; reason: string | null },
    label: string | null | undefined,
  ) =>
    capability.kind === "establishing"
      ? `Available when ${label || "this node"} is connected`
      : capability.reason,
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
  harness.kind = "stale";
  harness.servers.clear();
  harness.localApi.mockClear();
});

function registry(node: SettingsTarget, onChange = vi.fn()) {
  return (
    <SettingsTargetProvider value={node}>
      <AcpRegistrySettings value={{}} onChange={onChange} variant="card" />
    </SettingsTargetProvider>
  );
}
/**
 * The config lives with the owner and every change is applied at once, as in the add dialog or on
 * the primary node, whose settings writes are optimistic.
 */
function SourceHarness(props: {
  readonly initial: Record<string, unknown>;
  readonly onChange: (config: Record<string, unknown>) => void;
  readonly variant: "card" | "dialog";
}) {
  const [value, setValue] = useState<Record<string, unknown>>(props.initial);
  return (
    <AcpRegistrySettings
      value={value}
      variant={props.variant}
      onChange={(config) => {
        props.onChange(config);
        setValue(config);
      }}
    />
  );
}
function source(
  node: SettingsTarget,
  options: {
    readonly initial?: Record<string, unknown>;
    readonly onChange?: (config: Record<string, unknown>) => void;
    readonly variant?: "card" | "dialog";
  } = {},
) {
  return (
    <SettingsTargetProvider value={node}>
      <SourceHarness
        initial={options.initial ?? {}}
        onChange={options.onChange ?? vi.fn()}
        variant={options.variant ?? "dialog"}
      />
    </SettingsTargetProvider>
  );
}
/** A card on a remote node: the config changes only when the test delivers the node's echo. */
function remoteCard(
  node: SettingsTarget,
  value: Record<string, unknown>,
  onChange: (config: Record<string, unknown>) => void,
) {
  return (
    <SettingsTargetProvider value={node}>
      <AcpRegistrySettings value={value} onChange={onChange} variant="card" />
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
    await expect.element(mounted.getByRole("alert")).toMatchTextContent("Checksum mismatch");
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

  it("says when the target node will be available while its connection is being set up", async () => {
    harness.allowed = false;
    harness.kind = "establishing";
    harness.servers.set("node-a", server());
    const node = target("node-a");
    const mounted = await render(
      <>
        {registry(node)}
        {authentication(node)}
      </>,
    );
    const copy = mounted.getByText("Available when node-a is connected", { exact: true });
    await vi.waitFor(() => expect(copy.elements()).toHaveLength(2));
    expect(mounted.getByText("Read-only access", { exact: true }).elements()).toHaveLength(0);
  });

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
    await expect
      .element(mounted.getByRole("status"))
      .toMatchTextContent("Authentication completed");
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
    await expect.element(mounted.getByRole("alert")).toMatchTextContent("Reconnect to this node");
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

describe("local ACP command settings", () => {
  it("switches a new instance to a local command and stops browsing the registry", async () => {
    const selected = server();
    harness.servers.set("node-a", selected);
    const onChange = vi.fn();
    const mounted = await render(source(target("node-a"), { onChange }));
    await expect
      .element(mounted.getByRole("textbox", { name: "Search ACP registry" }))
      .toBeVisible();
    await mounted.getByRole("button", { name: "Local command" }).click();
    expect(onChange).toHaveBeenLastCalledWith({ source: "local", command: "", args: [] });
    await expect.element(mounted.getByRole("textbox", { name: "Executable" })).toBeVisible();
    await expect
      .element(mounted.getByRole("textbox", { name: "Search ACP registry" }))
      .not.toBeInTheDocument();
    await expect
      .element(mounted.getByText("Ryco starts this command on node-a", { exact: false }))
      .toBeVisible();
    const searches = selected.searchAcpRegistry.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(selected.searchAcpRegistry).toHaveBeenCalledTimes(searches);
    await mounted.getByRole("button", { name: "Registry agent" }).click();
    expect(onChange).toHaveBeenLastCalledWith({});
    await expect
      .element(mounted.getByRole("textbox", { name: "Search ACP registry" }))
      .toBeVisible();
  });

  it("publishes each edit in the add dialog without waiting for blur", async () => {
    const selected = server();
    harness.servers.set("node-a", selected);
    const onChange = vi.fn();
    const mounted = await render(
      source(target("node-a"), { initial: { source: "local", command: "", args: [] }, onChange }),
    );
    const executable = mounted.getByRole("textbox", { name: "Executable" });
    // Typed key by key: the field keeps the space inside the path while the config is trimmed.
    await userEvent.type(executable, " /opt/my agent ");
    await expect.element(executable).toHaveFocus();
    await expect.element(executable).toHaveValue(" /opt/my agent ");
    expect(onChange).toHaveBeenLastCalledWith({
      source: "local",
      command: "/opt/my agent",
      args: [],
    });
    await executable.fill("./gemini");
    await expect
      .element(mounted.getByText("Use an absolute path or a command name on PATH."))
      .toBeVisible();
    await expect.element(executable).toHaveFocus();
    await executable.fill("gemini");
    expect(onChange).toHaveBeenLastCalledWith({ source: "local", command: "gemini", args: [] });
    await mounted.getByRole("button", { name: "Add argument" }).click();
    await mounted.getByRole("button", { name: "Add argument" }).click();
    await mounted.getByRole("button", { name: "Add argument" }).click();
    await mounted.getByRole("textbox", { name: "Argument 1" }).fill("--acp");
    await mounted.getByRole("textbox", { name: "Argument 2" }).fill(" literal $(x) ; ");
    expect(onChange).toHaveBeenLastCalledWith({
      source: "local",
      command: "gemini",
      args: ["--acp", " literal $(x) ; ", ""],
    });
    await mounted.getByRole("button", { name: "Remove argument 1" }).click();
    expect(onChange).toHaveBeenLastCalledWith({
      source: "local",
      command: "gemini",
      args: [" literal $(x) ; ", ""],
    });
    await expect
      .element(mounted.getByRole("textbox", { name: "Argument 1" }))
      .toHaveValue(" literal $(x) ; ");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(selected.searchAcpRegistry).not.toHaveBeenCalled();
    expect(selected.installAcpRegistry).not.toHaveBeenCalled();
  });

  it("saves a card's fields on Enter and keeps the instance's other settings", async () => {
    harness.servers.set("node-a", server());
    const onChange = vi.fn();
    const mounted = await render(
      source(target("node-a"), {
        initial: {
          source: "local",
          command: "/opt/agent",
          args: ["--acp"],
          customModels: ["fast", "deep"],
        },
        onChange,
        variant: "card",
      }),
    );
    // Every saved change rebuilds the instance on the node, so typing alone saves nothing.
    await mounted.getByRole("textbox", { name: "Argument 1" }).fill("--stdio");
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith({
      source: "local",
      command: "/opt/agent",
      args: ["--stdio"],
      customModels: ["fast", "deep"],
    });
    await mounted.getByRole("textbox", { name: "Executable" }).fill("  gemini  ");
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith({
      source: "local",
      command: "gemini",
      args: ["--stdio"],
      customModels: ["fast", "deep"],
    });
    await expect
      .element(mounted.getByRole("textbox", { name: "Executable" }))
      .toHaveValue("gemini");
    await mounted.getByRole("button", { name: "Add argument" }).click();
    expect(onChange).toHaveBeenLastCalledWith({
      source: "local",
      command: "gemini",
      args: ["--stdio", ""],
      customModels: ["fast", "deep"],
    });
  });

  it("builds on edits a remote node has not echoed yet", async () => {
    harness.servers.set("node-a", server());
    const onChange = vi.fn<(config: Record<string, unknown>) => void>();
    const saved = { source: "local", command: "/opt/agent", args: [], customModels: ["fast"] };
    const node = target("node-a");
    const mounted = await render(remoteCard(node, saved, onChange));
    const published = () => onChange.mock.calls.map(([config]) => config);

    await mounted.getByRole("button", { name: "Add argument" }).click();
    await mounted.getByRole("textbox", { name: "Argument 1" }).fill("--acp");
    await userEvent.keyboard("{Enter}");
    expect(published()).toHaveLength(2);
    // The echo of the first edit arrives after the second was made.
    await mounted.rerender(remoteCard(node, published()[0]!, onChange));
    await expect.element(mounted.getByRole("textbox", { name: "Argument 1" })).toHaveValue("--acp");
    await mounted.getByRole("button", { name: "Add argument" }).click();
    expect(onChange).toHaveBeenLastCalledWith({
      ...saved,
      args: ["--acp", ""],
    });
    await mounted.rerender(remoteCard(node, published()[1]!, onChange));
    await mounted.rerender(remoteCard(node, published()[2]!, onChange));
    await expect.element(mounted.getByRole("textbox", { name: "Argument 1" })).toHaveValue("--acp");
    await expect.element(mounted.getByRole("textbox", { name: "Argument 2" })).toHaveValue("");
    // A repeated report of the saved command is not mistaken for someone else's change.
    await mounted.rerender(remoteCard(node, { ...published()[2]! }, onChange));
    await expect.element(mounted.getByRole("textbox", { name: "Argument 2" })).toBeVisible();
    expect(published()).toHaveLength(3);

    // A change made elsewhere replaces the fields.
    await mounted.rerender(remoteCard(node, { ...saved, args: ["--other"] }, onChange));
    await expect
      .element(mounted.getByRole("textbox", { name: "Argument 1" }))
      .toHaveValue("--other");
    await expect
      .element(mounted.getByRole("textbox", { name: "Argument 2" }))
      .not.toBeInTheDocument();
    expect(published()).toHaveLength(3);
  });

  it("waits for both echoes when an edit returns to the saved command", async () => {
    harness.servers.set("node-a", server());
    const onChange = vi.fn<(config: Record<string, unknown>) => void>();
    const saved = { source: "local", command: "/opt/agent", args: ["--acp"] };
    const node = target("node-a");
    const mounted = await render(remoteCard(node, saved, onChange));
    const argument = mounted.getByRole("textbox", { name: "Argument 1" });
    const published = () => onChange.mock.calls.map(([config]) => config);

    await argument.fill("--stdio");
    await userEvent.keyboard("{Enter}");
    await argument.fill("--acp");
    await userEvent.keyboard("{Enter}");
    expect(published().map((config) => config.args)).toEqual([["--stdio"], ["--acp"]]);
    // A re-render with the saved command is not the echo of the second edit.
    await mounted.rerender(remoteCard(node, { ...saved }, onChange));
    await mounted.rerender(remoteCard(node, published()[0]!, onChange));
    await expect.element(argument).toHaveValue("--acp");
    await mounted.rerender(remoteCard(node, published()[1]!, onChange));
    await expect.element(argument).toHaveValue("--acp");
    expect(published()).toHaveLength(2);
  });

  it("keeps the source fixed on a saved instance", async () => {
    harness.servers.set("node-a", server());
    const mounted = await render(
      source(target("node-a"), {
        initial: { source: "local", command: "/opt/agent", args: ["--acp"] },
        variant: "card",
      }),
    );
    await expect
      .element(mounted.getByRole("textbox", { name: "Executable" }))
      .toHaveValue("/opt/agent");
    await expect.element(mounted.getByRole("textbox", { name: "Argument 1" })).toHaveValue("--acp");
    await expect
      .element(mounted.getByRole("button", { name: "Local command" }))
      .not.toBeInTheDocument();
    await expect
      .element(mounted.getByRole("button", { name: "Registry agent" }))
      .not.toBeInTheDocument();
  });

  it.each([
    { allowed: false, patch: {} },
    { allowed: true, patch: { canManage: false } },
    { allowed: true, patch: { canMutate: false } },
    { allowed: true, patch: { connected: false } },
  ])("disables editing for $patch / allowed=$allowed", async ({ allowed, patch }) => {
    harness.allowed = allowed;
    harness.servers.set("node-a", server());
    const onChange = vi.fn();
    const mounted = await render(
      source(target("node-a", patch), {
        initial: { source: "local", command: "/opt/agent", args: ["--acp"] },
        onChange,
        variant: "card",
      }),
    );
    await expect.element(mounted.getByRole("textbox", { name: "Executable" })).toBeDisabled();
    await expect.element(mounted.getByRole("textbox", { name: "Argument 1" })).toBeDisabled();
    await expect.element(mounted.getByRole("button", { name: "Add argument" })).toBeDisabled();
    await expect.element(mounted.getByRole("button", { name: "Remove argument 1" })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("says that checking authentication starts the configured command", async () => {
    harness.servers.set("node-a", server());
    const mounted = await render(
      <SettingsTargetProvider value={target("node-a")}>
        <AcpRegistryAuthentication instanceId={instanceId} installationKey="local" source="local" />
      </SettingsTargetProvider>,
    );
    await expect
      .element(mounted.getByText("Check starts the configured command", { exact: false }))
      .toBeVisible();
  });
});
