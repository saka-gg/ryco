import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_DESKTOP_SETTINGS,
  DesktopSettingsReadError,
  desktopHubLaunchNeedsRestart,
  isDesktopHostedIdentitySupported,
  isDesktopHubFileSecretStoreSupported,
  readDesktopSettings,
  resolveDefaultDesktopSettings,
  resolveDesktopHubConnectorLaunch,
  setDesktopHubPreference,
  setDesktopKeepAwakePreference,
  setDesktopServerExposurePreference,
  setDesktopTailscaleServePreference,
  setDesktopUpdateChannelPreference,
  writeDesktopSettings,
} from "./desktopSettings.ts";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeSettingsPath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-desktop-settings-test-"));
  tempDirectories.push(directory);
  return path.join(directory, "desktop-settings.json");
}

describe("desktopSettings", () => {
  it("returns defaults when no settings file exists", () => {
    expect(readDesktopSettings(makeSettingsPath(), "0.0.17")).toEqual(DEFAULT_DESKTOP_SETTINGS);
  });

  it("uses Ryco Cloud for an unset legacy Hub without enabling its connector", () => {
    const settingsPath = makeSettingsPath();
    fs.writeFileSync(settingsPath, JSON.stringify({ hubOrigin: null, hubConnectorEnabled: false }));
    expect(readDesktopSettings(settingsPath, "0.1.23")).toMatchObject({
      hubOrigin: "https://app.ryco.space",
      hubConnectorEnabled: false,
    });
  });

  it("defaults packaged nightly builds to the nightly update channel", () => {
    expect(resolveDefaultDesktopSettings("0.0.17-nightly.20260415.1")).toEqual({
      quitShortcutMode: "press-twice",
      serverExposureMode: "local-only",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      keepAwakeWhileReachable: true,
      updateChannel: "nightly",
      updateChannelConfiguredByUser: false,
      hubConnectorEnabled: false,
      hubConnectorDisabledByUser: false,
      hubOrigin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
      hubNodeName: null,
      hubAllowFileSecretStore: false,
    });
  });

  it("persists and reloads the configured server exposure mode", () => {
    const settingsPath = makeSettingsPath();

    writeDesktopSettings(settingsPath, {
      quitShortcutMode: "press-twice",
      serverExposureMode: "network-accessible",
      tailscaleServeEnabled: true,
      tailscaleServePort: 8443,
      keepAwakeWhileReachable: true,
      updateChannel: "latest",
      updateChannelConfiguredByUser: true,
      hubConnectorEnabled: false,
      hubConnectorDisabledByUser: false,
      hubOrigin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
      hubNodeName: null,
      hubAllowFileSecretStore: false,
    });

    expect(readDesktopSettings(settingsPath, "0.0.17")).toEqual({
      quitShortcutMode: "press-twice",
      serverExposureMode: "network-accessible",
      tailscaleServeEnabled: true,
      tailscaleServePort: 8443,
      keepAwakeWhileReachable: true,
      updateChannel: "latest",
      updateChannelConfiguredByUser: true,
      hubConnectorEnabled: false,
      hubConnectorDisabledByUser: false,
      hubOrigin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
      hubNodeName: null,
      hubAllowFileSecretStore: false,
    });
  });

  it("preserves the requested network-accessible preference across temporary fallback", () => {
    expect(
      setDesktopServerExposurePreference(
        {
          quitShortcutMode: "press-twice",
          serverExposureMode: "local-only",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
          keepAwakeWhileReachable: true,
          updateChannel: "latest",
          updateChannelConfiguredByUser: false,
          hubConnectorEnabled: false,
          hubConnectorDisabledByUser: false,
          hubOrigin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
          hubNodeName: null,
          hubAllowFileSecretStore: false,
        },
        "network-accessible",
      ),
    ).toEqual({
      quitShortcutMode: "press-twice",
      serverExposureMode: "network-accessible",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      keepAwakeWhileReachable: true,
      updateChannel: "latest",
      updateChannelConfiguredByUser: false,
      hubConnectorEnabled: false,
      hubConnectorDisabledByUser: false,
      hubOrigin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
      hubNodeName: null,
      hubAllowFileSecretStore: false,
    });
  });

  it("persists the requested Tailscale Serve preference", () => {
    expect(
      setDesktopTailscaleServePreference(
        {
          quitShortcutMode: "press-twice",
          serverExposureMode: "local-only",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
          keepAwakeWhileReachable: true,
          updateChannel: "latest",
          updateChannelConfiguredByUser: false,
          hubConnectorEnabled: false,
          hubConnectorDisabledByUser: false,
          hubOrigin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
          hubNodeName: null,
          hubAllowFileSecretStore: false,
        },
        { enabled: true, port: 8443 },
      ),
    ).toEqual({
      quitShortcutMode: "press-twice",
      serverExposureMode: "local-only",
      tailscaleServeEnabled: true,
      tailscaleServePort: 8443,
      keepAwakeWhileReachable: true,
      updateChannel: "latest",
      updateChannelConfiguredByUser: false,
      hubConnectorEnabled: false,
      hubConnectorDisabledByUser: false,
      hubOrigin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
      hubNodeName: null,
      hubAllowFileSecretStore: false,
    });
  });

  it("preserves the configured Tailscale Serve port when no new port is requested", () => {
    expect(
      setDesktopTailscaleServePreference(
        {
          quitShortcutMode: "press-twice",
          serverExposureMode: "local-only",
          tailscaleServeEnabled: false,
          tailscaleServePort: 8443,
          keepAwakeWhileReachable: true,
          updateChannel: "latest",
          updateChannelConfiguredByUser: false,
          hubConnectorEnabled: false,
          hubConnectorDisabledByUser: false,
          hubOrigin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
          hubNodeName: null,
          hubAllowFileSecretStore: false,
        },
        { enabled: true },
      ),
    ).toEqual({
      quitShortcutMode: "press-twice",
      serverExposureMode: "local-only",
      tailscaleServeEnabled: true,
      tailscaleServePort: 8443,
      keepAwakeWhileReachable: true,
      updateChannel: "latest",
      updateChannelConfiguredByUser: false,
      hubConnectorEnabled: false,
      hubConnectorDisabledByUser: false,
      hubOrigin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
      hubNodeName: null,
      hubAllowFileSecretStore: false,
    });
  });

  it("persists the requested nightly update channel", () => {
    expect(
      setDesktopUpdateChannelPreference(
        {
          quitShortcutMode: "press-twice",
          serverExposureMode: "local-only",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
          keepAwakeWhileReachable: true,
          updateChannel: "latest",
          updateChannelConfiguredByUser: false,
          hubConnectorEnabled: false,
          hubConnectorDisabledByUser: false,
          hubOrigin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
          hubNodeName: null,
          hubAllowFileSecretStore: false,
        },
        "nightly",
      ),
    ).toEqual({
      quitShortcutMode: "press-twice",
      serverExposureMode: "local-only",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      keepAwakeWhileReachable: true,
      updateChannel: "nightly",
      updateChannelConfiguredByUser: true,
      hubConnectorEnabled: false,
      hubConnectorDisabledByUser: false,
      hubOrigin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
      hubNodeName: null,
      hubAllowFileSecretStore: false,
    });
  });

  // Deliberate change of behaviour: this used to return defaults. Doing so meant
  // the next write persisted them, silently discarding a configured Hub
  // connection with no signal to the operator.
  it("surfaces a malformed settings file instead of silently resetting it", () => {
    const settingsPath = makeSettingsPath();
    fs.writeFileSync(settingsPath, "{not-json", "utf8");

    expect(() => readDesktopSettings(settingsPath, "0.0.17")).toThrow(DesktopSettingsReadError);
    // The bad file must survive, so it can be inspected rather than overwritten.
    expect(fs.readFileSync(settingsPath, "utf8")).toBe("{not-json");
  });

  it("still returns defaults when no settings file exists yet", () => {
    expect(readDesktopSettings(makeSettingsPath(), "0.0.17")).toEqual(DEFAULT_DESKTOP_SETTINGS);
  });

  it("writes the settings file owner-only", () => {
    const settingsPath = makeSettingsPath();
    writeDesktopSettings(settingsPath, DEFAULT_DESKTOP_SETTINGS);
    // The Hub address says where this machine is reachable; other local users
    // have no business reading it.
    expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600);
  });

  it("round-trips the hub launch configuration", () => {
    const settingsPath = makeSettingsPath();
    writeDesktopSettings(settingsPath, {
      ...DEFAULT_DESKTOP_SETTINGS,
      hubConnectorEnabled: true,
      hubOrigin: "https://hub.example.com",
      hubNodeName: "Build node",
      hubAllowFileSecretStore: true,
    });
    expect(readDesktopSettings(settingsPath, "0.0.17")).toMatchObject({
      hubConnectorEnabled: true,
      hubOrigin: "https://hub.example.com",
      hubNodeName: "Build node",
      hubAllowFileSecretStore: true,
    });
  });

  it("enables the connector when a Hub origin is selected for account onboarding", () => {
    const configured = setDesktopHubPreference(DEFAULT_DESKTOP_SETTINGS, {
      origin: "https://hub.example.com",
    });
    expect(configured).toMatchObject({
      hubConnectorEnabled: true,
      hubOrigin: "https://hub.example.com",
    });

    const deliberatelyDisabled = setDesktopHubPreference(DEFAULT_DESKTOP_SETTINGS, {
      enabled: false,
      origin: "https://hub.example.com",
    });
    expect(deliberatelyDisabled).toMatchObject({
      hubConnectorEnabled: false,
      hubOrigin: "https://hub.example.com",
    });
  });

  it("normalizes, preserves, and resets the desktop Hub node name", () => {
    const configured = setDesktopHubPreference(DEFAULT_DESKTOP_SETTINGS, {
      enabled: true,
      nodeName: "  Build node  ",
    });
    expect(configured).toMatchObject({
      hubConnectorEnabled: true,
      hubNodeName: "Build node",
    });

    const unchanged = setDesktopHubPreference(configured, { nodeName: "Build node" });
    expect(unchanged).toBe(configured);

    const reset = setDesktopHubPreference(configured, { nodeName: null });
    expect(reset).toMatchObject({
      hubConnectorEnabled: true,
      hubNodeName: null,
    });
  });

  it("rejects an invalid persisted Hub node name without touching the file", () => {
    const settingsPath = makeSettingsPath();
    const raw = JSON.stringify({
      hubConnectorEnabled: true,
      hubNodeName: " ",
    });
    fs.writeFileSync(settingsPath, raw, "utf8");

    expect(() => readDesktopSettings(settingsPath, "0.0.17")).toThrow(DesktopSettingsReadError);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(raw);
  });

  it("reports permissioned-file Hub key storage only on supported hosts", () => {
    expect(isDesktopHubFileSecretStoreSupported("darwin")).toBe(true);
    expect(isDesktopHubFileSecretStoreSupported("linux")).toBe(true);
    expect(isDesktopHubFileSecretStoreSupported("win32")).toBe(false);
  });

  it("launches a configured Hub connector in standby until the operator chooses", () => {
    // Fresh installs used to launch the connector disabled, so the first
    // account sign-in had to enable it and relaunch Desktop mid-turn.
    expect(resolveDesktopHubConnectorLaunch(DEFAULT_DESKTOP_SETTINGS)).toEqual({
      enabled: true,
      standby: true,
      origin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
      nodeName: null,
      allowFileSecretStore: false,
    });

    const turnedOn = setDesktopHubPreference(DEFAULT_DESKTOP_SETTINGS, { enabled: true });
    expect(resolveDesktopHubConnectorLaunch(turnedOn)).toMatchObject({
      enabled: true,
      standby: false,
    });

    const turnedOff = setDesktopHubPreference(turnedOn, { enabled: false });
    expect(turnedOff).toMatchObject({
      hubConnectorEnabled: false,
      hubConnectorDisabledByUser: true,
    });
    expect(resolveDesktopHubConnectorLaunch(turnedOff)).toMatchObject({
      enabled: false,
      standby: false,
    });

    // Turning it back on, or choosing a Hub, clears the explicit opt-out.
    expect(setDesktopHubPreference(turnedOff, { enabled: true })).toMatchObject({
      hubConnectorDisabledByUser: false,
    });
    expect(setDesktopHubPreference(turnedOff, { origin: "https://hub.example.com" })).toMatchObject(
      { hubConnectorEnabled: true, hubConnectorDisabledByUser: false },
    );
    // An unrelated launch value keeps the operator's choice.
    expect(setDesktopHubPreference(turnedOff, { nodeName: "Build node" })).toMatchObject({
      hubConnectorDisabledByUser: true,
    });

    expect(
      resolveDesktopHubConnectorLaunch({ ...DEFAULT_DESKTOP_SETTINGS, hubOrigin: null }),
    ).toMatchObject({ enabled: false, standby: false });
  });

  it("reads settings written before the connector choice existed as not chosen", () => {
    const settingsPath = makeSettingsPath();
    // A legacy false may be an explicit opt-out; the backend's identity check
    // keeps standby from ever connecting an identity that already exists.
    fs.writeFileSync(settingsPath, JSON.stringify({ hubConnectorEnabled: false }));
    const legacy = readDesktopSettings(settingsPath, "0.1.21");
    expect(legacy.hubConnectorDisabledByUser).toBe(false);
    expect(resolveDesktopHubConnectorLaunch(legacy).standby).toBe(true);

    writeDesktopSettings(settingsPath, setDesktopHubPreference(legacy, { enabled: false }));
    expect(readDesktopSettings(settingsPath, "0.1.21").hubConnectorDisabledByUser).toBe(true);
  });

  it("restarts only for launch changes the running backend cannot already serve", () => {
    const standby = resolveDesktopHubConnectorLaunch(DEFAULT_DESKTOP_SETTINGS);
    const enabled = resolveDesktopHubConnectorLaunch(
      setDesktopHubPreference(DEFAULT_DESKTOP_SETTINGS, { enabled: true }),
    );
    // Account setup or enrollment in standby persists an explicit enable.
    expect(desktopHubLaunchNeedsRestart(enabled, standby)).toBe(false);
    expect(desktopHubLaunchNeedsRestart(standby, standby)).toBe(false);

    const disabled = resolveDesktopHubConnectorLaunch(
      setDesktopHubPreference(DEFAULT_DESKTOP_SETTINGS, { enabled: false }),
    );
    expect(desktopHubLaunchNeedsRestart(enabled, disabled)).toBe(true);
    expect(desktopHubLaunchNeedsRestart(disabled, standby)).toBe(true);
    expect(
      desktopHubLaunchNeedsRestart({ ...enabled, origin: "https://other.example" }, enabled),
    ).toBe(true);
    expect(desktopHubLaunchNeedsRestart({ ...enabled, nodeName: "Build node" }, enabled)).toBe(
      true,
    );
    expect(desktopHubLaunchNeedsRestart({ ...enabled, allowFileSecretStore: true }, enabled)).toBe(
      true,
    );
  });

  it("keeps a reachable node awake by default and persists an opt-out", () => {
    expect(DEFAULT_DESKTOP_SETTINGS.keepAwakeWhileReachable).toBe(true);
    const settingsPath = makeSettingsPath();
    // Settings written before the preference existed keep the default.
    fs.writeFileSync(settingsPath, JSON.stringify({ hubConnectorEnabled: true }));
    expect(readDesktopSettings(settingsPath, "0.1.21").keepAwakeWhileReachable).toBe(true);

    const optedOut = setDesktopKeepAwakePreference(DEFAULT_DESKTOP_SETTINGS, false);
    writeDesktopSettings(settingsPath, optedOut);
    expect(readDesktopSettings(settingsPath, "0.1.21").keepAwakeWhileReachable).toBe(false);
    expect(setDesktopKeepAwakePreference(optedOut, false)).toBe(optedOut);
  });

  it("offers native account setup only where the hardware-backed helper ships", () => {
    expect(isDesktopHostedIdentitySupported("darwin")).toBe(true);
    // Linux and Windows desktops are released too; they enrol through the
    // device-code ceremony and must never wait on native account setup.
    expect(isDesktopHostedIdentitySupported("linux")).toBe(false);
    expect(isDesktopHostedIdentitySupported("win32")).toBe(false);
  });

  it("defaults legacy Hub settings to OS-protected key storage only", () => {
    const settingsPath = makeSettingsPath();
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hubConnectorEnabled: true,
        hubOrigin: "https://hub.example.com",
      }),
      "utf8",
    );

    expect(readDesktopSettings(settingsPath, "0.0.17")).toMatchObject({
      hubConnectorEnabled: true,
      hubOrigin: "https://hub.example.com",
      hubNodeName: null,
      hubAllowFileSecretStore: false,
    });
  });

  it("falls back to the nightly channel for legacy nightly settings without an update track", () => {
    const settingsPath = makeSettingsPath();
    fs.writeFileSync(settingsPath, JSON.stringify({ serverExposureMode: "local-only" }), "utf8");

    expect(readDesktopSettings(settingsPath, "0.0.17-nightly.20260415.1")).toEqual({
      quitShortcutMode: "press-twice",
      serverExposureMode: "local-only",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      keepAwakeWhileReachable: true,
      updateChannel: "nightly",
      updateChannelConfiguredByUser: false,
      hubConnectorEnabled: false,
      hubConnectorDisabledByUser: false,
      hubOrigin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
      hubNodeName: null,
      hubAllowFileSecretStore: false,
    });
  });

  it("migrates legacy implicit stable settings to nightly when running a nightly build", () => {
    const settingsPath = makeSettingsPath();
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        quitShortcutMode: "press-twice",
        serverExposureMode: "local-only",
        updateChannel: "latest",
      }),
      "utf8",
    );

    expect(readDesktopSettings(settingsPath, "0.0.17-nightly.20260415.1")).toEqual({
      quitShortcutMode: "press-twice",
      serverExposureMode: "local-only",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      keepAwakeWhileReachable: true,
      updateChannel: "nightly",
      updateChannelConfiguredByUser: false,
      hubConnectorEnabled: false,
      hubConnectorDisabledByUser: false,
      hubOrigin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
      hubNodeName: null,
      hubAllowFileSecretStore: false,
    });
  });

  it("preserves an explicit stable choice on nightly builds", () => {
    const settingsPath = makeSettingsPath();
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        quitShortcutMode: "press-twice",
        serverExposureMode: "local-only",
        updateChannel: "latest",
        updateChannelConfiguredByUser: true,
        hubConnectorEnabled: false,
        hubConnectorDisabledByUser: false,
        hubOrigin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
        hubNodeName: null,
        hubAllowFileSecretStore: false,
      }),
      "utf8",
    );

    expect(readDesktopSettings(settingsPath, "0.0.17-nightly.20260415.1")).toEqual({
      quitShortcutMode: "press-twice",
      serverExposureMode: "local-only",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      keepAwakeWhileReachable: true,
      updateChannel: "latest",
      updateChannelConfiguredByUser: true,
      hubConnectorEnabled: false,
      hubConnectorDisabledByUser: false,
      hubOrigin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
      hubNodeName: null,
      hubAllowFileSecretStore: false,
    });
  });

  it("falls back to the default Tailscale Serve port when the persisted port is invalid", () => {
    const settingsPath = makeSettingsPath();
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        tailscaleServeEnabled: true,
        tailscaleServePort: 0,
      }),
      "utf8",
    );

    expect(readDesktopSettings(settingsPath, "0.0.17")).toEqual({
      quitShortcutMode: "press-twice",
      serverExposureMode: "local-only",
      tailscaleServeEnabled: true,
      tailscaleServePort: 443,
      keepAwakeWhileReachable: true,
      updateChannel: "latest",
      updateChannelConfiguredByUser: false,
      hubConnectorEnabled: false,
      hubConnectorDisabledByUser: false,
      hubOrigin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
      hubNodeName: null,
      hubAllowFileSecretStore: false,
    });
  });
});

it.each(["press-twice", "hold", "immediately"] as const)(
  "persists quit shortcut mode %s",
  (quitShortcutMode) => {
    const settingsPath = makeSettingsPath();
    writeDesktopSettings(settingsPath, { ...DEFAULT_DESKTOP_SETTINGS, quitShortcutMode });
    expect(readDesktopSettings(settingsPath, "0.1.21").quitShortcutMode).toBe(quitShortcutMode);
  },
);

it("defaults missing or invalid quit shortcut preferences to press twice", () => {
  const settingsPath = makeSettingsPath();
  for (const value of [{}, { quitShortcutMode: "bad" }]) {
    fs.writeFileSync(settingsPath, JSON.stringify(value));
    expect(readDesktopSettings(settingsPath, "0.1.21").quitShortcutMode).toBe("press-twice");
  }
});
