import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_DESKTOP_SETTINGS,
  DesktopSettingsReadError,
  desktopHubAllowsBackgroundNodeClaim,
  desktopHubLaunchNeedsRestart,
  isDesktopHostedIdentitySupported,
  isDesktopHubFileSecretStoreSupported,
  pendingDesktopServerExposureMode,
  pendingDesktopTailscaleServe,
  planDesktopServerExposureChange,
  planDesktopTailscaleServeChange,
  readDesktopSettings,
  resolveDefaultDesktopSettings,
  resolveDesktopHubConnectorLaunch,
  resolveDesktopTailscaleServeLaunch,
  setDesktopHubPreference,
  setDesktopKeepAwakeMode,
  setDesktopServerExposurePreference,
  setDesktopTailscaleServePreference,
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

  it("uses the same defaults for every version: the app, not a setting, picks the channel", () => {
    expect(resolveDefaultDesktopSettings("0.0.17-nightly.20260415.1")).toEqual({
      quitShortcutMode: "press-twice",
      serverExposureMode: "local-only",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      keepAwakeMode: "reachable-or-working",
      hubConnectorEnabled: false,
      hubConnectorDisabledByUser: false,
      hubOrigin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
      hubNodeName: null,
      hubAllowFileSecretStore: false,
      backendPort: null,
    });
  });

  it("persists and reloads the configured server exposure mode", () => {
    const settingsPath = makeSettingsPath();

    writeDesktopSettings(settingsPath, {
      quitShortcutMode: "press-twice",
      serverExposureMode: "network-accessible",
      tailscaleServeEnabled: true,
      tailscaleServePort: 8443,
      keepAwakeMode: "reachable-or-working",
      hubConnectorEnabled: false,
      hubConnectorDisabledByUser: false,
      hubOrigin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
      hubNodeName: null,
      hubAllowFileSecretStore: false,
      backendPort: null,
    });

    expect(readDesktopSettings(settingsPath, "0.0.17")).toEqual({
      quitShortcutMode: "press-twice",
      serverExposureMode: "network-accessible",
      tailscaleServeEnabled: true,
      tailscaleServePort: 8443,
      keepAwakeMode: "reachable-or-working",
      hubConnectorEnabled: false,
      hubConnectorDisabledByUser: false,
      hubOrigin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
      hubNodeName: null,
      hubAllowFileSecretStore: false,
      backendPort: null,
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
          keepAwakeMode: "reachable-or-working",
          hubConnectorEnabled: false,
          hubConnectorDisabledByUser: false,
          hubOrigin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
          hubNodeName: null,
          hubAllowFileSecretStore: false,
          backendPort: null,
        },
        "network-accessible",
      ),
    ).toEqual({
      quitShortcutMode: "press-twice",
      serverExposureMode: "network-accessible",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      keepAwakeMode: "reachable-or-working",
      hubConnectorEnabled: false,
      hubConnectorDisabledByUser: false,
      hubOrigin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
      hubNodeName: null,
      hubAllowFileSecretStore: false,
      backendPort: null,
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
          keepAwakeMode: "reachable-or-working",
          hubConnectorEnabled: false,
          hubConnectorDisabledByUser: false,
          hubOrigin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
          hubNodeName: null,
          hubAllowFileSecretStore: false,
          backendPort: null,
        },
        { enabled: true, port: 8443 },
      ),
    ).toEqual({
      quitShortcutMode: "press-twice",
      serverExposureMode: "local-only",
      tailscaleServeEnabled: true,
      tailscaleServePort: 8443,
      keepAwakeMode: "reachable-or-working",
      hubConnectorEnabled: false,
      hubConnectorDisabledByUser: false,
      hubOrigin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
      hubNodeName: null,
      hubAllowFileSecretStore: false,
      backendPort: null,
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
          keepAwakeMode: "reachable-or-working",
          hubConnectorEnabled: false,
          hubConnectorDisabledByUser: false,
          hubOrigin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
          hubNodeName: null,
          hubAllowFileSecretStore: false,
          backendPort: null,
        },
        { enabled: true },
      ),
    ).toEqual({
      quitShortcutMode: "press-twice",
      serverExposureMode: "local-only",
      tailscaleServeEnabled: true,
      tailscaleServePort: 8443,
      keepAwakeMode: "reachable-or-working",
      hubConnectorEnabled: false,
      hubConnectorDisabledByUser: false,
      hubOrigin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
      hubNodeName: null,
      hubAllowFileSecretStore: false,
      backendPort: null,
    });
  });

  it("measures a Tailscale Serve request against what the running backend serves", () => {
    const serving = setDesktopTailscaleServePreference(DEFAULT_DESKTOP_SETTINGS, {
      enabled: true,
      port: 443,
    });
    const running = resolveDesktopTailscaleServeLaunch(serving);

    // Turns are running: the disable is saved and the backend keeps serving.
    const deferred = planDesktopTailscaleServeChange({
      settings: serving,
      running,
      requested: { enabled: false, port: 443 },
      deferRelaunch: true,
    });
    expect(deferred.relaunch).toBe(false);
    expect(deferred.settings.tailscaleServeEnabled).toBe(false);

    // Asking for the saved disable again, now, must still stop serving. It
    // used to compare with the saved value and silently do nothing.
    const now = planDesktopTailscaleServeChange({
      settings: deferred.settings,
      running,
      requested: { enabled: false, port: 443 },
      deferRelaunch: false,
    });
    expect(now).toEqual({ settings: deferred.settings, relaunch: true });

    // Asking for what already runs withdraws the saved change in place.
    const withdrawn = planDesktopTailscaleServeChange({
      settings: deferred.settings,
      running,
      requested: { enabled: true, port: 443 },
      deferRelaunch: false,
    });
    expect(withdrawn.relaunch).toBe(false);
    expect(resolveDesktopTailscaleServeLaunch(withdrawn.settings)).toEqual(running);

    // A port only matters while serving.
    expect(
      planDesktopTailscaleServeChange({
        settings: DEFAULT_DESKTOP_SETTINGS,
        running: { enabled: false, port: 8443 },
        requested: { enabled: false, port: 443 },
        deferRelaunch: false,
      }).relaunch,
    ).toBe(false);
    expect(
      planDesktopTailscaleServeChange({
        settings: serving,
        running,
        requested: { enabled: true, port: 8443 },
        deferRelaunch: false,
      }).relaunch,
    ).toBe(true);
  });

  it("keeps a saved network access change visible and withdrawable until it applies", () => {
    // Turns are running: turning network access on is saved for the relaunch.
    const deferred = planDesktopServerExposureChange({
      settings: DEFAULT_DESKTOP_SETTINGS,
      running: "local-only",
      requested: "network-accessible",
      deferRelaunch: true,
    });
    expect(deferred.relaunch).toBe(false);
    expect(pendingDesktopServerExposureMode(deferred.settings, "local-only")).toBe(
      "network-accessible",
    );

    // Asking for the running mode withdraws it, without a relaunch. It used to
    // return early and leave the widening armed for whatever launch came next.
    const withdrawn = planDesktopServerExposureChange({
      settings: deferred.settings,
      running: "local-only",
      requested: "local-only",
      deferRelaunch: false,
    });
    expect(withdrawn).toEqual({ settings: DEFAULT_DESKTOP_SETTINGS, relaunch: false });
    expect(pendingDesktopServerExposureMode(withdrawn.settings, "local-only")).toBeNull();

    // Asking for the saved change again, now, applies it.
    expect(
      planDesktopServerExposureChange({
        settings: deferred.settings,
        running: "local-only",
        requested: "network-accessible",
        deferRelaunch: false,
      }),
    ).toEqual({ settings: deferred.settings, relaunch: true });
  });

  it("reports a Tailscale Serve change saved for the next launch", () => {
    const serving = setDesktopTailscaleServePreference(DEFAULT_DESKTOP_SETTINGS, {
      enabled: true,
      port: 8443,
    });
    expect(pendingDesktopTailscaleServe(serving, { enabled: false, port: 443 })).toEqual({
      enabled: true,
      port: 8443,
    });
    expect(pendingDesktopTailscaleServe(serving, { enabled: true, port: 443 })).toEqual({
      enabled: true,
      port: 8443,
    });
    expect(pendingDesktopTailscaleServe(serving, { enabled: true, port: 8443 })).toBeNull();
    expect(
      pendingDesktopTailscaleServe(DEFAULT_DESKTOP_SETTINGS, { enabled: false, port: 8443 }),
    ).toBeNull();
  });

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
      backendPort: null,
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

  it("keeps a legacy connector off beside a retained account session", () => {
    // Connect account, Leave Hub (identity erased, session kept), Turn off:
    // the backend has no identity, so only the session says this was chosen.
    const settingsPath = makeSettingsPath();
    fs.writeFileSync(settingsPath, JSON.stringify({ hubConnectorEnabled: false }));
    let asked = 0;
    const withSession = readDesktopSettings(settingsPath, "0.1.21", {
      hasRetainedHubSession: () => {
        asked += 1;
        return true;
      },
    });
    expect(withSession.hubConnectorDisabledByUser).toBe(true);
    expect(resolveDesktopHubConnectorLaunch(withSession)).toMatchObject({
      enabled: false,
      standby: false,
    });
    expect(desktopHubAllowsBackgroundNodeClaim(withSession)).toBe(false);

    expect(
      readDesktopSettings(settingsPath, "0.1.21", { hasRetainedHubSession: () => false })
        .hubConnectorDisabledByUser,
    ).toBe(false);

    // A legacy enabled connector, and any recorded choice, never ask.
    fs.writeFileSync(settingsPath, JSON.stringify({ hubConnectorEnabled: true }));
    readDesktopSettings(settingsPath, "0.1.21", {
      hasRetainedHubSession: () => {
        asked += 1;
        return true;
      },
    });
    writeDesktopSettings(settingsPath, DEFAULT_DESKTOP_SETTINGS);
    expect(
      readDesktopSettings(settingsPath, "0.1.21", {
        hasRetainedHubSession: () => {
          asked += 1;
          return true;
        },
      }).hubConnectorDisabledByUser,
    ).toBe(false);
    expect(asked).toBe(1);
  });

  it("claims the node in the background only for a connector the operator turned on", () => {
    // Standby runs the connector so the user's own sign-in can claim the node;
    // it is not consent to claim it at startup.
    expect(desktopHubAllowsBackgroundNodeClaim(DEFAULT_DESKTOP_SETTINGS)).toBe(false);
    const turnedOn = setDesktopHubPreference(DEFAULT_DESKTOP_SETTINGS, { enabled: true });
    expect(desktopHubAllowsBackgroundNodeClaim(turnedOn)).toBe(true);
    expect(
      desktopHubAllowsBackgroundNodeClaim(setDesktopHubPreference(turnedOn, { enabled: false })),
    ).toBe(false);
    expect(desktopHubAllowsBackgroundNodeClaim({ ...turnedOn, hubOrigin: null })).toBe(false);
  });

  it("restarts only for launch changes the running backend cannot already serve", () => {
    const standby = resolveDesktopHubConnectorLaunch(DEFAULT_DESKTOP_SETTINGS);
    const enabled = resolveDesktopHubConnectorLaunch(
      setDesktopHubPreference(DEFAULT_DESKTOP_SETTINGS, { enabled: true }),
    );
    // Account setup or enrollment in standby persists an explicit enable.
    expect(desktopHubLaunchNeedsRestart(enabled, standby, true)).toBe(false);
    expect(desktopHubLaunchNeedsRestart(enabled, standby, null)).toBe(false);
    expect(desktopHubLaunchNeedsRestart(standby, standby, false)).toBe(false);

    const disabled = resolveDesktopHubConnectorLaunch(
      setDesktopHubPreference(DEFAULT_DESKTOP_SETTINGS, { enabled: false }),
    );
    expect(desktopHubLaunchNeedsRestart(enabled, disabled, false)).toBe(true);
    expect(desktopHubLaunchNeedsRestart(disabled, standby, true)).toBe(true);
    expect(
      desktopHubLaunchNeedsRestart({ ...enabled, origin: "https://other.example" }, enabled, true),
    ).toBe(true);
    expect(
      desktopHubLaunchNeedsRestart({ ...enabled, nodeName: "Build node" }, enabled, true),
    ).toBe(true);
    expect(
      desktopHubLaunchNeedsRestart({ ...enabled, allowFileSecretStore: true }, enabled, true),
    ).toBe(true);
  });

  it("restarts for an explicit enable that a standby backend resolved to off", () => {
    // Without key custody (or beside an existing identity) the standby
    // connector runs off. Account setup's explicit enable then read as served,
    // leaving a signed-in account, an unclaimed node, and no way forward.
    const standby = resolveDesktopHubConnectorLaunch(DEFAULT_DESKTOP_SETTINGS);
    const enabled = resolveDesktopHubConnectorLaunch(
      setDesktopHubPreference(DEFAULT_DESKTOP_SETTINGS, { enabled: true }),
    );
    expect(desktopHubLaunchNeedsRestart(enabled, standby, false)).toBe(true);
    // Saved settings that still ask for standby resolve the same way again.
    expect(desktopHubLaunchNeedsRestart(standby, standby, false)).toBe(false);
  });

  it("keeps a reachable or working node awake by default and persists an opt-out", () => {
    expect(DEFAULT_DESKTOP_SETTINGS.keepAwakeMode).toBe("reachable-or-working");
    const settingsPath = makeSettingsPath();
    // Settings written before the preference existed keep the default.
    fs.writeFileSync(settingsPath, JSON.stringify({ hubConnectorEnabled: true }));
    expect(readDesktopSettings(settingsPath, "0.1.21").keepAwakeMode).toBe("reachable-or-working");

    const optedOut = setDesktopKeepAwakeMode(DEFAULT_DESKTOP_SETTINGS, "off");
    writeDesktopSettings(settingsPath, optedOut);
    expect(readDesktopSettings(settingsPath, "0.1.21").keepAwakeMode).toBe("off");
    expect(setDesktopKeepAwakeMode(optedOut, "off")).toBe(optedOut);
  });

  it("migrates the legacy keep-awake boolean", () => {
    const settingsPath = makeSettingsPath();
    const read = (stored: Record<string, unknown>) => {
      fs.writeFileSync(settingsPath, JSON.stringify(stored));
      return readDesktopSettings(settingsPath, "0.1.36").keepAwakeMode;
    };
    // An explicit opt-out was a choice and stays one.
    expect(read({ keepAwakeWhileReachable: false })).toBe("off");
    // `true` was the default every write stored, not a choice: it gets today's default.
    expect(read({ keepAwakeWhileReachable: true })).toBe("reachable-or-working");
    expect(read({})).toBe("reachable-or-working");
    // A stored mode wins over the legacy boolean written beside it.
    expect(read({ keepAwakeMode: "reachable", keepAwakeWhileReachable: true })).toBe("reachable");
    expect(read({ keepAwakeMode: "off", keepAwakeWhileReachable: false })).toBe("off");
    // An unreadable mode falls back to the legacy rule instead of failing the whole file.
    expect(read({ keepAwakeMode: "bogus", keepAwakeWhileReachable: false })).toBe("off");
    expect(read({ keepAwakeMode: 7, hubConnectorEnabled: true })).toBe("reachable-or-working");
  });

  it("writes the legacy boolean beside the mode for a downgraded desktop", () => {
    const settingsPath = makeSettingsPath();
    const stored = (mode: "off" | "reachable" | "reachable-or-working") => {
      writeDesktopSettings(settingsPath, setDesktopKeepAwakeMode(DEFAULT_DESKTOP_SETTINGS, mode));
      return JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    };
    expect(stored("off")).toMatchObject({ keepAwakeMode: "off", keepAwakeWhileReachable: false });
    expect(stored("reachable")).toMatchObject({
      keepAwakeMode: "reachable",
      keepAwakeWhileReachable: true,
    });
    expect(stored("reachable-or-working")).toMatchObject({
      keepAwakeMode: "reachable-or-working",
      keepAwakeWhileReachable: true,
    });
    // Read back, the legacy field does not leak into the in-memory settings.
    expect(readDesktopSettings(settingsPath, "0.1.36")).not.toHaveProperty(
      "keepAwakeWhileReachable",
    );
  });

  it("keeps a chosen mode through a desktop that predates modes", () => {
    const settingsPath = makeSettingsPath();
    const read = () => readDesktopSettings(settingsPath, "0.1.36-nightly.20261024.1").keepAwakeMode;
    // An older desktop keeps only the fields it knows, so its next write drops the mode.
    const writeAsOlderDesktop = (changes: Record<string, unknown> = {}) => {
      const { keepAwakeMode: _dropped, ...known } = JSON.parse(
        fs.readFileSync(settingsPath, "utf8"),
      ) as Record<string, unknown>;
      fs.writeFileSync(settingsPath, JSON.stringify({ ...known, ...changes }));
    };

    writeDesktopSettings(
      settingsPath,
      setDesktopKeepAwakeMode(DEFAULT_DESKTOP_SETTINGS, "reachable"),
    );
    writeAsOlderDesktop({ updateChannel: "latest", updateChannelConfiguredByUser: true });
    expect(read()).toBe("reachable");
    // Turned off there, it stays off; turned back on, the chosen mode returns.
    writeAsOlderDesktop({ keepAwakeWhileReachable: false });
    expect(read()).toBe("off");
    writeAsOlderDesktop({ keepAwakeWhileReachable: true });
    expect(read()).toBe("reachable");

    // An Off the older desktop turned back on gets the default, like any legacy `true`.
    writeDesktopSettings(settingsPath, setDesktopKeepAwakeMode(DEFAULT_DESKTOP_SETTINGS, "off"));
    writeAsOlderDesktop({ keepAwakeWhileReachable: true });
    expect(read()).toBe("reachable-or-working");

    // The remembered mode is only a hint: an unreadable one never fails the settings.
    writeDesktopSettings(
      settingsPath,
      setDesktopKeepAwakeMode(DEFAULT_DESKTOP_SETTINGS, "reachable"),
    );
    fs.writeFileSync(path.join(path.dirname(settingsPath), "desktop-keep-awake.json"), "{");
    writeAsOlderDesktop();
    expect(read()).toBe("reachable-or-working");
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
      backendPort: null,
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
      keepAwakeMode: "reachable-or-working",
      hubConnectorEnabled: false,
      hubConnectorDisabledByUser: false,
      hubOrigin: DEFAULT_DESKTOP_SETTINGS.hubOrigin,
      hubNodeName: null,
      hubAllowFileSecretStore: false,
      backendPort: null,
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

describe("desktop backend port persistence", () => {
  it("remembers the last served port and drops an invalid one", () => {
    const settingsPath = makeSettingsPath();
    writeDesktopSettings(settingsPath, { ...DEFAULT_DESKTOP_SETTINGS, backendPort: 7927 });
    expect(readDesktopSettings(settingsPath, "0.0.17").backendPort).toBe(7927);

    fs.writeFileSync(settingsPath, JSON.stringify({ backendPort: "7927" }), "utf8");
    expect(readDesktopSettings(settingsPath, "0.0.17").backendPort).toBeNull();
  });
});

describe("desktop settings from before Ryco Nightly", () => {
  it("ignores a stored update track: the app's flavor decides its channel", () => {
    const settingsPath = makeSettingsPath();
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ updateChannel: "nightly", updateChannelConfiguredByUser: true }),
      "utf8",
    );
    const settings = readDesktopSettings(settingsPath, "0.1.36");
    expect(settings).not.toHaveProperty("updateChannel");
    expect(settings).not.toHaveProperty("updateChannelConfiguredByUser");
    writeDesktopSettings(settingsPath, settings);
    expect(fs.readFileSync(settingsPath, "utf8")).not.toContain("updateChannel");
  });
});

