import { DEFAULT_SERVER_SETTINGS, ProviderDriverKind, ProviderInstanceId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createModelSelection } from "./model.ts";
import {
  applyServerSettingsPatch,
  extractPersistedServerObservabilitySettings,
  migrateLegacyServerSettings,
  normalizePersistedServerSettingString,
  parsePersistedServerObservabilitySettings,
} from "./serverSettings.ts";

describe("serverSettings helpers", () => {
  it("normalizes optional persisted strings", () => {
    expect(normalizePersistedServerSettingString(undefined)).toBeUndefined();
    expect(normalizePersistedServerSettingString("   ")).toBeUndefined();
    expect(normalizePersistedServerSettingString("  http://localhost:4318/v1/traces  ")).toBe(
      "http://localhost:4318/v1/traces",
    );
  });

  it("extracts persisted observability settings", () => {
    expect(
      extractPersistedServerObservabilitySettings({
        observability: {
          otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
          otlpMetricsUrl: "  http://localhost:4318/v1/metrics  ",
        },
      }),
    ).toEqual({
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpMetricsUrl: "http://localhost:4318/v1/metrics",
    });
  });

  it("parses lenient persisted settings JSON", () => {
    expect(
      parsePersistedServerObservabilitySettings(
        JSON.stringify({
          observability: {
            otlpTracesUrl: "http://localhost:4318/v1/traces",
            otlpMetricsUrl: "http://localhost:4318/v1/metrics",
          },
        }),
      ),
    ).toEqual({
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpMetricsUrl: "http://localhost:4318/v1/metrics",
    });
  });

  it("reads the endpoints even when an unrelated setting is invalid", () => {
    expect(
      parsePersistedServerObservabilitySettings(
        JSON.stringify({
          lifecycleSuggestions: { archiveInactiveThreadsDays: "soon" },
          observability: { otlpTracesUrl: "http://localhost:4318/v1/traces" },
        }),
      ),
    ).toEqual({ otlpTracesUrl: "http://localhost:4318/v1/traces", otlpMetricsUrl: undefined });
  });

  it("falls back cleanly when persisted settings are invalid", () => {
    expect(parsePersistedServerObservabilitySettings("{")).toEqual({
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
    });
  });

  it("replaces text generation selection when provider/model are provided", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4-mini",
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4-mini",
    });
  });

  it("still deep merges text generation selection when only options are provided", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          options: [{ id: "fastMode", value: false }],
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4-mini",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: false },
      ],
    });
  });

  it("replaces text generation selection across providers without leaking stale options", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "opencode",
      model: "openai/gpt-5",
    });
  });

  it("accepts array-based text generation selection patches", () => {
    expect(
      applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
          options: [
            { id: "variant", value: "prod" },
            { id: "agent", value: "build" },
          ],
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "opencode",
      model: "openai/gpt-5",
      options: [
        { id: "variant", value: "prod" },
        { id: "agent", value: "build" },
      ],
    });
  });

  it("replaces providerInstances maps so omitted instance fields are cleared", () => {
    const codexId = ProviderInstanceId.make("codex");
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          displayName: "Codex Work",
          accentColor: "#7c3aed",
          enabled: true,
          config: { homePath: "~/.codex" },
        },
      },
    };

    expect(
      applyServerSettingsPatch(current, {
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
            enabled: true,
            config: { homePath: "~/.codex" },
          },
        },
      }).providerInstances[codexId],
    ).toEqual({
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex Work",
      enabled: true,
      config: { homePath: "~/.codex" },
    });
  });
});

describe("response streaming mode", () => {
  const withMode = (responseStreamingMode: "turn" | "paragraph" | "token") => ({
    ...DEFAULT_SERVER_SETTINGS,
    responseStreamingMode,
  });

  it("maps the legacy token switch that older clients write", () => {
    const patch = (current: "turn" | "paragraph" | "token", enabled: boolean) =>
      applyServerSettingsPatch(withMode(current), { enableLegacyTokenStreaming: enabled });
    expect(patch("turn", true).responseStreamingMode).toBe("token");
    expect(patch("token", false).responseStreamingMode).toBe("paragraph");
    expect(patch("turn", false).responseStreamingMode).toBe("turn");
    expect(patch("paragraph", false).responseStreamingMode).toBe("paragraph");
    expect(patch("turn", true)).not.toHaveProperty("enableLegacyTokenStreaming");
  });

  it("lets the new key win when a patch carries both", () => {
    expect(
      applyServerSettingsPatch(withMode("paragraph"), {
        responseStreamingMode: "turn",
        enableLegacyTokenStreaming: true,
      }).responseStreamingMode,
    ).toBe("turn");
  });

  it("upgrades a saved token-streaming opt-in and leaves everything else alone", () => {
    expect(migrateLegacyServerSettings({ enableLegacyTokenStreaming: true, a: 1 })).toEqual({
      enableLegacyTokenStreaming: true,
      a: 1,
      responseStreamingMode: "token",
    });
    for (const persisted of [
      { enableLegacyTokenStreaming: false },
      { enableLegacyTokenStreaming: true, responseStreamingMode: "turn" },
      { enableLegacyTokenStreaming: "yes" },
      {},
      [],
      "text",
      null,
    ]) {
      expect(migrateLegacyServerSettings(persisted)).toBe(persisted);
    }
  });
});

