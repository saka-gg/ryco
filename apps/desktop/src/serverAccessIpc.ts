import type {
  DesktopHubLaunchConfigResult,
  DesktopKeepAwakeState,
  DesktopServerExposureMode,
  DesktopServerExposureState,
} from "@ryco/contracts";
import { normalizeHubNodeName } from "@ryco/shared/nodeIdentity";

import { handleAppInvoke } from "./appInvoke.ts";
import {
  isDesktopHostedIdentitySupported,
  isDesktopHubFileSecretStoreSupported,
  isDesktopKeepAwakeMode,
  planDesktopServerExposureChange,
  planDesktopTailscaleServeChange,
  setDesktopHubPreference,
  setDesktopKeepAwakeMode,
  type DesktopSettings,
  type DesktopTailscaleServeLaunch,
} from "./desktopSettings.ts";
import { validateHubOrigin } from "./hubOrigin.ts";
import {
  GET_SERVER_EXPOSURE_STATE_CHANNEL,
  SET_SERVER_EXPOSURE_MODE_CHANNEL,
  SET_TAILSCALE_SERVE_ENABLED_CHANNEL,
  GET_ADVERTISED_ENDPOINTS_CHANNEL,
  GET_KEEP_AWAKE_STATE_CHANNEL,
  SET_KEEP_AWAKE_MODE_CHANNEL,
  GET_HUB_LAUNCH_CONFIG_CHANNEL,
  SET_HUB_LAUNCH_CONFIG_CHANNEL,
  VALIDATE_HUB_ORIGIN_CHANNEL,
  RESTART_APP_CHANNEL,
} from "./desktopIpcChannels.ts";

/** What the server exposure, keep-awake and Hub launch channels need from main. */
export interface ServerAccessIpcDeps {
  readonly desktopSettings: () => DesktopSettings;
  /** Writes the settings file, then publishes `next` as main's current settings. */
  readonly commitDesktopSettings: (next: DesktopSettings) => void;
  /** The exposure mode the running backend serves. */
  readonly desktopServerExposureMode: () => DesktopServerExposureMode;
  readonly getDesktopServerExposureState: () => DesktopServerExposureState;
  readonly applyDesktopServerExposureMode: (
    mode: DesktopServerExposureMode,
    options: { readonly persist: boolean; readonly rejectIfUnavailable: boolean },
  ) => Promise<DesktopServerExposureState>;
  readonly assertDesktopServerExposureServable: (mode: DesktopServerExposureMode) => void;
  readonly getDesktopAdvertisedEndpoints: () => Promise<unknown>;
  readonly runningTailscaleServe: () => DesktopTailscaleServeLaunch;
  readonly desktopKeepAwakeState: () => DesktopKeepAwakeState;
  /** Holds or releases the keep-awake assertion now; undefined before it exists. */
  readonly syncDesktopKeepAwake: () => DesktopKeepAwakeState | undefined;
  readonly backendHubLaunch: () => { readonly standby: boolean } | null;
  readonly backendHubConnectorEnabled: () => boolean | null;
  readonly refreshDesktopHubReachability: () => Promise<void>;
  readonly desktopHubRestartRequired: (settings?: DesktopSettings) => boolean;
  readonly relaunchDesktopApp: (reason: string) => void;
}

/** `{ deferRelaunch }` from a renderer: save the change, the caller relaunches later. */
function readDeferRelaunch(raw: unknown, invalid: string): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== "object") throw new Error(invalid);
  const value = (raw as { readonly deferRelaunch?: unknown }).deferRelaunch;
  if (value !== undefined && typeof value !== "boolean") throw new Error(invalid);
  return value === true;
}

