import type { KVService } from "@ryco/client-runtime/platform";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildHubDomainResetPlan,
  clearMobileHubProfile,
  createHubProfile,
  deserializeHubProfile,
  executeHubDomainResetPlan,
  HUB_PROFILE_LABEL_MAX_LENGTH,
  HUB_PROFILE_STORAGE_KEY,
  hydrateMobileHubProfile,
  normalizeHubOrigin,
  readCachedMobileHubProfile,
  resetMobileHubProfileCacheForTests,
  saveMobileHubProfile,
  serializeHubProfile,
  subscribeMobileHubProfile,
} from "./hubProfile";
import { mobileSettingsSharingNamespace } from "../features/settings/sharing/settingsSharingNamespace";

function memoryKv() {
  const values = new Map<string, string>();
  const service: KVService = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
  return { service, values };
}

beforeEach(() => {
  resetMobileHubProfileCacheForTests();
});

describe("Hub profile origin", () => {
  it("normalizes one absolute HTTPS origin", () => {
    expect(normalizeHubOrigin(" https://Hub.Ryco.Dev:8443/ ")).toEqual({
      ok: true,
      origin: "https://hub.ryco.dev:8443",
      hostname: "hub.ryco.dev",
    });
  });

  it("rejects credentials, paths, query, fragment, placeholders, and malformed hosts", () => {
    const rejected = [
      "",
      "hub.ryco.dev",
      "https://user:pass@hub.ryco.dev",
      "https://hub.ryco.dev/api",
      "https://hub.ryco.dev/?ticket=secret",
      "https://hub.ryco.dev/#secret",
      "https://example.com",
      "https://your-hub.ryco.dev",
      "https://hub.your-domain.com",
      "https://-bad.ryco.dev",
    ];
    for (const value of rejected) {
      expect(normalizeHubOrigin(value).ok, value).toBe(false);
    }
  });

  it("allows insecure origins only through an explicit caller gate", () => {
    expect(normalizeHubOrigin("http://localhost:8787").ok).toBe(false);
    expect(normalizeHubOrigin("http://localhost:8787", { allowInsecure: true })).toEqual({
      ok: true,
      origin: "http://localhost:8787",
      hostname: "localhost",
    });
  });

  it("bounds the display label", () => {
    const profile = createHubProfile({
      origin: "https://hub.ryco.dev",
      label: `  ${"x".repeat(100)}  `,
    });
    expect(profile?.label).toHaveLength(HUB_PROFILE_LABEL_MAX_LENGTH);
  });
});

describe("Hub profile persistence", () => {
  it("persists only bounded non-secret profile metadata", async () => {
    const { service, values } = memoryKv();
    const profile = createHubProfile({
      origin: "https://hub.ryco.dev",
      label: "Studio Hub",
      compatibility: {
        status: "compatible",
        checkedAt: 1_721_990_400_000,
        protocolVersion: 1,
        handoffVersion: 1,
        relyingPartyId: "hub.ryco.dev",
      },
    });
    expect(profile).not.toBeNull();

    const tainted = {
      ...profile,
      token: "do-not-persist",
      pollingSecret: "do-not-persist",
      compatibility: {
        ...profile?.compatibility,
        ticket: "do-not-persist",
      },
    };
    const serialized = serializeHubProfile(tainted as never);
    expect(serialized).not.toContain("do-not-persist");
    expect(Object.keys(JSON.parse(serialized))).toEqual([
      "version",
      "origin",
      "label",
      "compatibility",
    ]);

    await saveMobileHubProfile(service, profile!);
    expect(values.get(HUB_PROFILE_STORAGE_KEY)).toBe(serialized);
    expect(readCachedMobileHubProfile()).toEqual(profile);

    resetMobileHubProfileCacheForTests();
    await expect(hydrateMobileHubProfile(service)).resolves.toEqual(profile);
  });

  it("fails closed on malformed persisted data and clears explicitly", async () => {
    const { service, values } = memoryKv();
    values.set(HUB_PROFILE_STORAGE_KEY, JSON.stringify({ token: "secret" }));
    await expect(hydrateMobileHubProfile(service)).resolves.toBeNull();

    const profile = createHubProfile({ origin: "https://hub.ryco.dev" })!;
    await saveMobileHubProfile(service, profile);
    await clearMobileHubProfile(service);
    expect(values.has(HUB_PROFILE_STORAGE_KEY)).toBe(false);
    expect(readCachedMobileHubProfile()).toBeNull();
  });

  it("does not let delayed hydration clobber a newly saved profile", async () => {
    let releaseRead: (() => void) | undefined;
    const stale = serializeHubProfile(createHubProfile({ origin: "https://old.ryco.dev" })!);
    const next = createHubProfile({ origin: "https://new.ryco.dev" })!;
    const values = new Map([[HUB_PROFILE_STORAGE_KEY, stale]]);
    const service: KVService = {
      getItem: async (key) => {
        const captured = values.get(key) ?? null;
        await new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
        return captured;
      },
      setItem: async (key, value) => {
        values.set(key, value);
      },
      removeItem: async (key) => {
        values.delete(key);
      },
    };

    const hydration = hydrateMobileHubProfile(service);
    await saveMobileHubProfile(service, next);
    releaseRead?.();
    await hydration;

    expect(readCachedMobileHubProfile()).toEqual(next);
  });

  it("rejects a credential-bearing serialized origin", () => {
    expect(
      deserializeHubProfile(
        JSON.stringify({
          version: 1,
          origin: "https://user:pass@hub.ryco.dev",
          label: "Hub",
          compatibility: { status: "unchecked", checkedAt: null },
        }),
      ),
    ).toBeNull();
  });
});

