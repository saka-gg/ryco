import {
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  ServerSettingsPatch,
  type SettingsSharingStamp,
} from "@ryco/contracts/settings";
import { ExecutionEnvironmentCapabilities } from "@ryco/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { applyServerSettingsPatch } from "./serverSettings.ts";
import {
  SERVER_SETTING_SHARING,
  SETTINGS_SHARING_VERSION,
  SHAREABLE_SERVER_SETTING_KEYS,
  SHAREABLE_SETTING_SINCE_VERSION,
  ZERO_SHARING_STAMP,
  compareSharingStamps,
  readShareableSettingValue,
  readSharingEntry,
  readWrittenShareableSettingValue,
  recordWrittenSettingValues,
  shareableSettingValuePatch,
  settingSharedAtVersion,
  shareableSettingValuesEqual,
} from "./settingsSharing.ts";

const stamp = (at: number, by = "client-a"): SettingsSharingStamp => ({ at, by });

const withSharing = (
  sharing: ServerSettings["settingsSharing"],
  overrides: Partial<ServerSettings> = {},
): ServerSettings => ({ ...DEFAULT_SERVER_SETTINGS, ...overrides, settingsSharing: sharing });

describe("settings sharing catalog", () => {
  it("classifies every ServerSettings key, and nothing else", () => {
    expect(Object.keys(SERVER_SETTING_SHARING).toSorted()).toEqual(
      Object.keys(ServerSettings.fields).toSorted(),
    );
  });

  it("keeps project maps, identity, power, providers, hubs, observability and secrets per device", () => {
    for (const key of [
      "projectPreferences",
      "projectWorktreeRoots",
      "projectWorktreeSubmodules",
      "projectGitWritingStyle",
      "projectStorageRetention",
      "projectLifecycleSuggestions",
      "environmentIcon",
      "lowerAgentProcessPriority",
      "providers",
      "providerInstances",
      "cliProxyHubs",
      "observability",
      "providerEventLogs",
      "settingsSharing",
    ] as const)
      expect(SERVER_SETTING_SHARING[key], key).toBe("device-only");
    for (const key of ["worktreeRoot", "chatsRoot", "addProjectBaseDirectory"] as const)
      expect(SERVER_SETTING_SHARING[key], key).toBe("shareable");
  });

  it("writes every shareable key with a patch the node reads back as the same value", () => {
    const changed: Partial<Record<(typeof SHAREABLE_SERVER_SETTING_KEYS)[number], unknown>> = {
      worktreeBranchPrefix: "team",
      responseStreamingMode: "token",
      threadAutoSettleAfterDays: null,
      usagePriceOverrides: { "model-x": { mapTo: "model-y" } },
      agentControl: { enabled: true, delegation: { maxDepth: 2, maxTasksPerTree: null } },
      storageRetention: { automatic: true, completedWorktreeDays: 7, temporaryDataDays: 3 },
    };
    for (const key of SHAREABLE_SERVER_SETTING_KEYS) {
      const value = (changed[key] ??
        readShareableSettingValue(DEFAULT_SERVER_SETTINGS, key)) as never;
      const patch = shareableSettingValuePatch(key, value, DEFAULT_SERVER_SETTINGS);
      expect(Exit.isSuccess(Schema.decodeUnknownExit(ServerSettingsPatch)(patch)), key).toBe(true);
      const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, patch);
      const decoded = Schema.decodeUnknownSync(ServerSettings)(next);
      expect(shareableSettingValuesEqual(readShareableSettingValue(decoded, key), value), key).toBe(
        true,
      );
    }
  });

  it("replaces a price map whole, removing models the shared value does not hold", () => {
    const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      usagePriceOverrides: { old: { mapTo: "x" }, kept: { mapTo: "y" } },
    });
    const next = applyServerSettingsPatch(
      current,
      shareableSettingValuePatch("usagePriceOverrides", { kept: { mapTo: "z" } }, current),
    );
    expect(next.usagePriceOverrides).toEqual({ kept: { mapTo: "z" } });
  });

  it("reads the auto-settle rule's default while it is unset, and Off as Off", () => {
    expect(
      readShareableSettingValue(
        { ...DEFAULT_SERVER_SETTINGS, threadAutoSettleAfterDays: null },
        "threadAutoSettleAfterDays",
      ),
    ).toBeNull();
    expect(readShareableSettingValue(DEFAULT_SERVER_SETTINGS, "threadAutoSettleAfterDays")).toBe(
      readShareableSettingValue(
        { ...DEFAULT_SERVER_SETTINGS, threadAutoSettleAfterDays: 7 },
        "threadAutoSettleAfterDays",
      ),
    );
  });
});

