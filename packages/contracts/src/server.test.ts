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

  describe("rateLimits windows and read time", () => {
    const base = {
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      enabled: true,
      installed: true,
      version: "2.1.296",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    };

    it("decodes every reported window, the read time and the stale marker", () => {
      const parsed = decodeServerProvider({
        ...base,
        rateLimits: {
          limitId: "claude-oauth",
          primary: { usedPercent: 42, windowDurationMins: 300 },
          windows: [
            { id: "five_hour", usedPercent: 42, windowDurationMins: 300 },
            {
              id: "seven_day_opus",
              scope: "Opus",
              usedPercent: 12,
              resetsAt: 1_700_000_000,
              windowDurationMins: 10_080,
            },
          ],
          observedAt: "2026-04-10T00:20:00.000Z",
          stale: true,
          staleReason: "rateLimited",
        },
      });

      expect(parsed.rateLimits).toEqual({
        limitId: "claude-oauth",
        primary: { usedPercent: 42, windowDurationMins: 300 },
        windows: [
          { id: "five_hour", usedPercent: 42, windowDurationMins: 300 },
          {
            id: "seven_day_opus",
            scope: "Opus",
            usedPercent: 12,
            resetsAt: 1_700_000_000,
            windowDurationMins: 10_080,
          },
        ],
        observedAt: "2026-04-10T00:20:00.000Z",
        stale: true,
        staleReason: "rateLimited",
      });
    });

    it("leaves the new keys absent on a payload from an older server", () => {
      const parsed = decodeServerProvider({
        ...base,
        rateLimits: { limitId: "claude-oauth", primary: { usedPercent: 42 } },
      });

      expect(parsed.rateLimits).toEqual({ limitId: "claude-oauth", primary: { usedPercent: 42 } });
      for (const key of ["windows", "observedAt", "stale", "staleReason"]) {
        expect(key in parsed.rateLimits!).toBe(false);
      }
    });

    it("drops keys a newer server adds inside a window", () => {
      const parsed = decodeServerProvider({
        ...base,
        rateLimits: {
          windows: [{ id: "credits", usedPercent: 3, unit: "credits", tier: { name: "x" } }],
        },
      });

      expect(parsed.rateLimits?.windows).toEqual([{ id: "credits", usedPercent: 3 }]);
    });
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

  describe("updateRequiredModels", () => {
    const base = {
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      enabled: true,
      installed: true,
      version: "2.1.218",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-28T00:00:00.000Z",
      models: [],
    };

    it("decodes the models a CLI update unlocks", () => {
      const parsed = decodeServerProvider({
        ...base,
        updateRequiredModels: [
          { slug: "claude-opus-5", name: "Claude Opus 5", minVersion: "2.1.219" },
          { slug: "claude-fable-5-1", name: "Claude Fable 5.1", minVersion: "2.1.257" },
        ],
      });

      expect(parsed.updateRequiredModels).toEqual([
        { slug: "claude-opus-5", name: "Claude Opus 5", minVersion: "2.1.219" },
        { slug: "claude-fable-5-1", name: "Claude Fable 5.1", minVersion: "2.1.257" },
      ]);
    });

    it("leaves the key absent for snapshots from servers that never send it", () => {
      expect("updateRequiredModels" in decodeServerProvider(base)).toBe(false);
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
