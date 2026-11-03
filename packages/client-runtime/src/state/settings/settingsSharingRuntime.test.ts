import { describe, expect, it } from "vite-plus/test";

import {
  settingsSharingStorageKeys,
  type SettingsSharingNamespace,
} from "./settingsSharingClock.ts";
import { createSettingsSharingRuntime } from "./settingsSharingRuntime.ts";
import { writeSharedSetting } from "./sharedDeviceSettings.ts";
import { createDeviceNetwork } from "./sharedDeviceSettings.testSupport.ts";

function setup(initial: SettingsSharingNamespace | null = { kind: "local" }) {
  const net = createDeviceNetwork();
  const store = new Map<string, string>();
  let namespace = initial;
  const namespaceListeners = new Set<() => void>();
  let ids = 0;
  const runtime = createSettingsSharingRuntime({
    readNamespace: () => namespace,
    subscribeNamespace: (listener) => {
      namespaceListeners.add(listener);
      return () => namespaceListeners.delete(listener);
    },
    storage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => void store.set(key, value),
    },
    generateId: () => `client-${++ids}`,
    now: () => 1_000,
    readTargets: net.readTargets,
    subscribeTargets: net.subscribe,
    runner: { debounceMs: 0 },
  });
  return {
    net,
    store,
    runtime,
    setNamespace: (next: SettingsSharingNamespace | null) => {
      namespace = next;
      for (const listener of namespaceListeners) listener();
    },
    namespaceListenerCount: () => namespaceListeners.size,
  };
}

describe("settings sharing runtime", () => {
  it("runs while any start holds, and follows the namespace only then", () => {
    const { runtime, namespaceListenerCount } = setup();
    const stopA = runtime.start();
    const stopB = runtime.start();
    expect(runtime.running()).toBe(true);
    expect(namespaceListenerCount()).toBe(1);
    stopA();
    stopA();
    expect(runtime.running()).toBe(true);
    stopB();
    expect(runtime.running()).toBe(false);
    expect(namespaceListenerCount()).toBe(0);
  });

  it("stamps edits with its namespace's own client id, a fresh one per account", () => {
    const { runtime, net, setNamespace, store } = setup();
    net.add("a");
    expect(runtime.nextEditStamp(net.readTargets())?.by).toBe("client-1");
    setNamespace({ kind: "hosted", hubOrigin: "https://hub.example", accountId: "acct-1" });
    expect(runtime.nextEditStamp(net.readTargets())?.by).toBe("client-2");
    expect(
      store.get(
        settingsSharingStorageKeys({
          kind: "hosted",
          hubOrigin: "https://hub.example",
          accountId: "acct-1",
        }).clientId,
      ),
    ).toBe(JSON.stringify("client-2"));
    setNamespace({ kind: "local" });
    expect(runtime.nextEditStamp(net.readTargets())?.by).toBe("client-1");
    setNamespace(null);
    expect(runtime.nextEditStamp(net.readTargets())).toBeNull();
  });

  it("sends a command, records its value for offline devices and notifies", async () => {
    const { runtime, net } = setup();
    const online = net.add("online");
    net.add("offline", { connected: false });
    let notified = 0;
    runtime.subscribe(() => {
      notified += 1;
    });
    const stamp = runtime.nextEditStamp(net.readTargets());
    if (stamp === null) throw new Error("expected a stamp");
    const command = writeSharedSetting({
      devices: net.readTargets(),
      key: "worktreeBranchPrefix",
      value: "team",
      stamp,
    });
    const result = await runtime.runCommand(command);
    expect(result.applied.map((device) => device.environmentId)).toEqual(["online"]);
    expect(online.settings.worktreeBranchPrefix).toBe("team");
    expect(runtime.readState().cache.worktreeBranchPrefix?.value).toBe("team");
    expect(notified).toBeGreaterThan(0);
  });
});