describe("sharing stamps", () => {
  it("orders by time, then writer id, the same on every client", () => {
    expect(compareSharingStamps(stamp(1), stamp(2))).toBe(-1);
    expect(compareSharingStamps(stamp(2, "a"), stamp(2, "b"))).toBe(-1);
    expect(compareSharingStamps(stamp(2, "b"), stamp(2, "a"))).toBe(1);
    expect(compareSharingStamps(stamp(2), stamp(2))).toBe(0);
    expect(compareSharingStamps(ZERO_SHARING_STAMP, stamp(1))).toBe(-1);
  });

  it("reads a missing entry as shared with the zero stamp", () => {
    expect(readSharingEntry({}, "worktreeRoot")).toEqual({
      mode: "shared",
      stamp: ZERO_SHARING_STAMP,
    });
  });

  it("refuses zero, negative or fractional times and empty or long writer ids", () => {
    const decode = Schema.decodeUnknownExit(ServerSettingsPatch);
    for (const bad of [
      { at: 0, by: "a" },
      { at: -1, by: "a" },
      { at: 1.5, by: "a" },
      { at: 1, by: "" },
      { at: 1, by: "x".repeat(129) },
    ])
      expect(
        Exit.isFailure(
          decode({ settingsSharing: { worktreeRoot: { mode: "shared", stamp: bad } } }),
        ),
        JSON.stringify(bad),
      ).toBe(true);
  });

  it("decodes settings without a sharing record to the empty default", () => {
    expect(Schema.decodeUnknownSync(ServerSettings)({}).settingsSharing).toEqual({});
  });

  it("advertises a small sharing version, not key names", () => {
    const decoded = Schema.decodeUnknownSync(ExecutionEnvironmentCapabilities)({
      settingsSharingVersion: SETTINGS_SHARING_VERSION,
    });
    expect(decoded.settingsSharingVersion).toBe(SETTINGS_SHARING_VERSION);
    expect(() =>
      Schema.decodeUnknownSync(ExecutionEnvironmentCapabilities)({ settingsSharingVersion: 0 }),
    ).toThrow();
  });

  it("gives every shareable key a version this build covers", () => {
    expect(Object.keys(SHAREABLE_SETTING_SINCE_VERSION).toSorted()).toEqual(
      [...SHAREABLE_SERVER_SETTING_KEYS].toSorted(),
    );
    for (const key of SHAREABLE_SERVER_SETTING_KEYS)
      expect(settingSharedAtVersion(SETTINGS_SHARING_VERSION, key), key).toBe(true);
  });

  it("shares a key only with nodes whose version covers it", () => {
    const since = { ...SHAREABLE_SETTING_SINCE_VERSION, chatsRoot: 2 };
    expect(settingSharedAtVersion(1, "worktreeRoot", since)).toBe(true);
    expect(settingSharedAtVersion(1, "chatsRoot", since)).toBe(false);
    expect(settingSharedAtVersion(2, "chatsRoot", since)).toBe(true);
    // A node newer than this build still shares the keys both know.
    expect(settingSharedAtVersion(99, "worktreeRoot", since)).toBe(true);
    // An older Ryco, or a malformed version.
    expect(settingSharedAtVersion(undefined, "worktreeRoot")).toBe(false);
    expect(settingSharedAtVersion(0, "worktreeRoot")).toBe(false);
    expect(settingSharedAtVersion(1.5, "worktreeRoot")).toBe(false);
  });
});

