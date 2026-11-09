import type { OpinionatedPluginCatalogItem, OpinionatedPluginStatus } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canInstallOpinionatedPlugin,
  groupOpinionatedPluginStatuses,
  opinionatedPluginName,
  opinionatedPluginStatusKey,
  opinionatedPluginTargetLabel,
  replaceOpinionatedPluginStatus,
  sortOpinionatedPlugins,
} from "./opinionatedPlugins.ts";

const status = (overrides: Partial<OpinionatedPluginStatus>): OpinionatedPluginStatus =>
  ({
    pluginId: "rtk",
    targetKind: "global",
    state: "not-installed",
    canInstall: true,
    checkedAt: "2026-11-09T00:00:00.000Z",
    manualSteps: [],
    ...overrides,
  }) as OpinionatedPluginStatus;

const plugin = (id: OpinionatedPluginCatalogItem["id"], name: string) =>
  ({ id, name }) as OpinionatedPluginCatalogItem;

describe("opinionated plugins", () => {
  it("orders the catalog and each plugin's targets", () => {
    expect(
      sortOpinionatedPlugins([plugin("lean-ctx", "Lean"), plugin("rtk", "RTK")]).map((p) => p.id),
    ).toEqual(["rtk", "lean-ctx"]);
    const grouped = groupOpinionatedPluginStatuses([
      status({
        pluginId: "caveman",
        targetKind: "provider-instance",
        providerInstanceId: "codex" as never,
        providerDisplayName: "Codex",
      }),
      status({
        pluginId: "caveman",
        targetKind: "provider-instance",
        providerInstanceId: "claude" as never,
        providerDisplayName: "Claude",
      }),
      status({ pluginId: "rtk" }),
    ]);
    expect(grouped.get("caveman")?.map(opinionatedPluginTargetLabel)).toEqual(["Claude", "Codex"]);
    expect(grouped.get("rtk")?.map(opinionatedPluginTargetLabel)).toEqual(["System"]);
  });

  it("replaces a target's status after an install", () => {
    const before = [status({}), status({ pluginId: "caveman" })];
    const after = replaceOpinionatedPluginStatus(before, status({ state: "installed" }));
    expect(after).toHaveLength(2);
    expect(after.find((entry) => entry.pluginId === "rtk")?.state).toBe("installed");
    expect(opinionatedPluginStatusKey(status({}))).toBe("rtk:global:global");
  });

  it("installs only what is installable and not yet installed", () => {
    expect(canInstallOpinionatedPlugin(status({}))).toBe(true);
    expect(canInstallOpinionatedPlugin(status({ state: "installed" }))).toBe(false);
    expect(canInstallOpinionatedPlugin(status({ canInstall: false }))).toBe(false);
  });

  it("names a plugin from the catalog", () => {
    expect(opinionatedPluginName([plugin("caveman", "Caveman")], "caveman")).toBe("Caveman");
    expect(opinionatedPluginName([], "lean-ctx")).toBe("lean-ctx");
  });
});
