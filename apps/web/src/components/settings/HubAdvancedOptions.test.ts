import { describe, expect, it } from "vitest";
import type { DesktopHubLaunchConfig, HubIdentitySummary } from "@ryco/contracts";

import { canChangeHubFileSecretStore } from "./HubAdvancedOptions.tsx";

const config = (overrides: Partial<DesktopHubLaunchConfig> = {}): DesktopHubLaunchConfig => ({
  enabled: false,
  origin: null,
  nodeName: null,
  allowFileSecretStore: false,
  fileSecretStoreFallbackSupported: true,
  hostedIdentitySupported: true,
  ...overrides,
});

const identity = (enrolled: HubIdentitySummary["enrolled"]): HubIdentitySummary => ({ enrolled });

describe("canChangeHubFileSecretStore", () => {
  it("allows a supported host with no enrolled identity", () => {
    expect(canChangeHubFileSecretStore(config(), identity("none"))).toBe(true);
  });

  it("locks active and pending identities", () => {
    expect(canChangeHubFileSecretStore(config(), identity("active"))).toBe(false);
    expect(canChangeHubFileSecretStore(config(), identity("pending"))).toBe(false);
  });

  it("only permits the recovery-safe direction for an unreadable identity", () => {
    expect(canChangeHubFileSecretStore(config(), identity("unknown"))).toBe(true);
    expect(
      canChangeHubFileSecretStore(config({ allowFileSecretStore: true }), identity("unknown")),
    ).toBe(false);
  });

  it("keeps unsupported and loading states immutable", () => {
    expect(
      canChangeHubFileSecretStore(
        config({ fileSecretStoreFallbackSupported: false }),
        identity("none"),
      ),
    ).toBe(false);
    expect(canChangeHubFileSecretStore(null, identity("none"))).toBe(false);
    expect(canChangeHubFileSecretStore(config(), null)).toBe(false);
  });
});
