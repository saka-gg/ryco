import { describe, expect, it } from "vitest";
import type { DesktopHubLaunchConfig, HubIdentitySummary } from "@ryco/contracts";

import {
  consumeHubEnrollmentIntent,
  ENROLL_AFTER_ENABLE_TTL_MS,
  offeredHubAction,
  presentHubSetup,
  recordHubEnrollmentIntent,
} from "./hubSetup.logic";

const config = (overrides: Partial<DesktopHubLaunchConfig> = {}): DesktopHubLaunchConfig => ({
  enabled: false,
  origin: "https://app.ryco.space",
  nodeName: null,
  allowFileSecretStore: false,
  fileSecretStoreFallbackSupported: true,
  hostedIdentitySupported: true,
  ...overrides,
});

const identity = (enrolled: HubIdentitySummary["enrolled"]): HubIdentitySummary => ({ enrolled });

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

describe("presentHubSetup", () => {
  it("waits on native account setup on macOS before enrolment", () => {
    for (const action of ["enable", "enroll"] as const) {
      expect(
        presentHubSetup({
          config: config(),
          bridgeOffersAccountSetup: true,
          identity: identity("none"),
          action,
        }),
      ).toEqual({
        path: "native-account",
        showAccountRow: true,
        automaticNativeSetup: true,
        automaticNativeSetupWaiting: true,
      });
    }
  });

  it("offers the device-code ceremony where native account setup cannot run", () => {
    // Linux and Windows preloads still expose the account bridge methods; the
    // fresh-install default is a disabled connector, so the panel used to hide
    // Enable and Start enrollment behind an account flow that always fails.
    for (const action of ["enable", "enroll"] as const) {
      expect(
        presentHubSetup({
          config: config({ hostedIdentitySupported: false }),
          bridgeOffersAccountSetup: true,
          identity: identity("none"),
          action,
        }),
      ).toEqual({
        path: "device-code",
        showAccountRow: false,
        automaticNativeSetup: false,
        automaticNativeSetupWaiting: false,
      });
    }
  });

  it("treats a missing launch answer as unsupported rather than waiting forever", () => {
    expect(
      presentHubSetup({
        config: { ...config(), hostedIdentitySupported: undefined } as never,
        bridgeOffersAccountSetup: true,
        identity: identity("none"),
        action: "enroll",
      }).automaticNativeSetupWaiting,
    ).toBe(false);
    expect(
      presentHubSetup({
        config: null,
        bridgeOffersAccountSetup: true,
        identity: identity("none"),
        action: "enroll",
      }).path,
    ).toBe("device-code");
  });

  it("stops waiting once the node is enrolled or the bridge has no account setup", () => {
    expect(
      presentHubSetup({
        config: config(),
        bridgeOffersAccountSetup: true,
        identity: identity("active"),
        action: "disable",
      }),
    ).toMatchObject({ path: "native-account", automaticNativeSetupWaiting: false });
    expect(
      presentHubSetup({
        config: config(),
        bridgeOffersAccountSetup: false,
        identity: identity("none"),
        action: "enroll",
      }),
    ).toMatchObject({ path: "device-code", showAccountRow: false });
  });
});

describe("offeredHubAction", () => {
  it("holds enrollment back while saved Hub settings wait on a restart", () => {
    // The running connector enrols against the Hub it launched with; an
    // address saved for the restart would leave the approval on the old Hub.
    expect(
      offeredHubAction({
        action: "enroll",
        automaticNativeSetupWaiting: false,
        restartRequired: true,
      }),
    ).toBe("none");
    expect(
      offeredHubAction({
        action: "enroll",
        automaticNativeSetupWaiting: false,
        restartRequired: false,
      }),
    ).toBe("enroll");
    // Other actions act on what already runs.
    for (const action of ["retry", "leave", "cancel-enrollment", "disable"] as const) {
      expect(
        offeredHubAction({ action, automaticNativeSetupWaiting: false, restartRequired: true }),
      ).toBe(action);
    }
    expect(
      offeredHubAction({
        action: "enable",
        automaticNativeSetupWaiting: true,
        restartRequired: false,
      }),
    ).toBe("none");
  });
});

describe("hub enrollment intent", () => {
  it("is consumed exactly once within its lifetime", () => {
    const storage = memoryStorage();
    recordHubEnrollmentIntent(storage, 1_000);
    expect(consumeHubEnrollmentIntent(storage, 1_000 + ENROLL_AFTER_ENABLE_TTL_MS)).toBe(true);
    expect(consumeHubEnrollmentIntent(storage, 1_000 + ENROLL_AFTER_ENABLE_TTL_MS)).toBe(false);
  });

  it("expires and clears stale or malformed intents", () => {
    const storage = memoryStorage();
    recordHubEnrollmentIntent(storage, 1_000);
    expect(consumeHubEnrollmentIntent(storage, 1_001 + ENROLL_AFTER_ENABLE_TTL_MS)).toBe(false);
    expect(storage.values.size).toBe(0);

    storage.values.set("ryco:hub-enroll-after-enable", "not-a-time");
    expect(consumeHubEnrollmentIntent(storage, 2_000)).toBe(false);
    expect(storage.values.size).toBe(0);

    // A clock that moved backwards is not a fresh intent.
    recordHubEnrollmentIntent(storage, 5_000);
    expect(consumeHubEnrollmentIntent(storage, 4_000)).toBe(false);
  });

  it("tolerates unavailable storage", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => recordHubEnrollmentIntent(throwing, 1)).not.toThrow();
    expect(consumeHubEnrollmentIntent(throwing, 1)).toBe(false);
    expect(consumeHubEnrollmentIntent(null, 1)).toBe(false);
  });
});