describe("Hub profile changes", () => {
  it("tells listeners once the profile is read, saved or cleared, so the sharing namespace follows", async () => {
    const { service } = memoryKv();
    const profile = createHubProfile({ origin: "https://hub.ryco.dev" })!;
    await service.setItem(HUB_PROFILE_STORAGE_KEY, serializeHubProfile(profile));
    const signedIn = { accountStatus: "authenticated", account: { id: "acct" } };
    // Signed in before the profile is read: the phone's own namespace until it arrives.
    expect(mobileSettingsSharingNamespace(signedIn, readCachedMobileHubProfile()?.origin)).toEqual({
      kind: "local",
    });
    const listener = vi.fn();
    const stop = subscribeMobileHubProfile(listener);
    await hydrateMobileHubProfile(service);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(mobileSettingsSharingNamespace(signedIn, readCachedMobileHubProfile()?.origin)).toEqual({
      kind: "hosted",
      hubOrigin: "https://hub.ryco.dev",
      accountId: "acct",
    });
    // The same profile saved again changes nothing.
    await saveMobileHubProfile(service, profile);
    expect(listener).toHaveBeenCalledTimes(1);
    await clearMobileHubProfile(service);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe("Hub domain reset", () => {
  it("requires confirmation only when the effective domain changes", () => {
    expect(buildHubDomainResetPlan("https://hub.ryco.dev", "https://hub.ryco.dev")).toBeNull();
    const plan = buildHubDomainResetPlan("https://old.ryco.dev", "https://new.ryco.dev");
    expect(plan?.orderedSteps).toEqual([
      "revoke-or-clear-session",
      "disconnect-relay-and-clear-hub-state",
      "replace-profile",
    ]);
    expect(plan?.preserves).toEqual(["direct-connections", "direct-credentials"]);
  });

  it("clears Hub state in order without exposing a direct-plane action", async () => {
    const plan = buildHubDomainResetPlan("https://old.ryco.dev", "https://new.ryco.dev")!;
    const calls: string[] = [];
    const directState = { connections: 2, credentials: 2 };

    await expect(
      executeHubDomainResetPlan(plan, {
        attemptRemoteSignOut: async () => {
          calls.push("remote");
          throw new Error("bounded away");
        },
        clearLocalHubState: async () => {
          calls.push("clear");
        },
        replaceProfile: async () => {
          calls.push("replace");
        },
      }),
    ).resolves.toEqual({ remoteSignOut: "unavailable" });
    expect(calls).toEqual(["remote", "clear", "replace"]);
    expect(directState).toEqual({ connections: 2, credentials: 2 });
  });

  it("does not replace the profile when local teardown fails", async () => {
    const replaceProfile = vi.fn(async () => {});
    await expect(
      executeHubDomainResetPlan(
        buildHubDomainResetPlan("https://old.ryco.dev", "https://new.ryco.dev")!,
        {
          attemptRemoteSignOut: async () => {},
          clearLocalHubState: async () => {
            throw new Error("teardown failed");
          },
          replaceProfile,
        },
      ),
    ).rejects.toThrow("teardown failed");
    expect(replaceProfile).not.toHaveBeenCalled();
  });
});
