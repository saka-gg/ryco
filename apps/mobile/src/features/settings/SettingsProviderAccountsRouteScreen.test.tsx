import { Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSignInRespondInput,
  type ProviderSignInState,
  type ProviderSignInWireEvent,
  type ServerProvider,
} from "@ryco/contracts";
import { PROVIDER_SIGN_IN_FORBIDDEN } from "@ryco/client-runtime/state/providerSignIn";

// The screen and its sheet, invoked as plain functions with react-native mocked and the hooks
// reduced to what one render reads (no React renderer exists in this suite). The sign-in
// controller is the real shared one, driven through a fake node api.

type FailureKind = "unsupported" | "response-too-large" | "failed";

interface FakeSubscription {
  readonly listener: (event: ProviderSignInWireEvent) => void;
  readonly options: {
    readonly onError?: (kind?: FailureKind) => void;
    readonly classifyFailure?: (error: unknown) => FailureKind;
  };
  active: boolean;
}

const hoisted = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  setState: vi.fn(),
  environments: [] as unknown[],
  configs: new Map<string, unknown>(),
  apis: new Map<string, unknown>(),
  openURL: vi.fn(async (_url: string) => undefined),
  copy: vi.fn(),
  retain: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)) =>
      [typeof initial === "function" ? (initial as () => T)() : initial, hoisted.setState] as const,
    useEffect: (effect: () => void | (() => void)) => {
      hoisted.effects.push(effect);
    },
    useRef: <T,>(initial: T) => ({ current: initial }),
    useSyncExternalStore: <T,>(_subscribe: unknown, read: () => T) => read(),
  };
});
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  KeyboardAvoidingView: "KeyboardAvoidingView",
  Linking: { openURL: hoisted.openURL },
  Modal: "Modal",
  Platform: { OS: "ios" },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
}));
vi.mock("../../components/AppText", () => ({ AppText: "Text", AppTextInput: "TextInput" }));
vi.mock("../../components/ErrorBanner", () => ({ ErrorBanner: "ErrorBanner" }));
vi.mock("./components/SettingsRow", () => ({ SettingsRow: "SettingsRow" }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: "SettingsSection" }));
vi.mock("../home/useHomeEnvironments", () => ({
  useHomeEnvironments: () => hoisted.environments,
}));
vi.mock("../../state/environmentServerConfigs", () => ({
  useEnvironmentServerConfigs: () => hoisted.configs,
}));
vi.mock("../../connection/environmentApi", () => ({
  readRpcClient: (environmentId: string) => {
    const providerSignIn = hoisted.apis.get(environmentId);
    return providerSignIn ? { providerSignIn } : null;
  },
  subscribeEnvironmentApis: () => () => undefined,
}));
vi.mock("../../connection/hostedConnectionScopes", () => ({
  mobileHostedConnectionScopes: { retain: hoisted.retain },
}));
vi.mock("../../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: hoisted.copy }));

import { ProviderSignInSheet, type ProviderSignInTarget } from "./ProviderSignInSheet";
import { SettingsProviderAccountsRouteScreen } from "./SettingsProviderAccountsRouteScreen";

type Props = Record<string, unknown> & { readonly children?: ReactNode };

/** Calls every function component down the tree, leaving the mocked primitives. */
function expand(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(expand);
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<Props>;
  if (typeof element.type === "function") {
    return expand((element.type as (props: Props) => ReactNode)(element.props));
  }
  if ((element.type as unknown) === Fragment) return expand(element.props.children);
  return { ...element, props: { ...element.props, children: expand(element.props.children) } };
}

function elements(node: ReactNode, type?: string): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap((child: ReactNode) => elements(child, type));
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Props>;
  const own = type === undefined || element.type === type ? [element] : [];
  return [...own, ...elements(element.props.children, type)];
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (!isValidElement(node)) return "";
  return textOf((node as ReactElement<Props>).props.children);
}

function button(tree: ReactNode, label: string): Props {
  const found = elements(tree, "Pressable").find(
    (element) => element.props.accessibilityLabel === label,
  );
  if (!found) throw new Error(`No button "${label}"`);
  return found.props;
}

function hasButton(tree: ReactNode, label: string): boolean {
  return elements(tree, "Pressable").some((element) => element.props.accessibilityLabel === label);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const INSTANCE = ProviderInstanceId.make("codex");
const VERIFICATION_URL = "https://auth.openai.com/codex/device";
let nodeCount = 0;
let cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
  hoisted.effects.length = 0;
  hoisted.apis.clear();
  hoisted.configs.clear();
  hoisted.environments = [];
  vi.clearAllMocks();
});

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

function provider(auth: ServerProvider["auth"], patch: Partial<ServerProvider> = {}) {
  return {
    instanceId: INSTANCE,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "0.130.0",
    status: auth.status === "authenticated" ? "ready" : "error",
    auth,
    checkedAt: "2026-10-28T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...patch,
  } as ServerProvider;
}

