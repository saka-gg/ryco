import type { NodeSettingsTarget } from "@ryco/client-runtime/state/settings/nodeSettingsTargets";
import { createSettingsSharingRuntime } from "@ryco/client-runtime/state/settings/settingsSharingRuntime";
import { EnvironmentId, type ServerConfig } from "@ryco/contracts";
import {
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@ryco/contracts/settings";
import { applyServerSettingsPatch } from "@ryco/shared/serverSettings";
import { SETTINGS_SHARING_VERSION } from "@ryco/shared/settingsSharing";
import { describe, expect, it } from "vite-plus/test";

import { applySharedSettingToAllNodes, saveNodeSharedSetting } from "./sharedSettingEdits";

interface Node {
  readonly id: EnvironmentId;
  settings: ServerSettings;
  connected: boolean;
  canWrite: boolean;
  readonly writes: ServerSettingsPatch[];
}

function nodes(...input: Array<{ id: string; connected?: boolean; canWrite?: boolean }>) {
  const list: Node[] = input.map((entry) => ({
    id: EnvironmentId.make(entry.id),
    settings: DEFAULT_SERVER_SETTINGS,
    connected: entry.connected ?? true,
    canWrite: entry.canWrite ?? true,
    writes: [],
  }));
  const targets = (): ReadonlyArray<NodeSettingsTarget> =>
    list.map((node) => ({
      environmentId: node.id,
      label: node.id,
      config: {
        environment: { capabilities: { settingsSharingVersion: SETTINGS_SHARING_VERSION } },
        settings: node.settings,
      } as unknown as ServerConfig,
      connected: node.connected,
      canWrite: node.canWrite,
      write: async (patch) => {
        node.writes.push(patch);
        node.settings = applyServerSettingsPatch(node.settings, patch);
      },
    }));
  return { list, targets };
}

function phoneRuntime(readTargets: () => ReadonlyArray<NodeSettingsTarget> = () => []) {
  const store = new Map<string, string>();
  return createSettingsSharingRuntime({
    readNamespace: () => ({ kind: "local" }),
    storage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => void store.set(key, value),
    },
    generateId: () => "phone",
    now: () => 5_000,
    readTargets,
    subscribeTargets: () => () => undefined,
    // Timers fire on the next microtask: the runner's pass runs as soon as it is due.
    runner: {
      debounceMs: 0,
      timers: {
        set: (callback) => {
          queueMicrotask(callback);
          return 0;
        },
        clear: () => undefined,
      },
    },
  });
}

describe("the phone's shared setting edits", () => {
  it("gives one node its own value, stamped, and leaves the others alone", async () => {
    const { list, targets } = nodes({ id: "studio" }, { id: "laptop" });
    await saveNodeSharedSetting({
      runtime: phoneRuntime(),
      targets: targets(),
      environmentId: EnvironmentId.make("studio"),
      key: "storageRetention",
      value: { ...DEFAULT_SERVER_SETTINGS.storageRetention, automatic: true },
    });
    const [studio, laptop] = list;
    expect(studio?.settings.storageRetention.automatic).toBe(true);
    expect(studio?.settings.settingsSharing.storageRetention).toEqual({
      mode: "override",
      stamp: { at: 5_000, by: "phone" },
    });
    expect(laptop?.writes).toEqual([]);
  });

  it("says why a node it may not change was not saved", async () => {
    const { targets } = nodes({ id: "studio", canWrite: false }, { id: "laptop" });
    await expect(
      saveNodeSharedSetting({
        runtime: phoneRuntime(),
        targets: targets(),
        environmentId: EnvironmentId.make("studio"),
        key: "threadAutoSettleAfterDays",
        value: 3,
      }),
    ).rejects.toThrow("Connect as the node owner to change this.");
  });

  it("uses a value on every node it can change now, and the offline one catches up later", async () => {
    const { list, targets } = nodes(
      { id: "studio" },
      { id: "laptop" },
      { id: "away", connected: false },
    );
    const runtime = phoneRuntime(targets);
    // The laptop kept its own value; "use on every node" clears it.
    await saveNodeSharedSetting({
      runtime,
      targets: targets(),
      environmentId: EnvironmentId.make("laptop"),
      key: "threadAutoSettleAfterDays",
      value: 30,
    });
    const status = await applySharedSettingToAllNodes({
      runtime,
      targets: targets(),
      key: "threadAutoSettleAfterDays",
      value: 3,
    });
    expect(status).toBe("Saved on studio, laptop. Applies when they reconnect: away.");
    const [studio, laptop, away] = list;
    expect(studio?.settings.threadAutoSettleAfterDays).toBe(3);
    expect(laptop?.settings.threadAutoSettleAfterDays).toBe(3);
    expect(laptop?.settings.settingsSharing.threadAutoSettleAfterDays?.mode).toBe("shared");
    expect(away?.writes).toEqual([]);
    // The phone's runner brings the offline node up to date once it is back.
    if (away) away.connected = true;
    const stop = runtime.start();
    for (let round = 0; round < 20; round += 1) await Promise.resolve();
    stop();
    expect(away?.settings.threadAutoSettleAfterDays).toBe(3);
    expect(away?.settings.settingsSharing.threadAutoSettleAfterDays).toEqual(
      studio?.settings.settingsSharing.threadAutoSettleAfterDays,
    );
  });
});
