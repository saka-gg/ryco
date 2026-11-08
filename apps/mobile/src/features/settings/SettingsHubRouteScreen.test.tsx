import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The Hub settings route, invoked as a plain function with react-native mocked —
// the same shape `ConnectionsRouteScreen.test.ts` uses, because no React renderer
// exists in this suite. What it proves is one thing: the Hub-domain change clears
// the §13 trust state recorded under the origin being left. That registration is
// by hand (no generic secret-wipe path exists), so nothing else would catch it
// going missing.

const hoisted = vi.hoisted(() => ({
  forgetHubOrigin: vi.fn(async (_origin: string) => undefined),
  clearMobileHostedSessionToken: vi.fn(async () => undefined),
  invalidateMobileHostedRuntime: vi.fn(),
  ensureMobileHostedSession: vi.fn(async () => undefined),
  navigate: vi.fn(),
  order: [] as string[],
  mountEffects: [] as (() => void)[],
}));

vi.mock("react-native", () => ({ ScrollView: "ScrollView", View: "View" }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)) =>
      [typeof initial === "function" ? (initial as () => T)() : initial, () => undefined] as const,
    useEffect: (effect: () => void) => hoisted.mountEffects.push(effect),
    useMemo: <T,>(factory: () => T) => factory(),
  };
});
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: hoisted.navigate }),
}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock("../../components/AppText", () => ({ AppText: "AppText" }));
vi.mock("../../components/ErrorBanner", () => ({ ErrorBanner: "ErrorBanner" }));
vi.mock("../../components/ConfirmDialogHost", () => ({
  showConfirmDialog: (request: { readonly onConfirm: () => void }) => request.onConfirm(),
}));
vi.mock("./components/SettingsRow", () => ({ SettingsRow: "SettingsRow" }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: "SettingsSection" }));
vi.mock("./HubDomainEditor", () => ({ HubDomainEditor: "HubDomainEditor" }));
vi.mock("../hostedHub/useHostedMode", () => ({ useHostedModeAvailable: () => false }));
vi.mock("../../platform/config", () => ({
  isMobileDevelopmentBuild: () => false,
  readMobileHostedConfig: () => null,
}));
vi.mock("../../platform/hostedSignInPreview", () => ({
  openHostedSignInPreview: async () => undefined,
  resolveHostedSignInPreviewUrl: () => null,
}));
vi.mock("../../platform/sessionCredentials", () => ({
  clearMobileHostedSessionToken: async () => {
    hoisted.order.push("clear-session-token");
    await hoisted.clearMobileHostedSessionToken();
  },
}));
vi.mock("../../platform/e2eeTrustStore", () => ({
  mobileE2eeTrustStore: {
    forgetHubOrigin: async (origin: string) => {
      hoisted.order.push("forget-hub-origin");
      await hoisted.forgetHubOrigin(origin);
    },
  },
}));
vi.mock("../../hostedHub/runtime", () => ({
  invalidateMobileHostedRuntime: hoisted.invalidateMobileHostedRuntime,
}));
vi.mock("../../hostedHub/state", () => ({
  ensureMobileHostedSession: hoisted.ensureMobileHostedSession,
  hostedHubController: { signOut: async () => undefined, expireSession: async () => undefined },
  hostedHubStore: { getState: () => ({ accountStatus: "signed-out" }) },
  isMobileHostedModeAvailable: () => false,
}));

import {
  createHubProfile,
  resetMobileHubProfileCacheForTests,
  saveMobileHubProfile,
  type HubProfile,
} from "../../hostedHub/hubProfile";
import { SettingsHubRouteScreen } from "./SettingsHubRouteScreen";

const CURRENT_ORIGIN = "https://hub.example.test";
const NEXT_ORIGIN = "https://other.example.test";

const memoryKV = { setItem: async () => undefined };

function findProps(node: unknown, type: string): Record<string, unknown> | null {
  if (node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findProps(child, type);
      if (found !== null) return found;
    }
    return null;
  }
  const element = node as ReactElement<Record<string, unknown>>;
  if (element.type === type) return element.props;
  return findProps((element.props as { children?: unknown } | undefined)?.children, type);
}

function findPropsByLabel(
  node: unknown,
  type: string,
  label: string,
): Record<string, unknown> | null {
  if (node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findPropsByLabel(child, type, label);
      if (found !== null) return found;
    }
    return null;
  }
  const element = node as ReactElement<Record<string, unknown>>;
  if (element.type === type && element.props.label === label) return element.props;
  return findPropsByLabel(
    (element.props as { children?: unknown } | undefined)?.children,
    type,
    label,
  );
}

beforeEach(async () => {
  hoisted.order.length = 0;
  hoisted.mountEffects.length = 0;
  vi.clearAllMocks();
  resetMobileHubProfileCacheForTests();
  await saveMobileHubProfile(memoryKV, createHubProfile({ origin: CURRENT_ORIGIN })!);
});

describe("Hub domain change", () => {
  it("clears the §13 trust state recorded under the origin being left", async () => {
    const editor = findProps(SettingsHubRouteScreen(), "HubDomainEditor");
    const onSave = editor?.onSave as (next: HubProfile | null) => void;

    onSave(createHubProfile({ origin: NEXT_ORIGIN }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // docs/relay-e2ee-protocol.md §13.1: the pins, latches, owner legacy
    // consents, strict-legacy policy and `anyNodeVerified` marker recorded under
    // the OLD origin, cleared before the profile is replaced.
    expect(hoisted.forgetHubOrigin).toHaveBeenCalledTimes(1);
    expect(hoisted.forgetHubOrigin).toHaveBeenCalledWith(CURRENT_ORIGIN);
    expect(hoisted.order).toEqual(["clear-session-token", "forget-hub-origin"]);
  });

  it("clears nothing when the origin does not change", async () => {
    const editor = findProps(SettingsHubRouteScreen(), "HubDomainEditor");
    const onSave = editor?.onSave as (next: HubProfile | null) => void;

    onSave(createHubProfile({ origin: CURRENT_ORIGIN }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hoisted.forgetHubOrigin).not.toHaveBeenCalled();
  });
});

describe("Hub settings navigation", () => {
  it("pushes Machines above the Settings page", () => {
    const row = findPropsByLabel(SettingsHubRouteScreen(), "SettingsRow", "Machines");

    expect(typeof row?.onPress).toBe("function");
    if (typeof row?.onPress !== "function") throw new Error("Machines row is not actionable");
    row.onPress();

    expect(hoisted.navigate).toHaveBeenCalledWith("Connections");
  });
});
