import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_HUB_CONNECTOR_CONFIG, resolveHubConnectorConfig } from "../config.ts";
import {
  hubConnectorConfigWithoutKeyCustody,
  resolveStandbyHubConnectorConfig,
} from "./HubConnectorStandby.ts";
import { hubIdentityHoldsKeyMaterial } from "./HubIdentityRuntime.ts";

const enabled = resolveHubConnectorConfig({
  enabled: "true",
  origin: "https://hub.example.com",
});

describe("resolveStandbyHubConnectorConfig", () => {
  it("runs the connector for a node with no Hub identity yet", async () => {
    // Enabled-but-idle: `enrolling` opens no socket, and the native claim can
    // commit in this process instead of after an onboarding relaunch.
    expect(
      await resolveStandbyHubConnectorConfig({
        config: enabled,
        statePath: "/unused",
        holdsKeyMaterial: async () => false,
      }),
    ).toEqual({ ...enabled, standby: true });
  });

  it("stays disabled for any existing identity or unreadable state", async () => {
    for (const holdsKeyMaterial of [
      async () => true,
      async () => {
        throw new Error("state locked");
      },
    ]) {
      expect(
        await resolveStandbyHubConnectorConfig({
          config: enabled,
          statePath: "/unused",
          holdsKeyMaterial,
        }),
      ).toEqual(DEFAULT_HUB_CONNECTOR_CONFIG);
    }
  });

  it("leaves a disabled or misconfigured standby connector off", async () => {
    let probes = 0;
    const holdsKeyMaterial = async () => {
      probes += 1;
      return false;
    };
    expect(
      await resolveStandbyHubConnectorConfig({
        config: DEFAULT_HUB_CONNECTOR_CONFIG,
        statePath: "/unused",
        holdsKeyMaterial,
      }),
    ).toBe(DEFAULT_HUB_CONNECTOR_CONFIG);
    expect(
      await resolveStandbyHubConnectorConfig({
        config: resolveHubConnectorConfig({ enabled: "true", origin: "http://insecure" }),
        statePath: "/unused",
        holdsKeyMaterial,
      }),
    ).toEqual(DEFAULT_HUB_CONNECTOR_CONFIG);
    expect(probes).toBe(0);
  });

  it("reads real state files: fresh runs, enrolled stays off", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-standby-"));
    const fresh = join(root, "fresh", "hub-identity.json");
    await mkdir(join(root, "fresh"), { recursive: true, mode: 0o700 });
    expect(await resolveStandbyHubConnectorConfig({ config: enabled, statePath: fresh })).toEqual({
      ...enabled,
      standby: true,
    });

    const pending = join(root, "pending", "hub-identity.json");
    await mkdir(join(root, "pending"), { recursive: true, mode: 0o700 });
    await writeFile(
      pending,
      JSON.stringify({
        version: 1,
        revision: 2,
        environmentId: `env_${"E".repeat(22)}`,
        protectedStoreBackend: "os",
        pendingEnrollment: {
          hubOrigin: "https://hub.example.com",
          keySecretName: "node-key.pending",
          pollingSecretName: "node-poll.pending",
          label: null,
          deviceCode: null,
          createdAt: 1,
          expiresAt: null,
          pollIntervalMs: null,
          cleanupRequested: false,
        },
        activeNode: null,
        stagedRotation: null,
        pendingTeardown: null,
      }),
      { mode: 0o600 },
    );
    // Parsed, not merely unreadable: the identity really is in progress.
    expect(await hubIdentityHoldsKeyMaterial({ statePath: pending })).toBe(true);
    expect(await resolveStandbyHubConnectorConfig({ config: enabled, statePath: pending })).toEqual(
      DEFAULT_HUB_CONNECTOR_CONFIG,
    );
  });

  it("keeps a standby connector off, not failing, where key custody cannot be built", async () => {
    // A Linux desktop without a Secret Service used to greet a user who never
    // asked for the Hub with "Can't open a key store for this machine's Hub key".
    const standby = await resolveStandbyHubConnectorConfig({
      config: enabled,
      statePath: "/unused",
      holdsKeyMaterial: async () => false,
    });
    expect(hubConnectorConfigWithoutKeyCustody(standby)).toEqual({ ...standby, enabled: false });
    // An operator who turned the connector on hears about the key store.
    expect(hubConnectorConfigWithoutKeyCustody(enabled)).toBeNull();
  });
});