/** Server exposure, Tailscale Serve, keep-awake, the Hub launch configuration and app restart. */
export function registerServerAccessIpc(deps: ServerAccessIpcDeps): void {
  handleAppInvoke(
    GET_SERVER_EXPOSURE_STATE_CHANNEL,
    async () => deps.getDesktopServerExposureState(),
    {
      requireMainFrame: false,
    },
  );

  handleAppInvoke(
    SET_SERVER_EXPOSURE_MODE_CHANNEL,
    async (_event, rawMode: unknown, rawOptions: unknown) => {
      if (rawMode !== "local-only" && rawMode !== "network-accessible") {
        throw new Error("Invalid desktop server exposure input.");
      }
      const deferRelaunch = readDeferRelaunch(rawOptions, "Invalid desktop server exposure input.");

      const nextMode = rawMode as DesktopServerExposureMode;
      // Measured against the running mode, not only the saved one: a deferred
      // change leaves the two apart until the relaunch.
      const plan = planDesktopServerExposureChange({
        settings: deps.desktopSettings(),
        running: deps.desktopServerExposureMode(),
        requested: nextMode,
        deferRelaunch,
      });
      if (plan.relaunch) {
        const nextState = await deps.applyDesktopServerExposureMode(nextMode, {
          persist: true,
          rejectIfUnavailable: true,
        });
        deps.relaunchDesktopApp(`serverExposureMode=${nextMode}`);
        return nextState;
      }
      if (plan.settings !== deps.desktopSettings()) {
        // Saved now so quitting or crashing before the relaunch cannot drop
        // it; the running backend keeps its listener until then. Asking for
        // the running mode withdraws a saved change and is always allowed.
        if (nextMode !== deps.desktopServerExposureMode())
          deps.assertDesktopServerExposureServable(nextMode);
        deps.commitDesktopSettings(plan.settings);
      }
      return deps.getDesktopServerExposureState();
    },
    { requireMainFrame: false },
  );

  handleAppInvoke(GET_KEEP_AWAKE_STATE_CHANNEL, () => deps.desktopKeepAwakeState(), {
    requireMainFrame: false,
  });

  handleAppInvoke(
    SET_KEEP_AWAKE_MODE_CHANNEL,
    (_event, rawMode: unknown) => {
      if (!isDesktopKeepAwakeMode(rawMode)) {
        throw new Error("Invalid keep-awake input.");
      }
      const nextSettings = setDesktopKeepAwakeMode(deps.desktopSettings(), rawMode);
      if (nextSettings !== deps.desktopSettings()) {
        deps.commitDesktopSettings(nextSettings);
      }
      // Live: holding or releasing the assertion needs no backend restart.
      return deps.syncDesktopKeepAwake() ?? deps.desktopKeepAwakeState();
    },
    { requireMainFrame: false },
  );

  handleAppInvoke(
    GET_HUB_LAUNCH_CONFIG_CHANNEL,
    async () => {
      // Whether a standby backend runs its connector decides `restartRequired`.
      if (deps.backendHubLaunch()?.standby === true && deps.backendHubConnectorEnabled() === null) {
        await deps.refreshDesktopHubReachability();
      }
      return {
        enabled: deps.desktopSettings().hubConnectorEnabled,
        origin: deps.desktopSettings().hubOrigin,
        nodeName: deps.desktopSettings().hubNodeName,
        allowFileSecretStore: deps.desktopSettings().hubAllowFileSecretStore,
        fileSecretStoreFallbackSupported: isDesktopHubFileSecretStoreSupported(process.platform),
        hostedIdentitySupported: isDesktopHostedIdentitySupported(process.platform),
        restartRequired: deps.desktopHubRestartRequired(),
      };
    },
    { requireMainFrame: false },
  );

  handleAppInvoke(
    VALIDATE_HUB_ORIGIN_CHANNEL,
    (_event, raw: unknown) => validateHubOrigin(typeof raw === "string" ? raw : ""),
    { requireMainFrame: false },
  );

  handleAppInvoke(
    SET_HUB_LAUNCH_CONFIG_CHANNEL,
    async (_event, rawInput: unknown): Promise<DesktopHubLaunchConfigResult> => {
      if (typeof rawInput !== "object" || rawInput === null) {
        throw new Error("Invalid Hub launch configuration input.");
      }
      const input = rawInput as {
        readonly enabled?: unknown;
        readonly origin?: unknown;
        readonly nodeName?: unknown;
        readonly allowFileSecretStore?: unknown;
        readonly applyOnNextLaunch?: unknown;
        readonly deferRelaunch?: unknown;
      };
      if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
        throw new Error("Invalid Hub launch configuration input.");
      }
      const deferRelaunch = readDeferRelaunch(input, "Invalid Hub launch configuration input.");
      if (input.applyOnNextLaunch !== undefined && typeof input.applyOnNextLaunch !== "boolean") {
        throw new Error("Invalid Hub launch configuration input.");
      }
      if (input.applyOnNextLaunch === true) {
        // Only an explicit enable of a connector the running backend already
        // runs in standby may skip the relaunch. Anything else changes what the
        // running backend serves, so it must still restart.
        if (
          input.enabled !== true ||
          input.origin !== undefined ||
          input.nodeName !== undefined ||
          input.allowFileSecretStore !== undefined ||
          deferRelaunch
        ) {
          throw new Error("Invalid Hub launch configuration input.");
        }
        // Already explicit: nothing is left to record.
        if (
          deps.desktopSettings().hubOrigin !== null &&
          deps.desktopSettings().hubConnectorEnabled
        ) {
          return { relaunching: false };
        }
        if (deps.backendHubLaunch()?.standby !== true) {
          throw new Error("Invalid Hub launch configuration input.");
        }
        const nextSettings = setDesktopHubPreference(deps.desktopSettings(), { enabled: true });
        if (nextSettings !== deps.desktopSettings()) {
          deps.commitDesktopSettings(nextSettings);
          deps.syncDesktopKeepAwake();
        }
        return { relaunching: false };
      }
      if (
        input.allowFileSecretStore !== undefined &&
        typeof input.allowFileSecretStore !== "boolean"
      ) {
        throw new Error("Invalid Hub launch configuration input.");
      }
      if (
        input.allowFileSecretStore === true &&
        !isDesktopHubFileSecretStoreSupported(process.platform)
      ) {
        throw new Error("Permissioned-file Hub key storage is unavailable on this platform.");
      }

      let origin: string | null | undefined;
      if (input.origin === null) {
        origin = null;
      } else if (typeof input.origin === "string") {
        // Validate in main, not in the renderer: the renderer cannot import
        // `@ryco/shared/nodeIdentity` because it pulls in `node:crypto`, and a
        // value that reaches the connector unvalidated fails closed at startup
        // with an opaque `configuration_invalid`.
        const validation = validateHubOrigin(input.origin);
        if (!validation.ok) throw new Error("Invalid Hub address.");
        origin = validation.origin;
      } else if (input.origin !== undefined) {
        throw new Error("Invalid Hub launch configuration input.");
      }

      let nodeName: string | null | undefined;
      if (input.nodeName === null) {
        nodeName = null;
      } else if (typeof input.nodeName === "string") {
        try {
          nodeName = normalizeHubNodeName(input.nodeName);
        } catch {
          throw new Error("Invalid Hub node name.");
        }
      } else if (input.nodeName !== undefined) {
        throw new Error("Invalid Hub launch configuration input.");
      }

      const nextSettings = setDesktopHubPreference(deps.desktopSettings(), {
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(origin === undefined ? {} : { origin }),
        ...(nodeName === undefined ? {} : { nodeName }),
        ...(input.allowFileSecretStore === undefined
          ? {}
          : { allowFileSecretStore: input.allowFileSecretStore }),
      });
      // An explicit enable of a standby backend still restarts: the renderer
      // only offers Enable when the connector reports itself off, which for a
      // standby launch means an existing identity kept it disabled.
      const restart =
        deps.desktopHubRestartRequired(nextSettings) ||
        (input.enabled === true && deps.backendHubLaunch()?.standby === true);
      if (nextSettings === deps.desktopSettings() && !restart) return { relaunching: false };

      // Persist before publishing the new in-memory value. If the atomic write
      // fails, an identical retry must still attempt the write and relaunch.
      if (nextSettings !== deps.desktopSettings()) {
        deps.commitDesktopSettings(nextSettings);
      }
      // Never log the origin or node name: together they identify this machine.
      // A deferred change is saved now and applies with the relaunch the
      // renderer schedules once running turns finish, or on the next launch.
      const relaunching = restart && !deferRelaunch;
      if (relaunching) deps.relaunchDesktopApp("hub-launch-config-changed");
      return { relaunching };
    },
    { requireMainFrame: false },
  );

  handleAppInvoke(
    RESTART_APP_CHANNEL,
    () => {
      deps.relaunchDesktopApp("renderer-requested-restart");
    },
    { requireMainFrame: false },
  );

  handleAppInvoke(
    SET_TAILSCALE_SERVE_ENABLED_CHANNEL,
    async (_event, rawInput: unknown) => {
      if (typeof rawInput !== "object" || rawInput === null) {
        throw new Error("Invalid Tailscale Serve input.");
      }
      const input = rawInput as {
        readonly enabled?: unknown;
        readonly port?: unknown;
        readonly deferRelaunch?: unknown;
      };
      if (typeof input.enabled !== "boolean") {
        throw new Error("Invalid Tailscale Serve input.");
      }
      const deferRelaunch = readDeferRelaunch(input, "Invalid Tailscale Serve input.");
      // Measured against what the running backend serves, not only what is
      // saved: a deferred change leaves the two apart until the relaunch.
      const plan = planDesktopTailscaleServeChange({
        settings: deps.desktopSettings(),
        running: deps.runningTailscaleServe(),
        requested: {
          enabled: input.enabled,
          ...(typeof input.port === "number" ? { port: input.port } : {}),
        },
        deferRelaunch,
      });
      if (plan.settings !== deps.desktopSettings()) {
        // Saved first; a deferred change keeps the running backend as it is.
        deps.commitDesktopSettings(plan.settings);
      }
      if (plan.relaunch) {
        deps.relaunchDesktopApp(
          deps.desktopSettings().tailscaleServeEnabled
            ? "tailscale-serve-enabled"
            : "tailscale-serve-disabled",
        );
      }
      return deps.getDesktopServerExposureState();
    },
    { requireMainFrame: false },
  );

  handleAppInvoke(
    GET_ADVERTISED_ENDPOINTS_CHANNEL,
    async () => deps.getDesktopAdvertisedEndpoints(),
    {
      requireMainFrame: false,
    },
  );
}
