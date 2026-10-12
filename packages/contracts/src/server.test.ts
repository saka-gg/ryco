import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { ServerConfigStreamEvent, ServerProvider, ServerSubscribeConfigInput } from "./server.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);

describe("ServerProvider", () => {
  it("defaults capability arrays when decoding provider snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.versionAdvisory).toBeUndefined();
    expect(parsed.updateState).toBeUndefined();
  });

  it("defaults one-click update support when decoding older advisory snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.0.1",
        updateCommand: "npm install -g @openai/codex@latest",
        checkedAt: "2026-04-10T00:00:00.000Z",
        message: "Update available.",
      },
    });

    expect(parsed.versionAdvisory?.canUpdate).toBe(false);
  });

  it("decodes continuation group metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex_personal",
      driver: "codex",
      continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.continuation?.groupKey).toBe("codex:home:/Users/julius/.codex");
  });

  it("decodes the optional rateLimits snapshot", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      rateLimits: {
        limitName: "ChatGPT Pro",
        planType: "pro",
        primary: {
          usedPercent: 42,
          resetsAt: 1_700_000_000,
          windowDurationMins: 300,
        },
        secondary: {
          usedPercent: 7,
          windowDurationMins: 7 * 24 * 60,
        },
      },
    });

    expect(parsed.rateLimits?.limitName).toBe("ChatGPT Pro");
    expect(parsed.rateLimits?.primary).toEqual({
      usedPercent: 42,
      resetsAt: 1_700_000_000,
      windowDurationMins: 300,
    });
    expect(parsed.rateLimits?.secondary?.windowDurationMins).toBe(7 * 24 * 60);
  });

  it("decodes a snapshot without rateLimits as undefined", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.rateLimits).toBeUndefined();
  });

  describe("compatibilityAdvisory", () => {
    const base = {
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "0.199.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    };

    it("decodes a compatibility advisory with both ratings", () => {
      const parsed = decodeServerProvider({
        ...base,
        compatibilityAdvisory: {
          status: "broken",
          latestVersionStatus: "unsupported",
          message: "x",
        },
      });

      expect(parsed.compatibilityAdvisory).toEqual({
        status: "broken",
        latestVersionStatus: "unsupported",
        message: "x",
      });
    });

    it("leaves the key absent when a snapshot has no advisory", () => {
      const parsed = decodeServerProvider(base);

      expect("compatibilityAdvisory" in parsed).toBe(false);
    });

    it("rejects an unknown status because the status set is frozen", () => {
      expect(() =>
        decodeServerProvider({
          ...base,
          compatibilityAdvisory: { status: "weird", message: null },
        }),
      ).toThrow();
    });
  });
});

describe("provider status deltas", () => {
  const decodeEvent = Schema.decodeUnknownSync(ServerConfigStreamEvent);
  const decodeInput = Schema.decodeUnknownSync(ServerSubscribeConfigInput);

  it("decodes a delta whose provider leaves out its unchanged catalogs", () => {
    const event = decodeEvent({
      version: 1,
      type: "providerStatusesDelta",
      payload: {
        instanceIds: ["codex", "claude"],
        providers: [
          {
            instanceId: "codex",
            driver: "codex",
            enabled: true,
            installed: true,
            version: "1.0.0",
            status: "error",
            auth: { status: "authenticated" },
            checkedAt: "2026-10-12T00:00:00.000Z",
          },
        ],
      },
    });
    expect(event.type).toBe("providerStatusesDelta");
    if (event.type !== "providerStatusesDelta") return;
    const [update] = event.payload.providers;
    expect(update && "models" in update).toBe(false);
    expect(update && "skills" in update).toBe(false);
  });

  it("keeps decoding the full provider list older servers send", () => {
    const event = decodeEvent({
      version: 1,
      type: "providerStatuses",
      payload: { providers: [] },
    });
    expect(event.type).toBe("providerStatuses");
  });

  it("accepts the empty subscribe input older clients send, and the delta request", () => {
    expect(decodeInput({})).toEqual({});
    expect(decodeInput({ providerStatuses: "delta" })).toEqual({ providerStatuses: "delta" });
  });

  it("bounds the catalog digests a client may name", () => {
    expect(() =>
      decodeInput({ knownProviderCatalogs: Array.from({ length: 65 }, (_, index) => `d${index}`) }),
    ).toThrow();
    expect(decodeInput({ knownProviderCatalogs: ["digest-a"] })).toEqual({
      knownProviderCatalogs: ["digest-a"],
    });
  });
});
