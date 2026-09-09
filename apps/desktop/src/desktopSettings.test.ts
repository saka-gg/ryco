import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_DESKTOP_SETTINGS,
  DesktopSettingsReadError,
  isDesktopHubFileSecretStoreSupported,
  readDesktopSettings,
  resolveDefaultDesktopSettings,
  setDesktopHubPreference,
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
      updateChannel: "nightly",
      updateChannelConfiguredByUser: false,
      hubConnectorEnabled: false,
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
      updateChannel: "latest",
      updateChannelConfiguredByUser: true,
      hubConnectorEnabled: false,
      hubOrigin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
      hubNodeName: null,
      hubAllowFileSecretStore: false,
    });

    expect(readDesktopSettings(settingsPath, "0.0.17")).toEqual({
      quitShortcutMode: "press-twice",
      serverExposureMode: "network-accessible",
      tailscaleServeEnabled: true,
      tailscaleServePort: 8443,
      updateChannel: "latest",
      updateChannelConfiguredByUser: true,
      hubConnectorEnabled: false,
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
          updateChannel: "latest",
          updateChannelConfiguredByUser: false,
          hubConnectorEnabled: false,
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
      updateChannel: "latest",
      updateChannelConfiguredByUser: false,
      hubConnectorEnabled: false,
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
          updateChannel: "latest",
          updateChannelConfiguredByUser: false,
          hubConnectorEnabled: false,
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
      updateChannel: "latest",
      updateChannelConfiguredByUser: false,
      hubConnectorEnabled: false,
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
          updateChannel: "latest",
          updateChannelConfiguredByUser: false,
          hubConnectorEnabled: false,
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
      updateChannel: "latest",
      updateChannelConfiguredByUser: false,
      hubConnectorEnabled: false,
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
          updateChannel: "latest",
          updateChannelConfiguredByUser: false,
          hubConnectorEnabled: false,
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
      updateChannel: "nightly",
      updateChannelConfiguredByUser: true,
      hubConnectorEnabled: false,
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
      updateChannel: "nightly",
      updateChannelConfiguredByUser: false,
      hubConnectorEnabled: false,
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
      updateChannel: "nightly",
      updateChannelConfiguredByUser: false,
      hubConnectorEnabled: false,
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
      updateChannel: "latest",
      updateChannelConfiguredByUser: true,
      hubConnectorEnabled: false,
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
      updateChannel: "latest",
      updateChannelConfiguredByUser: false,
      hubConnectorEnabled: false,
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
