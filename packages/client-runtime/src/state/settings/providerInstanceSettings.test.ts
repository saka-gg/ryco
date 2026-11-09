import {
  DEFAULT_SERVER_SETTINGS,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProviderModel,
} from "@ryco/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@ryco/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderDefaultResetPatch,
  buildProviderInstanceDeletePatch,
  buildProviderInstanceUpdatePatch,
  deriveProviderModelsForDisplay,
  deriveProviderSettingsInstanceRows,
  newProviderInstanceConfig,
  providerInstanceIdError,
  providerInstanceIdForLabel,
  resolveCustomModelSlug,
  resolveSelectedProviderSettingsInstance,
  textGenerationSelectionAfterInstanceEdit,
  uniqueProviderInstanceId,
  withProviderInstanceCustomModels,
  withProviderInstanceDisplayName,
  withProviderInstanceEnvironment,
} from "./providerInstanceSettings.ts";

const codex = ProviderDriverKind.make("codex");
const customId = ProviderInstanceId.make("codex_work");
const customInstance: ProviderInstanceConfig = {
  driver: codex,
  enabled: true,
  displayName: "Work",
};

describe("provider settings instance list", () => {
  it("keeps the default slot before custom instances of the same driver", () => {
    const rows = deriveProviderSettingsInstanceRows(
      {
        ...DEFAULT_UNIFIED_SETTINGS,
        providerInstances: { [customId]: customInstance },
      },
      [],
    );

    const defaultIndex = rows.findIndex(
      (row) => row.instanceId === defaultInstanceIdForDriver(codex),
    );
    const customIndex = rows.findIndex((row) => row.instanceId === customId);
    expect(defaultIndex).toBeGreaterThanOrEqual(0);
    expect(customIndex).toBe(defaultIndex + 1);
    expect(rows[defaultIndex]).toMatchObject({ isDefault: true, isDirty: false });
    expect(rows[customIndex]).toMatchObject({ isDefault: false, isDirty: true });
  });

  it("does not invent a default slot for an unconfigured registry driver", () => {
    const rows = deriveProviderSettingsInstanceRows(DEFAULT_UNIFIED_SETTINGS, []);
    expect(rows.filter((row) => row.driver === "acpRegistry")).toEqual([]);
  });

  it("keeps explicitly configured registry instances removable, including an ID matching the driver", () => {
    const registry = ProviderDriverKind.make("acpRegistry");
    const instances: Record<ProviderInstanceId, ProviderInstanceConfig> = {
      [ProviderInstanceId.make("acpRegistry")]: {
        driver: registry,
        enabled: true,
        config: { agentId: "example", version: "1.2.3" },
      },
      [ProviderInstanceId.make("acpRegistry_work")]: {
        driver: registry,
        enabled: true,
        config: { agentId: "another", version: "2.0.0" },
      },
    };
    const rows = deriveProviderSettingsInstanceRows(
      { ...DEFAULT_UNIFIED_SETTINGS, providerInstances: instances },
      [],
    );
    const registryRows = rows.filter((row) => row.driver === registry);
    expect(registryRows).toHaveLength(2);
    expect(registryRows.map((row) => row.instanceId)).toEqual(Object.keys(instances));
    for (const row of registryRows) {
      expect(row).toMatchObject({
        isDefault: false,
        isDirty: true,
        instance: instances[row.instanceId],
      });
    }
  });

  it("falls back predictably when the selected custom instance is removed", () => {
    const rows = deriveProviderSettingsInstanceRows(DEFAULT_UNIFIED_SETTINGS, []);
    const selected = resolveSelectedProviderSettingsInstance(rows, customId);

    expect(selected?.instanceId).toBe(defaultInstanceIdForDriver(codex));
    expect(selected?.isDefault).toBe(true);
  });

  it("preserves default-slot semantics when a driver is not in the visible built-in list", () => {
    const cursor = ProviderDriverKind.make("cursor");
    const cursorId = defaultInstanceIdForDriver(cursor);
    const rows = deriveProviderSettingsInstanceRows(
      {
        ...DEFAULT_UNIFIED_SETTINGS,
        providerInstances: {
          [cursorId]: { driver: cursor, enabled: true },
        },
      },
      [],
    );

    expect(rows.find((row) => row.instanceId === cursorId)).toMatchObject({
      isDefault: true,
      isDirty: true,
    });
  });
});

describe("buildProviderInstanceUpdatePatch", () => {
  it("promotes an edited default provider into providerInstances and resets the legacy provider", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        binaryPath: "/opt/ryco/codex",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: {
            ...DEFAULT_SERVER_SETTINGS.providers.codex,
            binaryPath: "/legacy/codex",
          },
        },
      },
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: true,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers?.codex).toEqual(DEFAULT_SERVER_SETTINGS.providers.codex);
  });

  it("updates custom instances without touching legacy provider settings", () => {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        homePath: "/Users/example/.codex-personal",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: DEFAULT_SERVER_SETTINGS,
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: false,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers).toBeUndefined();
  });
});

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });
});

