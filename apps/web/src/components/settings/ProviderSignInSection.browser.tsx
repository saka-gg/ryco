import "../../index.css";

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSignInRespondInput,
  type ProviderSignInState,
  type ProviderSignInWireEvent,
  type ServerProvider,
} from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { ProviderSignInSection, type ProviderSignInSectionProps } from "./ProviderSignInSection";

type FailureKind = "unsupported" | "response-too-large" | "failed";

interface FakeSubscription {
  readonly listener: (event: ProviderSignInWireEvent) => void;
  readonly options: {
    readonly onError?: (kind?: FailureKind) => void;
    readonly classifyFailure?: (error: unknown) => FailureKind;
  };
  active: boolean;
}

const harness = vi.hoisted(() => ({
  /** The `providerSignIn` namespace of each node's connection. */
  apis: new Map<string, unknown>(),
}));

// Only the node connection's sign-in methods are read; nothing here connects.
vi.mock("../../environments/runtime", () => ({
  getEnvironmentHttpBaseUrl: () => "http://localhost:3000",
  getSavedEnvironmentRecord: () => null,
  getSavedEnvironmentRuntimeState: () => null,
  hasSavedEnvironmentRegistryHydrated: () => true,
  listSavedEnvironmentRecords: () => [],
  listEnvironmentConnections: () => [],
  resetSavedEnvironmentRegistryStoreForTests: () => undefined,
  resetSavedEnvironmentRuntimeStoreForTests: () => undefined,
  resolveEnvironmentHttpUrl: (_environmentId: unknown, path: string) =>
    new URL(path, "http://localhost:3000").toString(),
  waitForSavedEnvironmentRegistryHydration: async () => undefined,
  addSavedEnvironment: vi.fn(),
  connectPrimaryEnvironment: vi.fn(),
  connectDesktopWorkspaceEnvironment: vi.fn(),
  connectDesktopSshEnvironment: vi.fn(),
  disconnectPrimaryEnvironment: vi.fn(),
  disconnectSavedEnvironment: vi.fn(),
  ensureEnvironmentConnectionBootstrapped: async () => undefined,
  getPrimaryEnvironmentConnection: () => null,
  readEnvironmentConnection: (environmentId: string) => {
    const providerSignIn = harness.apis.get(environmentId);
    return providerSignIn ? { client: { providerSignIn } } : null;
  },
  reconnectSavedEnvironment: vi.fn(),
  removeSavedEnvironment: vi.fn(),
  requireEnvironmentConnection: vi.fn(),
  resetEnvironmentServiceForTests: () => undefined,
  startEnvironmentConnectionService: () => undefined,
  subscribeEnvironmentConnections: () => () => {},
  updateEnvironmentServerSettings: vi.fn(),
  useSavedEnvironmentRegistryStore: (
    selector: (state: { byId: Record<string, never> }) => unknown,
  ) => selector({ byId: {} }),
  useSavedEnvironmentRuntimeStore: (
    selector: (state: { byId: Record<string, never> }) => unknown,
  ) => selector({ byId: {} }),
}));

const INSTANCE = ProviderInstanceId.make("codex");
let nodeCount = 0;

/** A node with its own sign-in methods; each test gets a fresh one. */
function fakeNode() {
  nodeCount += 1;
  const environmentId = EnvironmentId.make(`env-sign-in-${nodeCount}`);
  const subscriptions: FakeSubscription[] = [];
  const respondCalls: ProviderSignInRespondInput[] = [];
  const start = vi.fn(async (): Promise<ProviderSignInState> =>
    state({ phase: "starting", flowId: "flow-1" }),
  );
  harness.apis.set(environmentId, {
    subscribe: (
      _input: unknown,
      listener: FakeSubscription["listener"],
      options: FakeSubscription["options"] = {},
    ) => {
      const subscription: FakeSubscription = { listener, options, active: true };
      subscriptions.push(subscription);
      return () => {
        subscription.active = false;
      };
    },
    start,
    respond: async (input: ProviderSignInRespondInput) => {
      respondCalls.push(input);
    },
  });
  const latest = () => subscriptions.at(-1);
  return {
    environmentId,
    start,
    subscriptions,
    respondCalls,
    emit: (next: ProviderSignInState) => latest()?.listener({ type: "state", state: next }),
    fail: (error: unknown) => {
      const subscription = latest()!;
      subscription.active = false;
      subscription.options.onError?.(subscription.options.classifyFailure?.(error));
    },
  };
}

function state(patch: Partial<ProviderSignInState> = {}): ProviderSignInState {
  return {
    instanceId: INSTANCE,
    phase: "idle",
    flowId: null,
    method: "codexDeviceCode",
    unavailableReason: null,
    interaction: null,
    expiresAt: null,
    message: null,
    ...patch,
  };
}

