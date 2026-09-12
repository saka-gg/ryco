import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@ryco/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@ryco/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveProviderSettingsInstanceRows,
  resolveProviderSettingsListNavigationIndex,
  resolveSelectedProviderSettingsInstance,
} from "./providerSettingsInstances";

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

  it("supports wrapping arrow navigation and direct first/last navigation", () => {
    expect(resolveProviderSettingsListNavigationIndex(0, "ArrowUp", 4)).toBe(3);
    expect(resolveProviderSettingsListNavigationIndex(3, "ArrowDown", 4)).toBe(0);
    expect(resolveProviderSettingsListNavigationIndex(2, "Home", 4)).toBe(0);
    expect(resolveProviderSettingsListNavigationIndex(1, "End", 4)).toBe(3);
  });
});