describe("node auto-settle rule patches", () => {
  it("sets the rule, Off included, and keeps it absent until then", () => {
    expect(Object.hasOwn(DEFAULT_SERVER_SETTINGS, "threadAutoSettleAfterDays")).toBe(false);
    const off = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      threadAutoSettleAfterDays: null,
    });
    expect(off.threadAutoSettleAfterDays).toBeNull();
    expect(
      applyServerSettingsPatch(off, { threadAutoSettleAfterDays: 30 }).threadAutoSettleAfterDays,
    ).toBe(30);
  });

  it("lets only the first of two hand-overs to an unset node stand", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      threadAutoSettleAfterDays: 30,
      expectedThreadAutoSettleAfterDays: "absent",
    });
    expect(first.threadAutoSettleAfterDays).toBe(30);
    expect(Object.hasOwn(first, "expectedThreadAutoSettleAfterDays")).toBe(false);
    expect(() =>
      applyServerSettingsPatch(first, {
        threadAutoSettleAfterDays: 3,
        expectedThreadAutoSettleAfterDays: "absent",
      }),
    ).toThrow("changed elsewhere");
    expect(
      applyServerSettingsPatch(first, {
        threadAutoSettleAfterDays: 3,
        expectedThreadAutoSettleAfterDays: 30,
      }).threadAutoSettleAfterDays,
    ).toBe(3);
  });

  it("treats a node set to Off as set, not as never set", () => {
    const off = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      threadAutoSettleAfterDays: null,
    });
    expect(() =>
      applyServerSettingsPatch(off, {
        threadAutoSettleAfterDays: 30,
        expectedThreadAutoSettleAfterDays: "absent",
      }),
    ).toThrow("changed elsewhere");
    expect(
      applyServerSettingsPatch(off, {
        threadAutoSettleAfterDays: 30,
        expectedThreadAutoSettleAfterDays: null,
      }).threadAutoSettleAfterDays,
    ).toBe(30);
    expect(() =>
      applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        threadAutoSettleAfterDays: 30,
        expectedThreadAutoSettleAfterDays: null,
      }),
    ).toThrow("changed elsewhere");
  });
});

describe("worktree root override patches", () => {
  it("treats project IDs as data, including object prototype property names", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectWorktreeRoots: Object.fromEntries([
        ["__proto__", "/volumes/a"],
        ["constructor", "/volumes/b"],
      ]),
    });
    expect(Object.hasOwn(settings.projectWorktreeRoots, "__proto__")).toBe(true);
    expect(settings.projectWorktreeRoots.constructor).toBe("/volumes/b");
    expect(
      applyServerSettingsPatch(settings, { projectWorktreeRoots: { constructor: null } })
        .projectWorktreeRoots,
    ).toEqual(Object.fromEntries([["__proto__", "/volumes/a"]]));
  });

  it("patches individual projects, resets inheritance and preserves sibling edits", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      worktreeRoot: "/volumes/default",
      projectWorktreeRoots: { a: "/volumes/a" },
    });
    const second = applyServerSettingsPatch(first, { projectWorktreeRoots: { b: "/volumes/b" } });
    const reset = applyServerSettingsPatch(second, { projectWorktreeRoots: { a: null } });
    expect(reset.projectWorktreeRoots).toEqual({ b: "/volumes/b" });
    expect(reset.worktreeRoot).toBe("/volumes/default");
    expect(first.projectWorktreeRoots).toEqual({ a: "/volumes/a" });
    expect(applyServerSettingsPatch(reset, { worktreeRoot: "" }).projectWorktreeRoots).toEqual({
      b: "/volumes/b",
    });
  });
});

describe("usage price override patches", () => {
  const price = (input: number) => ({
    price: { inputUsdPerMillion: input, outputUsdPerMillion: input * 5 },
  });

  it("patches individual models, removes them with null and leaves other settings alone", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      usagePriceOverrides: { "kimi-k3": price(1), preview: { mapTo: "claude-opus-5" } },
    });
    const second = applyServerSettingsPatch(first, {
      usagePriceOverrides: { "kimi-k3": price(2), other: price(3) },
    });
    expect(second.usagePriceOverrides).toEqual({
      "kimi-k3": price(2),
      preview: { mapTo: "claude-opus-5" },
      other: price(3),
    });
    // An entry is replaced whole: a mapping does not keep the price it replaces.
    const remapped = applyServerSettingsPatch(second, {
      usagePriceOverrides: { "kimi-k3": { mapTo: "kimi-k2" }, preview: null },
    });
    expect(remapped.usagePriceOverrides).toEqual({
      "kimi-k3": { mapTo: "kimi-k2" },
      other: price(3),
    });
    expect({ ...remapped, usagePriceOverrides: {} }).toEqual(DEFAULT_SERVER_SETTINGS);
    expect(
      applyServerSettingsPatch(remapped, { enableProviderUpdateChecks: false }).usagePriceOverrides,
    ).toBe(remapped.usagePriceOverrides);
  });

  it("renames a model ID, its case included, by removing the old key", () => {
    const saved = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      usagePriceOverrides: { "Kimi-K3": price(1) },
    });
    expect(
      applyServerSettingsPatch(saved, {
        usagePriceOverrides: { "kimi-k3": price(2), "Kimi-K3": null },
      }).usagePriceOverrides,
    ).toEqual({ "kimi-k3": price(2) });
  });

  it("treats model IDs as data, including object prototype property names", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      usagePriceOverrides: Object.fromEntries([
        ["__proto__", price(1)],
        ["constructor", price(2)],
      ]),
    });
    expect(Object.hasOwn(settings.usagePriceOverrides, "__proto__")).toBe(true);
    expect(settings.usagePriceOverrides.constructor).toEqual(price(2));
  });
});