describe("applying a sharing patch", () => {
  it("writes a value and its entry in one result", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      worktreeBranchPrefix: "team",
      settingsSharing: { worktreeBranchPrefix: { mode: "shared", stamp: stamp(5) } },
    });
    expect(next.worktreeBranchPrefix).toBe("team");
    expect(next.settingsSharing).toEqual({
      worktreeBranchPrefix: { mode: "shared", stamp: stamp(5) },
    });
  });

  it("rejects entries for device-only or unknown keys", () => {
    for (const key of ["environmentIcon", "providerInstances", "settingsSharing", "nope"])
      expect(() =>
        applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
          settingsSharing: { [key]: { mode: "override", stamp: stamp(1) } },
        }),
      ).toThrow(/not a shared setting/);
  });

  it("rejects a shared entry without its value", () => {
    expect(() =>
      applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        settingsSharing: { worktreeBranchPrefix: { mode: "shared", stamp: stamp(1) } },
      }),
    ).toThrow(/must be written with its value/);
  });

  it("lets an override keep the device's value", () => {
    const current = withSharing({}, { worktreeBranchPrefix: "mine" });
    const next = applyServerSettingsPatch(current, {
      settingsSharing: { worktreeBranchPrefix: { mode: "override", stamp: stamp(3) } },
    });
    expect(next.worktreeBranchPrefix).toBe("mine");
    expect(next.settingsSharing.worktreeBranchPrefix?.mode).toBe("override");
  });

  it("applies a catch-up only to a shared device holding an older stamp", () => {
    const catchUp = (at: number): ServerSettingsPatch => ({
      worktreeBranchPrefix: "newest",
      settingsSharing: {
        worktreeBranchPrefix: { mode: "shared", stamp: stamp(at), onlyIfOlderShared: true },
      },
    });
    const older = withSharing(
      { worktreeBranchPrefix: { mode: "shared", stamp: stamp(2) } },
      { worktreeBranchPrefix: "old" },
    );
    expect(applyServerSettingsPatch(older, catchUp(3)).worktreeBranchPrefix).toBe("newest");
    // Not older: the same stamp twice, or a newer one already there.
    expect(applyServerSettingsPatch(older, catchUp(2))).toEqual(older);
    expect(applyServerSettingsPatch(older, catchUp(1))).toEqual(older);
    // An override keeps its value, whatever the stamp.
    const override = withSharing(
      { worktreeBranchPrefix: { mode: "override", stamp: stamp(1) } },
      { worktreeBranchPrefix: "mine" },
    );
    expect(applyServerSettingsPatch(override, catchUp(9))).toEqual(override);
  });

  it("drops a skipped catch-up's companion fields too, but keeps the rest of the patch", () => {
    const current = withSharing(
      { responseStreamingMode: { mode: "override", stamp: stamp(1) } },
      { responseStreamingMode: "turn" },
    );
    const next = applyServerSettingsPatch(current, {
      responseStreamingMode: "token",
      enableLegacyTokenStreaming: true,
      worktreeBranchPrefix: "team",
      settingsSharing: {
        responseStreamingMode: { mode: "shared", stamp: stamp(4), onlyIfOlderShared: true },
        worktreeBranchPrefix: { mode: "shared", stamp: stamp(4), onlyIfOlderShared: true },
      },
    });
    expect(next.responseStreamingMode).toBe("turn");
    expect(next.worktreeBranchPrefix).toBe("team");
    expect(next.settingsSharing.worktreeBranchPrefix?.stamp).toEqual(stamp(4));
  });

  it("turns an unstamped change of a stamped shared key into an override on that device", () => {
    const current = withSharing(
      { worktreeBranchPrefix: { mode: "shared", stamp: stamp(7) } },
      { worktreeBranchPrefix: "shared" },
    );
    const next = applyServerSettingsPatch(current, { worktreeBranchPrefix: "local" });
    expect(next.settingsSharing.worktreeBranchPrefix).toEqual({
      mode: "override",
      stamp: stamp(7),
    });
    // The same value again changes nothing.
    expect(
      applyServerSettingsPatch(current, { worktreeBranchPrefix: "shared" }).settingsSharing,
    ).toEqual(current.settingsSharing);
  });

  it("leaves keys on the zero stamp alone when an unstamped edit changes them (rollout)", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { worktreeBranchPrefix: "x" });
    expect(next.settingsSharing).toEqual({});
  });

  it("removes an entry on null, back to shared with the zero stamp", () => {
    const current = withSharing({ worktreeBranchPrefix: { mode: "override", stamp: stamp(1) } });
    const next = applyServerSettingsPatch(current, {
      settingsSharing: { worktreeBranchPrefix: null },
    });
    expect(next.settingsSharing).toEqual({});
  });
});