/** A node with its own sign-in methods; each test gets a fresh one. */
function fakeNode() {
  nodeCount += 1;
  const environmentId = EnvironmentId.make(`env-mobile-sign-in-${nodeCount}`);
  const subscriptions: FakeSubscription[] = [];
  const respondCalls: ProviderSignInRespondInput[] = [];
  const start = vi.fn(async (): Promise<ProviderSignInState> =>
    state({ phase: "starting", flowId: "flow-1" }),
  );
  hoisted.apis.set(environmentId, {
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
  const latest = () => subscriptions.at(-1)!;
  return {
    environmentId,
    start,
    subscriptions,
    respondCalls,
    emit: (event: ProviderSignInWireEvent) => latest().listener(event),
    emitState: (next: ProviderSignInState) => latest().listener({ type: "state", state: next }),
    fail: (error: unknown) => {
      const subscription = latest();
      subscription.active = false;
      subscription.options.onError?.(subscription.options.classifyFailure?.(error));
    },
  };
}

type SheetProps = Parameters<typeof ProviderSignInSheet>[0];

function sheetProps(environmentId: EnvironmentId, patch: Partial<SheetProps> = {}): SheetProps {
  const target: ProviderSignInTarget = {
    environmentId,
    instanceId: INSTANCE,
    nodeLabel: "Studio",
    displayName: "Codex",
  };
  return {
    target,
    provider: provider({ status: "unauthenticated" }),
    instanceEnabled: true,
    access: { allowed: true, reason: null },
    onClose: vi.fn(),
    ...patch,
  };
}

/** One render, without running its effects. */
function render(props: SheetProps): ReactNode {
  const tree = expand(<ProviderSignInSheet {...props} />);
  hoisted.effects.length = 0;
  return tree;
}

/** The first render of a sheet, with its effects run as a mount runs them. */
function mount(props: SheetProps): ReactNode {
  hoisted.effects.length = 0;
  const tree = expand(<ProviderSignInSheet {...props} />);
  const effects = hoisted.effects.splice(0);
  for (const effect of effects) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }
  return tree;
}

function unmount() {
  for (const cleanup of cleanups.splice(0)) cleanup();
}

describe("Provider accounts", () => {
  it("lists each connected node's instances with their accounts", () => {
    const studio = EnvironmentId.make("studio");
    const shared = EnvironmentId.make("shared");
    hoisted.environments = [
      {
        environmentId: studio,
        label: "Studio",
        connectionState: "connected",
        role: "owner",
        mutationReady: true,
      },
      {
        environmentId: shared,
        label: "Shared",
        connectionState: "read-only",
        role: "viewer",
        mutationReady: false,
      },
      {
        environmentId: EnvironmentId.make("laptop"),
        label: "Laptop",
        connectionState: "offline",
      },
    ];
    const settings = { ...DEFAULT_SERVER_SETTINGS, providerInstances: {} };
    hoisted.configs.set(studio, {
      providers: [
        provider({ status: "unauthenticated" }),
        provider(
          { status: "authenticated", email: "a@example.com", label: "ChatGPT Pro" },
          { instanceId: ProviderInstanceId.make("codex_work") },
        ),
      ],
      settings,
    });
    hoisted.configs.set(shared, { providers: [provider({ status: "unauthenticated" })], settings });

    const tree = expand(<SettingsProviderAccountsRouteScreen />);
    const sections = elements(tree, "SettingsSection");
    expect(sections.map((section) => section.props.title)).toEqual(["Studio", "Shared"]);
    const studioRows = elements(sections[0], "SettingsRow").map((row) => row.props);
    expect(studioRows.map((row) => [row.label, row.value, row.detail])).toEqual([
      ["Codex", "Not signed in", "Tap to sign in."],
      ["Codex Work", "Signed in", "ChatGPT Pro"],
    ]);
    expect(studioRows[1]!.onPress).toBeUndefined();
    const sharedRow = elements(sections[1], "SettingsRow")[0]!.props;
    expect(sharedRow).toMatchObject({ value: "Not signed in", detail: PROVIDER_SIGN_IN_FORBIDDEN });
    expect(sharedRow.onPress).toBeUndefined();
    expect(textOf(tree)).toContain("Not connected: Laptop.");
    expect(textOf(tree)).not.toContain("a@example.com");
    // No sheet until a row is chosen.
    expect(elements(tree, "Modal")).toHaveLength(0);

    (studioRows[0]!.onPress as () => void)();
    expect(hoisted.setState).toHaveBeenCalledWith({
      environmentId: studio,
      instanceId: INSTANCE,
      nodeLabel: "Studio",
      displayName: "Codex",
    });
  });

  it("says when no machine is connected", () => {
    const tree = expand(<SettingsProviderAccountsRouteScreen />);
    expect(elements(tree, "SettingsRow").map((row) => row.props.label)).toEqual([
      "No machine connected",
    ]);
  });
});

describe("ProviderSignInSheet", () => {
  it("signs in with a device code: code, copy, open, countdown and cancel", async () => {
    const node = fakeNode();
    const props = sheetProps(node.environmentId);
    let tree = mount(props);
    expect(hoisted.retain).toHaveBeenCalledWith(node.environmentId, {
      type: "provider-status",
      instanceId: INSTANCE,
    });
    expect(node.subscriptions).toHaveLength(1);
    expect(textOf(tree)).toContain("Checking sign-in on Studio…");

    node.emitState(state());
    tree = render(props);
    expect(textOf(tree)).toContain(
      "Runs Codex’s sign-in on Studio. The page opens on this device.",
    );
    (button(tree, "Sign in").onPress as () => void)();
    expect(node.start).toHaveBeenCalledWith({ instanceId: INSTANCE });
    await flush();
    tree = render(props);
    expect(textOf(tree)).toContain("Starting the sign-in on Studio…");

    node.emitState(
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
    tree = render(props);
    const code = elements(tree, "Text").find(
      (element) => element.props.accessibilityLabel === "Sign-in code",
    );
    expect(textOf(code)).toBe("ABCD-1234");
    expect(textOf(tree)).toContain(VERIFICATION_URL);
    expect(textOf(tree)).toMatch(/Expires in 1:[23]\d/u);
    expect(textOf(tree)).toContain("Closing this does not stop it.");

    (button(tree, "Copy").onPress as () => void)();
    expect(hoisted.copy).toHaveBeenCalledWith("ABCD-1234", { target: "sign-in code" });
    (button(tree, "Open sign-in page").onPress as () => void)();
    expect(hoisted.openURL).toHaveBeenCalledWith(VERIFICATION_URL);

    (button(tree, "Cancel sign-in").onPress as () => void)();
    await flush();
    expect(node.respondCalls).toEqual([
      { instanceId: INSTANCE, flowId: "flow-1", action: { type: "cancel" } },
    ]);
    node.emitState(state({ phase: "cancelled", flowId: "flow-1", message: "Sign-in cancelled." }));
    tree = render(props);
    expect(textOf(tree)).toContain("Sign-in cancelled.");
    expect(button(tree, "Try again").disabled).toBe(false);
  });

  it("offers no page to open for an address that is not https", () => {
    const node = fakeNode();
    const props = sheetProps(node.environmentId);
    mount(props);
    node.emitState(
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
    const tree = render(props);
    expect(textOf(tree)).toContain("WXYZ");
    expect(hasButton(tree, "Open sign-in page")).toBe(false);
  });

  it("runs a terminal sign-in as a transcript with one line to answer", async () => {
    const node = fakeNode();
    const props = sheetProps(node.environmentId);
    mount(props);
    node.emitState(
      state({
        phase: "waiting",
        flowId: "flow-1",
        method: "terminal",
        interaction: { type: "terminal", cols: 100, rows: 30 },
      }),
    );
    const printed =
      "\u001b[1mOpen\u001b[0m https://claude.ai/oauth/authorize?code=true\r\nPaste code here: ";
    node.emit({ type: "output", flowId: "flow-1", offset: 0, data: printed, reset: true });
    let tree = render(props);
    const output = elements(tree, "Text").find(
      (element) => element.props.accessibilityLabel === "Sign-in output",
    );
    expect(textOf(output)).toBe(
      "Open https://claude.ai/oauth/authorize?code=true\nPaste code here: ",
    );
    (button(tree, "Open link").onPress as () => void)();
    expect(hoisted.openURL).toHaveBeenCalledWith("https://claude.ai/oauth/authorize?code=true");

    const input = elements(tree, "TextInput").find(
      (element) => element.props.accessibilityLabel === "Reply to the sign-in",
    )!;
    expect(input.props).toMatchObject({ autoCorrect: false, autoCapitalize: "none" });
    (input.props.onChangeText as (text: string) => void)("pasted-code");
    (input.props.onSubmitEditing as () => void)();
    // An empty reply still answers a prompt that waits for Return.
    (button(tree, "Send reply").onPress as () => void)();
    await flush();
    await flush();
    await flush();
    // The reply and its Return are separate inputs, so a prompt that reads a chunk as a paste
    // still submits.
    expect(node.respondCalls).toEqual([
      { instanceId: INSTANCE, flowId: "flow-1", action: { type: "input", data: "pasted-code" } },
      { instanceId: INSTANCE, flowId: "flow-1", action: { type: "input", data: "\r" } },
      { instanceId: INSTANCE, flowId: "flow-1", action: { type: "input", data: "\r" } },
    ]);

    node.emit({ type: "output", flowId: "flow-1", offset: printed.length, data: "\r\nLogged in." });
    tree = render(props);
    expect(textOf(tree)).toContain("Logged in.");
  });

  it("keeps the flow on the node when the sheet closes, and shows it again", async () => {
    const node = fakeNode();
    const props = sheetProps(node.environmentId);
    mount(props);
    const waiting = state({
      phase: "waiting",
      flowId: "flow-1",
      interaction: { type: "deviceCode", verificationUrl: VERIFICATION_URL, userCode: "ABCD" },
    });
    node.emitState(waiting);
    (button(render(props), "Close sign-in").onPress as () => void)();
    expect(props.onClose).toHaveBeenCalled();
    unmount();
    await flush();
    expect(node.subscriptions[0]!.active).toBe(false);
    expect(node.respondCalls).toEqual([]);

    let tree = mount(props);
    expect(node.subscriptions).toHaveLength(2);
    expect(textOf(tree)).not.toContain("ABCD");
    node.emitState(waiting);
    tree = render(props);
    expect(textOf(tree)).toContain("ABCD");
  });

  it("names the account by its label once the node verified the sign-in, never by its email", () => {
    const node = fakeNode();
    const props = sheetProps(node.environmentId, {
      provider: provider({
        status: "authenticated",
        email: "person@example.com",
        label: "ChatGPT Pro",
      }),
    });
    mount(props);
    // The node's own outcome names the email; the sheet does not repeat it.
    node.emitState(
      state({ phase: "succeeded", flowId: "flow-1", message: "Signed in as person@example.com." }),
    );
    let tree = render(props);
    expect(textOf(tree)).toContain("Signed in as ChatGPT Pro.");
    expect(textOf(tree)).not.toContain("person@example.com");
    expect(hasButton(tree, "Sign in")).toBe(false);
    expect(hasButton(tree, "Cancel sign-in")).toBe(false);

    // The node shows the outcome for a while, then idles; the account stays signed in.
    node.emitState(state());
    tree = render(props);
    expect(textOf(tree)).toContain("Signed in as ChatGPT Pro.");
    expect(textOf(tree)).not.toContain("person@example.com");
    expect(hasButton(tree, "Sign in")).toBe(false);

    // Without a label, an email alone is not shown either.
    tree = render({
      ...props,
      provider: provider({ status: "authenticated", email: "person@example.com" }),
    });
    expect(textOf(tree)).toContain("Signed in.");
    expect(textOf(tree)).not.toContain("person@example.com");
  });

  it("says a sign-in was interrupted when the node dropped it while the sheet was closed", async () => {
    const node = fakeNode();
    const props = sheetProps(node.environmentId);
    mount(props);
    node.emitState(
      state({
        phase: "waiting",
        flowId: "flow-1",
        interaction: { type: "deviceCode", verificationUrl: VERIFICATION_URL, userCode: "ABCD" },
      }),
    );
    unmount();
    await flush();

    mount(props);
    // The node restarted meanwhile, which ends every flow without a word.
    node.emitState(state());
    const tree = render(props);
    expect(textOf(tree)).toContain("Sign-in was interrupted. Start again. Runs Codex’s sign-in");
    expect(button(tree, "Sign in").disabled).toBe(false);
  });

  it("asks to update an older node, without an error", () => {
    const node = fakeNode();
    const props = sheetProps(node.environmentId);
    mount(props);
    node.fail(new Error('Unknown request tag "provider.signIn.subscribe"'));
    const tree = render(props);
    expect(textOf(tree)).toContain("Update Ryco on Studio to sign in from here.");
    expect(elements(tree, "ErrorBanner")).toHaveLength(0);
    expect(button(tree, "Sign in").disabled).toBe(true);
  });

  it("follows nothing for a session that may not sign in, and says why", () => {
    const node = fakeNode();
    const props = sheetProps(node.environmentId, {
      access: { allowed: false, reason: PROVIDER_SIGN_IN_FORBIDDEN },
    });
    const tree = mount(props);
    expect(node.subscriptions).toHaveLength(0);
    expect(textOf(tree)).toContain(PROVIDER_SIGN_IN_FORBIDDEN);
    expect(button(tree, "Sign in").disabled).toBe(true);
  });

  it("refuses for the node when it rejects the session", () => {
    const node = fakeNode();
    const props = sheetProps(node.environmentId);
    mount(props);
    node.fail({ _tag: "AuthRpcError", message: "Only owner sessions can call it." });
    const tree = render(props);
    expect(textOf(tree)).toContain(PROVIDER_SIGN_IN_FORBIDDEN);
    expect(elements(tree, "ErrorBanner")).toHaveLength(0);
  });
});
