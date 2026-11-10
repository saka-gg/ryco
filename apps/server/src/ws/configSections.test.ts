import { createConfigSectionCache, restoreSnapshotSections } from "@ryco/client-runtime/rpc";
import {
  DEFAULT_SERVER_SETTINGS,
  type ServerConfig,
  type ServerConfigStreamSnapshotEvent,
} from "@ryco/contracts";
import { NODE_DEFAULT_RESOLVED_KEYBINDINGS } from "@ryco/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import { configSectionDigest, omitKnownConfigSections } from "./configSections.ts";

const config = {
  cwd: "/tmp/node",
  settings: { ...DEFAULT_SERVER_SETTINGS, runSetupScript: true },
  keybindings: NODE_DEFAULT_RESOLVED_KEYBINDINGS,
} as unknown as ServerConfig;

const snapshot = (
  next: ReturnType<typeof omitKnownConfigSections>,
): ServerConfigStreamSnapshotEvent => ({
  version: 1,
  type: "snapshot",
  config: next.config,
  configSections: next.configSections,
});

const bytes = (value: unknown) => JSON.stringify(value).length;

describe("config sections", () => {
  it("digests content, so equal sections share a digest and a change gets a new one", () => {
    expect(configSectionDigest("settings", { ...config.settings })).toBe(
      configSectionDigest("settings", config.settings),
    );
    expect(configSectionDigest("settings", { ...config.settings, runSetupScript: false })).not.toBe(
      configSectionDigest("settings", config.settings),
    );
    expect(configSectionDigest("keybindings", [])).not.toBe(configSectionDigest("settings", []));
  });

  it("leaves out what a client holds and the client restores the same config", () => {
    const cache = createConfigSectionCache();
    // A first subscription holds nothing: everything is sent, with digests the client keeps.
    const first = snapshot(omitKnownConfigSections(config, []));
    expect(first.configSections?.omitted).toEqual([]);
    expect(restoreSnapshotSections(first, cache.pin(), cache)?.config).toEqual(config);

    // A reconnect names them and gets placeholders instead.
    const pinned = cache.pin();
    const second = snapshot(omitKnownConfigSections(config, [...pinned.keys()]));
    expect(second.configSections?.omitted).toEqual(["settings", "keybindings"]);
    expect(second.config.keybindings).toEqual([]);
    expect(bytes(first.config) - bytes(second.config)).toBeGreaterThan(5_000);
    expect(restoreSnapshotSections(second, pinned, cache)?.config).toEqual(config);

    // A changed section is sent again; the other stays left out.
    const changed = { ...config, settings: { ...config.settings, runSetupScript: false } };
    const third = snapshot(omitKnownConfigSections(changed, [...cache.pin().keys()]));
    expect(third.configSections?.omitted).toEqual(["keybindings"]);
    expect(restoreSnapshotSections(third, cache.pin(), cache)?.config).toEqual(changed);
  });

  it("refuses a snapshot that left out a section the subscription never claimed", () => {
    const held = createConfigSectionCache();
    restoreSnapshotSections(snapshot(omitKnownConfigSections(config, [])), held.pin(), held);
    const event = snapshot(omitKnownConfigSections(config, [...held.pin().keys()]));
    expect(restoreSnapshotSections(event, new Map(), createConfigSectionCache())).toBeNull();
  });

  it("passes an older server's snapshot, which has no sections, unchanged", () => {
    const event: ServerConfigStreamSnapshotEvent = { version: 1, type: "snapshot", config };
    expect(restoreSnapshotSections(event, new Map(), createConfigSectionCache())).toBe(event);
  });
});