describe("shared paths as written", () => {
  /** A node's write: the path recorded as written, then normalized for this machine. */
  const nodeApply = (current: ServerSettings, patch: ServerSettingsPatch, home: string) => {
    const recorded = recordWrittenSettingValues(patch);
    const normalized =
      typeof recorded.worktreeRoot === "string" && recorded.worktreeRoot.startsWith("~/")
        ? { ...recorded, worktreeRoot: `${home}/${recorded.worktreeRoot.slice(2)}` }
        : recorded;
    return applyServerSettingsPatch(current, normalized);
  };

  it("keeps the path as written next to the value the node normalized", () => {
    const next = nodeApply(
      DEFAULT_SERVER_SETTINGS,
      {
        worktreeRoot: "~/w",
        settingsSharing: { worktreeRoot: { mode: "shared", stamp: stamp(5) } },
      },
      "/Users/me",
    );
    expect(next.worktreeRoot).toBe("/Users/me/w");
    expect(next.settingsSharing.worktreeRoot).toEqual({
      mode: "shared",
      stamp: stamp(5),
      written: "~/w",
    });
    expect(readWrittenShareableSettingValue(next, "worktreeRoot")).toBe("~/w");
    expect(readShareableSettingValue(next, "worktreeRoot")).toBe("/Users/me/w");
  });

  it("records what the patch carries, never a written value of the writer's own", () => {
    expect(
      recordWrittenSettingValues({
        worktreeRoot: "~/w",
        settingsSharing: {
          worktreeRoot: { mode: "shared", stamp: stamp(5), written: "/elsewhere" },
        },
      }).settingsSharing?.worktreeRoot,
    ).toEqual({ mode: "shared", stamp: stamp(5), written: "~/w" });
    // Without the value, a written value means nothing.
    expect(
      recordWrittenSettingValues({
        settingsSharing: { chatsRoot: { mode: "override", stamp: stamp(5), written: "~/c" } },
      }).settingsSharing?.chatsRoot,
    ).toEqual({ mode: "override", stamp: stamp(5) });
    // Other keys keep no written value.
    const prefix = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      worktreeBranchPrefix: "me",
      settingsSharing: {
        worktreeBranchPrefix: { mode: "shared", stamp: stamp(5), written: "me" },
      },
    });
    expect(prefix.settingsSharing.worktreeBranchPrefix).toEqual({
      mode: "shared",
      stamp: stamp(5),
    });
  });

  it("keeps the written path while the value stays, and drops it once the value changes", () => {
    const sharedRoot = nodeApply(
      DEFAULT_SERVER_SETTINGS,
      {
        worktreeRoot: "~/w",
        settingsSharing: { worktreeRoot: { mode: "shared", stamp: stamp(5) } },
      },
      "/home/me",
    );
    // "Keep its own value" without a value: the path and its written form stay.
    const kept = applyServerSettingsPatch(sharedRoot, {
      settingsSharing: { worktreeRoot: { mode: "override", stamp: stamp(6) } },
    });
    expect(kept.settingsSharing.worktreeRoot).toEqual({
      mode: "override",
      stamp: stamp(6),
      written: "~/w",
    });
    // An unrelated edit changes nothing about it.
    expect(
      applyServerSettingsPatch(sharedRoot, { worktreeBranchPrefix: "x" }).settingsSharing
        .worktreeRoot,
    ).toEqual(sharedRoot.settingsSharing.worktreeRoot);
    // An unstamped edit of the path: an override, and the old written form is gone.
    const edited = applyServerSettingsPatch(sharedRoot, { worktreeRoot: "/srv/w" });
    expect(edited.settingsSharing.worktreeRoot).toEqual({ mode: "override", stamp: stamp(5) });
    expect(readWrittenShareableSettingValue(edited, "worktreeRoot")).toBe("/srv/w");
    // The same on an override.
    const overrideEdit = applyServerSettingsPatch(kept, { worktreeRoot: "/srv/w" });
    expect(overrideEdit.settingsSharing.worktreeRoot).toEqual({
      mode: "override",
      stamp: stamp(6),
    });
  });

  it("reads entries from before written values by their stored value", () => {
    const old = withSharing(
      { worktreeRoot: { mode: "shared", stamp: stamp(5) } },
      { worktreeRoot: "/Users/me/w" },
    );
    expect(readWrittenShareableSettingValue(old, "worktreeRoot")).toBe("/Users/me/w");
    expect(Schema.decodeUnknownSync(ServerSettings)(old).settingsSharing.worktreeRoot).toEqual({
      mode: "shared",
      stamp: stamp(5),
    });
  });
});
