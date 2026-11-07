import "../../index.css";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import {
  EnvironmentId,
  type ComputerBetaState,
  type ComputerBetaUpdate,
  type DesktopBridge,
  type EnvironmentApi,
} from "@ryco/contracts";

const LOCAL = EnvironmentId.make("local-mac");
vi.mock("../../computerUse/localComputer", () => ({
  useLocalComputerEnvironmentId: () => LOCAL,
}));

import { __setEnvironmentApiOverrideForTests } from "../../environmentApi";
import { ComputerBetaSettings } from "./ComputerBetaSettings";

const previous = window.desktopBridge;
afterEach(() => {
  if (previous) window.desktopBridge = previous;
  else delete window.desktopBridge;
});

type Permission = "granted" | "denied" | "not-determined";
function fixture(options: {
  accessibility?: Permission;
  screenRecording?: Permission;
  inputMonitoring?: Permission;
  defaultEnabled?: boolean;
  agentControl?: boolean;
  staleGrant?: boolean;
  movedToHelper?: boolean;
  appDisplayName?: string;
  approvedApps?: ComputerBetaState["approvedApps"];
}) {
  const permissions = {
    accessibility: options.accessibility ?? "granted",
    screenRecording: options.screenRecording ?? "granted",
    inputMonitoring: options.inputMonitoring ?? "granted",
  };
  const build = (defaultEnabled: boolean): ComputerBetaState => ({
    supported: true,
    preferences: { defaultEnabled, autoPreview: true, previewSize: "compact", cursorColor: null },
    permissions: {
      platform: "macos",
      supported: true,
      enabled: false,
      status: "ready",
      shortcut: null,
      accessibilityPermission: permissions.accessibility,
      inputMonitoringPermission: permissions.inputMonitoring,
      screenRecordingPermission: permissions.screenRecording,
      message: null,
      appDisplayName: options.appDisplayName ?? "Ryco",
    },
    inputMonitorReady: true,
    setup: {
      missing: (["accessibility", "screenRecording"] as const).filter(
        (key) => permissions[key] !== "granted",
      ),
      escapeStop: permissions.inputMonitoring === "granted",
      staleGrant: options.staleGrant ?? false,
      ...(options.movedToHelper ? { movedToHelper: true } : {}),
    },
    approvedApps: options.approvedApps ?? [],
    error: null,
  });
  let state = build(options.defaultEnabled ?? false);
  const listeners = new Set<(event: ComputerBetaUpdate) => void>();
  const turnOn = vi.fn(async () => {
    state = build(true);
    return state;
  });
  const setPreferences = vi.fn(async (preferences: ComputerBetaState["preferences"]) => {
    state = { ...state, preferences };
    return state;
  });
  const setupPermission = vi.fn(async () => state);
  const revokeApp = vi.fn(async (key: string) => {
    state = { ...state, approvedApps: state.approvedApps.filter((app) => app.key !== key) };
    return state;
  });
  const prepare = vi.fn(async () => null);
  const getHistory = vi.fn(async () => ({
    entries: [],
    nextCursor: null,
    truncated: false,
    status: "available" as const,
  }));
  const restartApp = vi.fn(async () => {});
  const setup = vi.fn(async () => state);
  window.desktopBridge = {
    restartApp,
    computerBeta: {
      getState: async () => state,
      checkPermissions: async () => state,
      setPreferences,
      setup,
      turnOn,
      setupPermission,
      revokeApp,
      prepare,
      setPreview: async () => {},
      stopTask: async () => {},
      getHistory,
      onUpdate: (listener: (event: ComputerBetaUpdate) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  } as unknown as DesktopBridge;
  let agentControl = options.agentControl ?? true;
  const updateSettings = vi.fn(async (patch: { agentControl?: { enabled?: boolean } }) => {
    if (patch.agentControl?.enabled !== undefined) agentControl = patch.agentControl.enabled;
    return { agentControl: { enabled: agentControl } };
  });
  __setEnvironmentApiOverrideForTests(LOCAL, {
    server: {
      getSettings: async () => ({ agentControl: { enabled: agentControl } }),
      updateSettings,
    },
  } as unknown as EnvironmentApi);
  return {
    turnOn,
    setup,
    setPreferences,
    setupPermission,
    revokeApp,
    prepare,
    getHistory,
    restartApp,
    updateSettings,
  };
}

it("turns on with one button, including Agent Control, and never sends a task", async () => {
  const f = fixture({
    accessibility: "denied",
    screenRecording: "not-determined",
    inputMonitoring: "denied",
    agentControl: false,
  });
  const view = await render(<ComputerBetaSettings />);
  await expect.element(view.getByText(/turns on Agent Control/)).toBeVisible();
  await view.getByRole("button", { name: "Turn on Computer Use" }).click();
  await vi.waitFor(() => expect(f.turnOn).toHaveBeenCalledOnce());
  expect(f.updateSettings).toHaveBeenCalledWith({ agentControl: { enabled: true } });
  expect(f.prepare).not.toHaveBeenCalled();
  // Setup is still waiting on macOS: the button now continues it.
  await expect.element(view.getByRole("button", { name: "Continue setup" })).toBeVisible();
  await expect.element(view.getByRole("button", { name: "Fix Accessibility" })).toBeVisible();
  await view.getByRole("button", { name: "Fix Screen Recording" }).click();
  expect(f.setupPermission).toHaveBeenCalledWith("screenRecording");
  await view.getByRole("button", { name: "Turn on Input Monitoring" }).click();
  expect(f.setupPermission).toHaveBeenLastCalledWith("inputMonitoring");
  await expect
    .element(view.getByText(/Without Input Monitoring, agents stay in the background/))
    .toBeVisible();
});

it("shows Computer Use on with live permission badges and a per-app list to revoke", async () => {
  const f = fixture({
    defaultEnabled: true,
    approvedApps: [
      { key: "safari", name: "Safari", allowedAt: "2026-11-06T00:00:00.000Z" },
      { key: "notes", name: "Notes", allowedAt: "2026-11-06T00:00:00.000Z" },
    ],
  });
  const view = await render(<ComputerBetaSettings />);
  await expect
    .element(view.getByRole("switch", { name: "Use Computer Use in every chat" }))
    .toBeChecked();
  expect(document.querySelectorAll('[data-permission-status="granted"]')).toHaveLength(3);
  await expect
    .element(view.getByRole("button", { name: "Fix Accessibility" }))
    .not.toBeInTheDocument();
  await view.getByRole("button", { name: "Remove Safari" }).click();
  expect(f.revokeApp).toHaveBeenCalledWith("safari");
  await expect.element(view.getByRole("button", { name: "Remove Safari" })).not.toBeInTheDocument();
  await expect.element(view.getByRole("button", { name: "Remove Notes" })).toBeVisible();
  // Turning it off leaves Agent Control alone.
  await view.getByRole("switch", { name: "Use Computer Use in every chat" }).click();
  expect(f.setPreferences).toHaveBeenLastCalledWith(
    expect.objectContaining({ defaultEnabled: false }),
  );
  expect(f.updateSettings).not.toHaveBeenCalled();
  await expect
    .element(view.getByRole("switch", { name: "Use Computer Use in every chat" }))
    .not.toBeChecked();
  expect(f.getHistory).not.toHaveBeenCalled();
  await view.getByRole("button", { name: "Load recent actions" }).click();
  expect(f.getHistory).toHaveBeenCalledOnce();
});

it("explains a stale grant after an update and offers Quit & Reopen", async () => {
  const f = fixture({ defaultEnabled: true, accessibility: "denied", staleGrant: true });
  const view = await render(<ComputerBetaSettings />);
  await expect.element(view.getByText("macOS may still list an older Ryco")).toBeVisible();
  await view.getByRole("button", { name: "Quit & Reopen" }).click();
  expect(f.restartApp).toHaveBeenCalledOnce();
});

it("explains once that Computer Use moved to its own helper app", async () => {
  const f = fixture({
    defaultEnabled: true,
    accessibility: "denied",
    movedToHelper: true,
    appDisplayName: "Ryco Computer Use",
  });
  const view = await render(<ComputerBetaSettings />);
  await expect.element(view.getByText("Computer Use now runs as Ryco Computer Use")).toBeVisible();
  await expect.element(view.getByText(/Granted to Ryco Computer Use/)).toBeVisible();
  await expect.element(view.getByText(/may still list an older/)).not.toBeInTheDocument();
  await view.getByRole("button", { name: "Set up" }).click();
  // It guides the permissions only; it does not turn Computer Use on for every chat.
  expect(f.setup).toHaveBeenCalledOnce();
  expect(f.turnOn).not.toHaveBeenCalled();
});

it("warns when Agent Control was turned off after setup", async () => {
  const f = fixture({ defaultEnabled: true, agentControl: false });
  const view = await render(<ComputerBetaSettings />);
  await expect
    .element(view.getByText("Agent Control is off, so agents can't use the computer."))
    .toBeVisible();
  await view.getByRole("button", { name: "Turn on Agent Control" }).click();
  expect(f.updateSettings).toHaveBeenCalledWith({ agentControl: { enabled: true } });
  await expect
    .element(view.getByText("Agent Control is off, so agents can't use the computer."))
    .not.toBeInTheDocument();
});