describe("Ryco Nightly desktop defaults", () => {
  it("serves Tailscale on its own port, so turning Serve on never replaces Ryco's", () => {
    expect(
      resolveDefaultDesktopSettings("0.1.38-nightly.20261101.4", "nightly").tailscaleServePort,
    ).toBe(8443);
    expect(resolveDefaultDesktopSettings("0.1.37").tailscaleServePort).toBe(443);
    const settingsPath = makeSettingsPath();
    fs.writeFileSync(settingsPath, JSON.stringify({ tailscaleServeEnabled: true }), "utf8");
    expect(
      readDesktopSettings(settingsPath, "0.1.38-nightly.20261101.4", undefined, "nightly")
        .tailscaleServePort,
    ).toBe(8443);
  });

  it("names Ryco Nightly's Hub node apart unless the user chose a name", () => {
    const settings = { ...DEFAULT_DESKTOP_SETTINGS, hubConnectorEnabled: true };
    expect(resolveDesktopHubConnectorLaunch(settings, "studio Nightly").nodeName).toBe(
      "studio Nightly",
    );
    expect(
      resolveDesktopHubConnectorLaunch({ ...settings, hubNodeName: "My box" }, "studio Nightly")
        .nodeName,
    ).toBe("My box");
    expect(resolveDesktopHubConnectorLaunch(settings).nodeName).toBeNull();
  });
});