function provider(auth: ServerProvider["auth"]): ServerProvider {
  return {
    instanceId: INSTANCE,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "0.130.0",
    status: auth.status === "authenticated" ? "ready" : "warning",
    auth,
    checkedAt: "2026-10-28T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  } as ServerProvider;
}

const SIGNED_OUT = provider({ status: "unauthenticated" });
const VERIFICATION_URL = "https://auth.openai.com/codex/device";

function sectionProps(
  environmentId: EnvironmentId,
  patch: Partial<ProviderSignInSectionProps> = {},
): ProviderSignInSectionProps {
  return {
    environmentId,
    nodeLabel: "Studio",
    connected: true,
    instanceId: INSTANCE,
    instanceEnabled: true,
    displayName: "Codex",
    provider: SIGNED_OUT,
    ...patch,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  harness.apis.clear();
  vi.restoreAllMocks();
});

describe("ProviderSignInSection", () => {
  it("stays hidden and follows nothing while the instance reports a sign-in", async () => {
    const node = fakeNode();
    const screen = await render(
      <ProviderSignInSection
        {...sectionProps(node.environmentId, {
          provider: provider({ status: "authenticated", email: "a@example.com" }),
        })}
      />,
    );
    expect(screen.container.querySelector("section")).toBeNull();
    expect(node.subscriptions).toHaveLength(0);
  });

  it("signs in with a device code: code, copy, open, countdown and cancel", async () => {
    const node = fakeNode();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const screen = await render(<ProviderSignInSection {...sectionProps(node.environmentId)} />);
    const section = page.getByRole("region", { name: "Sign in to Codex" });
    await expect.element(section).toBeVisible();
    expect(section.element().className).toContain("phone:hidden");
    expect(node.subscriptions).toHaveLength(1);

    node.emit(state());
    await expect
      .element(page.getByText("Runs Codex’s sign-in on Studio. The page opens on this device."))
      .toBeVisible();
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    expect(node.start).toHaveBeenCalledWith({ instanceId: INSTANCE });
    await expect.element(page.getByText("Starting the sign-in on Studio…")).toBeVisible();

    node.emit(
      state({
        phase: "waiting",
        flowId: "flow-1",
        interaction: {
          type: "deviceCode",
          verificationUrl: VERIFICATION_URL,
          userCode: "ABCD-1234",
        },
        expiresAt: new Date(Date.now() + 90_500).toISOString(),
      }),
    );
    await expect.element(page.getByLabelText("Sign-in code")).toHaveTextContent("ABCD-1234");
    await expect.element(page.getByText(VERIFICATION_URL)).toBeVisible();
    await expect.element(page.getByText(/Expires in 1:[23]\d/u)).toBeVisible();

    await page.getByRole("button", { name: "Copy" }).click();
    expect(writeText).toHaveBeenCalledWith("ABCD-1234");
    await expect.element(page.getByRole("button", { name: "Copied" })).toBeVisible();

    await page.getByRole("button", { name: "Open sign-in page" }).click();
    expect(open).toHaveBeenCalledWith(VERIFICATION_URL, "_blank", "noopener,noreferrer");

    await page.getByRole("button", { name: "Cancel" }).click();
    expect(node.respondCalls).toEqual([
      { instanceId: INSTANCE, flowId: "flow-1", action: { type: "cancel" } },
    ]);
    node.emit(state({ phase: "cancelled", flowId: "flow-1", message: "Sign-in cancelled." }));
    await expect.element(page.getByText("Sign-in cancelled.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Try again" })).toBeEnabled();
    screen.unmount();
  });

  it("names the instance inline, where no card around it does", async () => {
    const node = fakeNode();
    const screen = await render(
      <ProviderSignInSection
        {...sectionProps(node.environmentId, { variant: "inline", displayName: "Codex Work" })}
      />,
    );
    const section = page.getByRole("region", { name: "Sign in to Codex Work" });
    await expect.element(section).toBeVisible();
    expect(section.element().className).not.toContain("border-t");
    await expect.element(page.getByText("Sign in to Codex Work", { exact: true })).toBeVisible();
    expect(page.getByText("Account sign-in").query()).toBeNull();
    screen.unmount();
  });

  it("offers no page to open for an address that is not https", async () => {
    const node = fakeNode();
    await render(<ProviderSignInSection {...sectionProps(node.environmentId)} />);
    node.emit(
      state({
        phase: "waiting",
        flowId: "flow-1",
        interaction: {
          type: "deviceCode",
          verificationUrl: "http://example.com/device",
          userCode: "WXYZ",
        },
      }),
    );
    await expect.element(page.getByLabelText("Sign-in code")).toHaveTextContent("WXYZ");
    expect(page.getByRole("button", { name: "Open sign-in page" }).query()).toBeNull();
  });

  it("keeps the outcome visible once the instance signs in, with its email blurred", async () => {
    const node = fakeNode();
    const states: string[] = [];
    const props = sectionProps(node.environmentId, {
      onStateChange: (next) => states.push(next.phase),
    });
    const screen = await render(<ProviderSignInSection {...props} />);
    node.emit(state({ phase: "verifying", flowId: "flow-1" }));
    await expect.element(page.getByText("Checking the account…")).toBeVisible();

    const signedIn = provider({ status: "authenticated", email: "person@example.com" });
    await screen.rerender(<ProviderSignInSection {...props} provider={signedIn} />);
    node.emit(
      state({ phase: "succeeded", flowId: "flow-1", message: "Signed in as person@example.com." }),
    );
    await expect.element(page.getByText(/Signed in as/u)).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Toggle account email visibility" }))
      .not.toHaveTextContent("person@example.com");
    expect(states).toEqual(["verifying", "succeeded"]);

    node.emit(state());
    await flush();
    expect(screen.container.querySelector("section")).toBeNull();
  });

  it("asks to update an older node, without an error", async () => {
    const node = fakeNode();
    await render(<ProviderSignInSection {...sectionProps(node.environmentId)} />);
    node.fail(new Error('Unknown request tag "provider.signIn.subscribe"'));
    await expect
      .element(page.getByText("Update Ryco on Studio to sign in from here."))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
    expect(page.getByRole("alert").query()).toBeNull();
  });

  it("shows why the node cannot sign the instance in, and why a start failed", async () => {
    const node = fakeNode();
    await render(<ProviderSignInSection {...sectionProps(node.environmentId)} />);
    node.emit(state({ method: null, unavailableReason: "Fix this Codex instance's settings." }));
    await expect.element(page.getByText("Fix this Codex instance's settings.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();

    node.emit(state());
    node.start.mockRejectedValueOnce({
      _tag: "ProviderSignInError",
      message: "Another sign-in for this account store is running.",
    });
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Another sign-in for this account store is running.");
  });

  it("says a sign-in was interrupted when the node dropped it while the connection was gone", async () => {
    const node = fakeNode();
    const screen = await render(<ProviderSignInSection {...sectionProps(node.environmentId)} />);
    node.emit(
      state({
        phase: "waiting",
        flowId: "flow-1",
        interaction: { type: "deviceCode", verificationUrl: VERIFICATION_URL, userCode: "ABCD" },
      }),
    );
    await expect.element(page.getByLabelText("Sign-in code")).toHaveTextContent("ABCD");

    await screen.rerender(
      <ProviderSignInSection {...sectionProps(node.environmentId, { connected: false })} />,
    );
    await expect.element(page.getByText("Available when Studio is connected")).toBeVisible();
    await flush();
    expect(node.subscriptions.at(-1)?.active).toBe(false);

    await screen.rerender(<ProviderSignInSection {...sectionProps(node.environmentId)} />);
    expect(node.subscriptions).toHaveLength(2);
    // The node restarted meanwhile, which ends every flow without a word.
    node.emit(state());
    await expect.element(page.getByText(/^Sign-in was interrupted\. Start again\./u)).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  });

  it("offers to try again when the node could not be followed before it reported", async () => {
    const node = fakeNode();
    await render(<ProviderSignInSection {...sectionProps(node.environmentId)} />);
    node.fail({ _tag: "ProviderSignInError", message: "Sign-in is unavailable on this node." });
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Sign-in is unavailable on this node.");
    expect(page.getByText("Checking sign-in on Studio…").query()).toBeNull();

    await page.getByRole("button", { name: "Try again" }).click();
    expect(node.subscriptions).toHaveLength(2);
    await expect.element(page.getByText("Checking sign-in on Studio…")).toBeVisible();
    expect(page.getByRole("alert").query()).toBeNull();
    node.emit(state());
    await expect.element(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
    expect(node.start).not.toHaveBeenCalled();
  });

  it("waits for the node's connection and for an enabled instance", async () => {
    const node = fakeNode();
    const screen = await render(
      <ProviderSignInSection {...sectionProps(node.environmentId, { connected: false })} />,
    );
    await expect.element(page.getByText("Available when Studio is connected")).toBeVisible();
    expect(node.subscriptions).toHaveLength(0);

    await screen.rerender(
      <ProviderSignInSection {...sectionProps(node.environmentId, { instanceEnabled: false })} />,
    );
    node.emit(state());
    await expect.element(page.getByText("Enable this provider instance to sign in.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
  });
});