describe("instance patches", () => {
  const custom = ProviderInstanceId.make("codex_work");
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      [custom]: { driver: ProviderDriverKind.make("codex"), enabled: true },
    },
  };

  it("removes an added instance and resets text generation only when it used it", () => {
    expect(
      buildProviderInstanceDeletePatch({
        settings,
        instanceId: custom,
        textGenerationInstanceId: null,
      }),
    ).toEqual({ providerInstances: {} });
    expect(
      buildProviderInstanceDeletePatch({
        settings,
        instanceId: custom,
        textGenerationInstanceId: custom,
      }).textGenerationModelSelection,
    ).toEqual(DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection);
  });

  it("resets a default slot's legacy settings and promoted instance", () => {
    const codex = ProviderDriverKind.make("codex");
    const promoted = {
      ...settings,
      providerInstances: {
        ...settings.providerInstances,
        [defaultInstanceIdForDriver(codex)]: { driver: codex, enabled: false },
      },
    };
    const patch = buildProviderDefaultResetPatch({
      settings: promoted,
      driver: codex,
      textGenerationInstanceId: null,
    });
    expect(patch?.providers?.codex).toEqual(DEFAULT_SERVER_SETTINGS.providers.codex);
    expect(Object.keys(patch?.providerInstances ?? {})).toEqual([custom]);
    expect(
      buildProviderDefaultResetPatch({
        settings,
        driver: ProviderDriverKind.make("acpRegistry"),
        textGenerationInstanceId: null,
      }),
    ).toBeNull();
  });

  it("falls back to the default text generation model when disabling the instance it uses", () => {
    const previous: ProviderInstanceConfig = { driver: ProviderDriverKind.make("codex") };
    const next = { ...previous, enabled: false };
    expect(
      textGenerationSelectionAfterInstanceEdit({
        instanceId: custom,
        previous,
        next,
        textGenerationInstanceId: custom,
      }),
    ).toEqual(DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection);
    expect(
      textGenerationSelectionAfterInstanceEdit({
        instanceId: custom,
        previous,
        next,
        textGenerationInstanceId: null,
      }),
    ).toBeUndefined();
    expect(
      textGenerationSelectionAfterInstanceEdit({
        instanceId: custom,
        previous: next,
        next: { ...next, displayName: "Work" },
        textGenerationInstanceId: custom,
      }),
    ).toBeUndefined();
  });
});

describe("adding an instance", () => {
  const codex = ProviderDriverKind.make("codex");

  it("derives ids from labels and validates them by the slug rules", () => {
    expect(providerInstanceIdForLabel(codex, "  My Work! ")).toBe("codex_my_work");
    expect(providerInstanceIdForLabel(codex, "!!")).toBe("");
    expect(providerInstanceIdError("", new Set())).toBe("Instance ID is required.");
    expect(providerInstanceIdError("1abc", new Set())).toMatch(/start with a letter/);
    expect(providerInstanceIdError("codex_work", new Set(["codex_work"]))).toMatch(
      /already exists/,
    );
    expect(providerInstanceIdError("codex_work", new Set())).toBeNull();
  });

  it("numbers a taken id and names an unlabeled one after its driver", () => {
    expect(uniqueProviderInstanceId(codex, "Work", new Set())).toBe("codex_work");
    expect(uniqueProviderInstanceId(codex, "Work", new Set(["codex_work"]))).toBe("codex_work_2");
    expect(uniqueProviderInstanceId(codex, "Work", new Set(["codex_work", "codex_work_2"]))).toBe(
      "codex_work_3",
    );
    expect(uniqueProviderInstanceId(codex, "", new Set())).toBe("codex_instance");
    const long = "x".repeat(60);
    const taken = providerInstanceIdForLabel(codex, long);
    const next = uniqueProviderInstanceId(codex, long, new Set([taken]));
    expect(next.length).toBeLessThanOrEqual(64);
    expect(next.endsWith("_2")).toBe(true);
  });

  it("leaves empty label, accent and config out of a new instance", () => {
    expect(newProviderInstanceConfig({ driver: codex, label: "  " })).toEqual({
      driver: codex,
      enabled: true,
    });
    expect(
      newProviderInstanceConfig({ driver: codex, label: " Work ", config: { homePath: "~/w" } }),
    ).toEqual({ driver: codex, enabled: true, displayName: "Work", config: { homePath: "~/w" } });
  });
});

describe("editing an instance", () => {
  const instance: ProviderInstanceConfig = {
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Old",
    config: { binaryPath: "/bin/claude" },
  };

  it("drops an empty display name and environment", () => {
    expect(withProviderInstanceDisplayName(instance, "  ")).not.toHaveProperty("displayName");
    expect(withProviderInstanceDisplayName(instance, " New ").displayName).toBe("New");
    expect(
      withProviderInstanceEnvironment({ ...instance, environment: [] }, []),
    ).not.toHaveProperty("environment");
  });

  it("keeps other config keys when changing custom models, an empty list included", () => {
    expect(withProviderInstanceCustomModels(instance, []).config).toEqual({
      binaryPath: "/bin/claude",
      customModels: [],
    });
  });

  it("normalizes a custom model slug and refuses built-in, saved and empty ones", () => {
    const models: ReadonlyArray<ServerProviderModel> = [
      { slug: "built-in", name: "Built in", isCustom: false, capabilities: null },
    ];
    const resolve = (text: string) =>
      resolveCustomModelSlug({ text, driverKind: null, models, customModels: ["saved"] });
    expect(resolve("  mine ")).toEqual({ ok: true, slug: "mine" });
    expect(resolve(" ")).toEqual({ ok: false, error: "Enter a model slug." });
    expect(resolve("built-in")).toEqual({ ok: false, error: "That model is already built in." });
    expect(resolve("saved")).toEqual({ ok: false, error: "That custom model is already saved." });
  });
});
