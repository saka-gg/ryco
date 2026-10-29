import {
  ClaudeSettings,
  CodexSettings,
  CopilotSettings,
  CursorSettings,
  GrokSettings,
  OpenCodeSettings,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  ProviderInstanceId,
} from "@ryco/contracts";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@ryco/contracts/settings";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  listEnabledProviderInstances,
  providerInstanceEnvelopeEnabled,
  resolveProviderInstanceEnabled,
} from "./providerInstanceEnablement.ts";

const driver = ProviderDriverKind.make;
const id = ProviderInstanceId.make;

function settingsWith(input: {
  readonly providers?: Partial<
    Record<keyof ServerSettings["providers"], Partial<{ enabled: boolean }>>
  >;
  readonly providerInstances?: Record<string, ProviderInstanceConfig>;
}): Pick<ServerSettings, "providers" | "providerInstances"> {
  const providers = { ...DEFAULT_SERVER_SETTINGS.providers } as Record<string, object>;
  for (const [kind, patch] of Object.entries(input.providers ?? {})) {
    providers[kind] = { ...providers[kind], ...patch };
  }
  return {
    providers: providers as ServerSettings["providers"],
    providerInstances: (input.providerInstances ?? {}) as ServerSettings["providerInstances"],
  };
}

describe("providerInstanceEnvelopeEnabled", () => {
  it("prefers the envelope flag over the config flag", () => {
    expect(
      providerInstanceEnvelopeEnabled({
        driver: driver("codex"),
        enabled: true,
        config: { enabled: false },
      }),
    ).toBe(true);
    expect(
      providerInstanceEnvelopeEnabled({
        driver: driver("codex"),
        enabled: false,
        config: { enabled: true },
      }),
    ).toBe(false);
  });

  it("uses the config flag when the envelope has none", () => {
    expect(
      providerInstanceEnvelopeEnabled({ driver: driver("codex"), config: { enabled: false } }),
    ).toBe(false);
    expect(
      providerInstanceEnvelopeEnabled({ driver: driver("cursor"), config: { enabled: true } }),
    ).toBe(true);
  });

  it("falls back to the driver default", () => {
    expect(providerInstanceEnvelopeEnabled({ driver: driver("cursor"), config: {} })).toBe(false);
    expect(providerInstanceEnvelopeEnabled({ driver: driver("codex") })).toBe(true);
    expect(providerInstanceEnvelopeEnabled({ driver: driver("acpRegistry"), config: {} })).toBe(
      true,
    );
    expect(providerInstanceEnvelopeEnabled({ driver: driver("forkOnly") })).toBe(true);
    // A prototype key is not a driver with a default slot.
    expect(providerInstanceEnvelopeEnabled({ driver: driver("constructor") })).toBe(true);
  });

  it("ignores a config that is not a plain object", () => {
    for (const config of [null, "enabled", ["enabled"], 0]) {
      expect(providerInstanceEnvelopeEnabled({ driver: driver("cursor"), config })).toBe(false);
      expect(providerInstanceEnvelopeEnabled({ driver: driver("codex"), config })).toBe(true);
    }
  });

  it("matches what each driver's config schema decodes", () => {
    const schemas = {
      codex: CodexSettings,
      claudeAgent: ClaudeSettings,
      copilot: CopilotSettings,
      cursor: CursorSettings,
      grok: GrokSettings,
      opencode: OpenCodeSettings,
    } as const;
    // The equivalence the registry relies on: every slot has a schema, and decoding agrees.
    expect(Object.keys(schemas).toSorted()).toEqual(
      Object.keys(DEFAULT_SERVER_SETTINGS.providers).toSorted(),
    );
    for (const [kind, schema] of Object.entries(schemas)) {
      for (const config of [{}, { enabled: true }, { enabled: false }]) {
        const decoded = Schema.decodeUnknownSync(schema as Schema.Codec<{ enabled: boolean }>)(
          config,
        );
        expect(providerInstanceEnvelopeEnabled({ driver: driver(kind), config })).toBe(
          decoded.enabled,
        );
      }
    }
  });
});

describe("resolveProviderInstanceEnabled", () => {
  it("lets an explicit entry win over the legacy mirror", () => {
    // The settings panel disables a default instance this way and resets the legacy slot.
    const settings = settingsWith({
      providers: { codex: { enabled: true } },
      providerInstances: { codex: { driver: driver("codex"), enabled: false } },
    });
    expect(resolveProviderInstanceEnabled(settings, "codex")).toBe(false);
  });

  it("uses the legacy flag for a slot without an explicit entry", () => {
    const settings = settingsWith({ providers: { claudeAgent: { enabled: false } } });
    expect(resolveProviderInstanceEnabled(settings, "claudeAgent")).toBe(false);
    expect(resolveProviderInstanceEnabled(settings, "codex")).toBe(true);
    expect(resolveProviderInstanceEnabled(settings, "cursor")).toBe(false);
  });

  it("treats an explicit entry without a flag like the registry does", () => {
    const settings = settingsWith({
      providers: { cursor: { enabled: true } },
      providerInstances: {
        cursor: { driver: driver("cursor"), config: {} },
        claude_hub: { driver: driver("claudeAgent") },
      },
    });
    expect(resolveProviderInstanceEnabled(settings, "cursor")).toBe(false);
    expect(resolveProviderInstanceEnabled(settings, "claude_hub")).toBe(true);
  });

  it("knows nothing of ids that are not configured", () => {
    const settings = settingsWith({});
    expect(resolveProviderInstanceEnabled(settings, "codex_missing")).toBeUndefined();
    expect(resolveProviderInstanceEnabled(settings, "constructor")).toBeUndefined();
    expect(resolveProviderInstanceEnabled(settings, "toString")).toBeUndefined();
  });
});

describe("listEnabledProviderInstances", () => {
  it("lists default slots first, then the other explicit instances in insertion order", () => {
    const settings = settingsWith({
      providers: { claudeAgent: { enabled: false } },
      providerInstances: {
        claude_hub: { driver: driver("claudeAgent"), enabled: true },
        codex: { driver: driver("codex"), enabled: false },
        opencode: { driver: driver("opencode"), enabled: true },
        codex_work: { driver: driver("codex") },
        claude_off: { driver: driver("claudeAgent"), enabled: false },
      },
    });
    expect(listEnabledProviderInstances(settings)).toEqual([
      { instanceId: id("copilot"), driver: driver("copilot") },
      { instanceId: id("grok"), driver: driver("grok") },
      { instanceId: id("opencode"), driver: driver("opencode") },
      { instanceId: id("claude_hub"), driver: driver("claudeAgent") },
      { instanceId: id("codex_work"), driver: driver("codex") },
    ]);
  });

  it("takes the driver from the envelope of a default slot", () => {
    const settings = settingsWith({
      providerInstances: { codex: { driver: driver("forkCodex"), enabled: true } },
    });
    expect(listEnabledProviderInstances(settings)[0]).toEqual({
      instanceId: id("codex"),
      driver: driver("forkCodex"),
    });
  });
});
