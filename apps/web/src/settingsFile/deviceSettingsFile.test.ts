import type { SharingDevice } from "@ryco/client-runtime/state/settings/sharedDeviceSettings";
import { EnvironmentId, type ServerConfig } from "@ryco/contracts";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings,
  type SettingsSharingStamp,
} from "@ryco/contracts/settings";
import { SETTINGS_SHARING_VERSION } from "@ryco/shared/settingsSharing";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_APPEARANCE_PREFERENCES } from "../themes/appearancePreferences";
import { buildClientSettingsFile, planClientSettingsImport } from "./clientSettingsFile";
import {
  buildDeviceSettingsRestoreCommands,
  buildDeviceSettingsSection,
  DEVICE_SETTINGS_FILE_KEYS,
  previewDeviceSettingsRestore,
  readDeviceSettingsSection,
  summarizeDeviceSettingsRestore,
} from "./deviceSettingsFile";

const MAC = EnvironmentId.make("env-mac");
const BUILD = EnvironmentId.make("env-build");
const PI = EnvironmentId.make("env-pi");

const stamp = (at: number): SettingsSharingStamp => ({ at, by: "client-a" });

function device(
  environmentId: EnvironmentId,
  settings: Partial<ServerSettings>,
  overrides: Partial<SharingDevice> & { readonly sharingVersion?: number | null } = {},
): SharingDevice {
  const { sharingVersion = SETTINGS_SHARING_VERSION, ...rest } = overrides;
  const config = {
    environment: {
      environmentId,
      label: environmentId,
      capabilities: sharingVersion === null ? {} : { settingsSharingVersion: sharingVersion },
    },
    settings: { ...DEFAULT_SERVER_SETTINGS, ...settings },
  } as unknown as ServerConfig;
  return { environmentId, label: environmentId, config, connected: true, canWrite: true, ...rest };
}

const appState = {
  client: DEFAULT_CLIENT_SETTINGS,
  appearance: DEFAULT_APPEARANCE_PREFERENCES,
  colorMode: "system" as const,
  activeThemeId: "default",
  customThemes: [],
};
const themeOptions = { newThemeId: (theme: { id: string }) => theme.id, themeExists: () => true };

describe("device settings section", () => {
  it("carries shareable settings only: no paths, providers or default models", () => {
    expect(DEVICE_SETTINGS_FILE_KEYS).toContain("worktreeBranchPrefix");
    for (const key of [
      "worktreeRoot",
      "chatsRoot",
      "addProjectBaseDirectory",
      "providerInstances",
      "cliProxyHubs",
      "initialModelSelection",
      "textGenerationModelSelection",
      "settingsSharing",
    ]) {
      expect(DEVICE_SETTINGS_FILE_KEYS as ReadonlyArray<string>).not.toContain(key);
    }
  });

  it("backs up the newest shared value, else the agreed one, else the preferred device's", () => {
    const section = buildDeviceSettingsSection({
      devices: [
        device(MAC, {
          worktreeBranchPrefix: "old",
          gitWritingStyle: "conventional",
          settingsSharing: { worktreeBranchPrefix: { mode: "shared", stamp: stamp(1) } },
        }),
        device(
          BUILD,
          {
            worktreeBranchPrefix: "team",
            gitWritingStyle: "repository",
            settingsSharing: { worktreeBranchPrefix: { mode: "shared", stamp: stamp(5) } },
          },
          { connected: false },
        ),
      ],
      preferred: BUILD,
    });
    expect(section.worktreeBranchPrefix).toBe("team");
    expect(section.gitWritingStyle).toBe("repository");
    expect(section.pullRequestTemplates).toBe(true);
    expect(Object.keys(section)).not.toContain("worktreeRoot");
  });

  it("reads a section against each setting's schema and lists what it refuses", () => {
    const read = readDeviceSettingsSection({
      worktreeBranchPrefix: "team",
      threadAutoSettleAfterDays: null,
      gitWritingStyle: "shouting",
      worktreeRoot: "/Users/me/w",
      providerInstances: {},
    });
    expect(read?.values).toEqual({ worktreeBranchPrefix: "team", threadAutoSettleAfterDays: null });
    expect(read?.warnings).toEqual([
      "gitWritingStyle: invalid value, kept the current one",
      "worktreeRoot: not a device setting this file carries, left as it is",
      "providerInstances: not a device setting this file carries, left as it is",
    ]);
    expect(readDeviceSettingsSection(undefined)).toBeNull();
    expect(readDeviceSettingsSection([])?.warnings).toEqual(["deviceSettings: not an object"]);
  });

  it("keeps old files working and reads a file with device settings only", () => {
    const oldFile = buildClientSettingsFile(appState, new Date(0));
    expect("deviceSettings" in oldFile).toBe(false);
    const oldPlan = planClientSettingsImport(oldFile, appState, themeOptions);
    expect(oldPlan).toMatchObject({ hasAppSettings: true, deviceSettings: null, changes: [] });

    const deviceOnly = buildClientSettingsFile(null, new Date(0), { worktreeBranchPrefix: "team" });
    expect(Object.keys(deviceOnly).toSorted()).toEqual([
      "deviceSettings",
      "exportedAt",
      "format",
      "version",
    ]);
    const plan = planClientSettingsImport(
      JSON.parse(JSON.stringify(deviceOnly)),
      appState,
      themeOptions,
    );
    expect(plan.hasAppSettings).toBe(false);
    expect(plan.changes).toEqual([]);
    expect(plan.deviceSettings?.values).toEqual({ worktreeBranchPrefix: "team" });
  });
});

describe("restoring device settings", () => {
  const values = { worktreeBranchPrefix: "team", pullRequestTemplates: false } as const;
  let at = 100;
  const nextStamp = () => stamp((at += 1));

  it("to every device: one shared write per key, offline devices wait, own values stay", () => {
    const devices = [
      device(MAC, {}),
      device(BUILD, {}, { connected: false }),
      device(PI, {
        worktreeBranchPrefix: "pi",
        settingsSharing: { worktreeBranchPrefix: { mode: "override", stamp: stamp(3) } },
      }),
    ];
    const previews = previewDeviceSettingsRestore({ values, devices, targets: { kind: "every" } });
    expect(previews.map((preview) => [preview.label, preview.changes, preview.waits])).toEqual([
      [
        MAC,
        ['worktreeBranchPrefix: "ryco" -> "team"', "pullRequestTemplates: true -> false"],
        null,
      ],
      [
        BUILD,
        ['worktreeBranchPrefix: "ryco" -> "team"', "pullRequestTemplates: true -> false"],
        "offline",
      ],
      [PI, ["pullRequestTemplates: true -> false"], null],
    ]);
    expect(previews[2]!.keepsOwn).toEqual(["worktreeBranchPrefix"]);

    const commands = buildDeviceSettingsRestoreCommands({
      values,
      devices,
      targets: { kind: "every" },
      nextStamp,
    })!;
    expect(commands.map((command) => command.key)).toEqual([
      "worktreeBranchPrefix",
      "pullRequestTemplates",
    ]);
    const [prefix] = commands;
    expect(prefix!.writes.map((write) => write.environmentId)).toEqual([MAC]);
    expect(prefix!.writes[0]!.patch).toMatchObject({
      worktreeBranchPrefix: "team",
      settingsSharing: { worktreeBranchPrefix: { mode: "shared", onlyIfOlderShared: true } },
    });
    expect(prefix!.skipped.map((skip) => [skip.environmentId, skip.reason])).toEqual([
      [BUILD, "offline"],
      [PI, "override"],
    ]);

    const outcomes = summarizeDeviceSettingsRestore(
      devices,
      commands.map((command) => ({
        command,
        result: {
          applied: command.writes.map((write) => ({
            environmentId: write.environmentId,
            label: write.environmentId,
          })),
          notApplied: [],
        },
      })),
    );
    expect(
      outcomes.map((outcome) => [outcome.label, outcome.applied, outcome.queued, outcome.kept]),
    ).toEqual([
      [MAC, ["worktreeBranchPrefix", "pullRequestTemplates"], [], []],
      [BUILD, [], ["worktreeBranchPrefix", "pullRequestTemplates"], []],
      [PI, ["pullRequestTemplates"], [], [{ key: "worktreeBranchPrefix", reason: "override" }]],
    ]);
  });

  it("to every device: a device on an older Ryco gets a plain edit", () => {
    const devices = [device(MAC, {}), device(BUILD, {}, { sharingVersion: null })];
    const commands = buildDeviceSettingsRestoreCommands({
      values: { worktreeBranchPrefix: "team" },
      devices,
      targets: { kind: "every" },
      nextStamp,
    })!;
    expect(commands).toHaveLength(2);
    expect(commands[1]!.writes).toEqual([
      { environmentId: BUILD, patch: { worktreeBranchPrefix: "team" } },
    ]);
    const outcomes = summarizeDeviceSettingsRestore(
      devices,
      commands.map((command) => ({
        command,
        result: {
          applied: command.writes.map((write) => ({
            environmentId: write.environmentId,
            label: write.environmentId,
          })),
          notApplied: [],
        },
      })),
    );
    expect(outcomes.map((outcome) => [outcome.label, outcome.applied, outcome.kept])).toEqual([
      [MAC, ["worktreeBranchPrefix"], []],
      [BUILD, ["worktreeBranchPrefix"], []],
    ]);
  });

  it("to picked devices: each gets its own value, and only the picked ones", () => {
    const devices = [device(MAC, {}), device(BUILD, {})];
    const targets = { kind: "chosen", environmentIds: new Set([BUILD]) } as const;
    const previews = previewDeviceSettingsRestore({ values, devices, targets });
    expect(previews.map((preview) => [preview.label, preview.becomesOwn])).toEqual([
      [BUILD, ["worktreeBranchPrefix", "pullRequestTemplates"]],
    ]);
    const commands = buildDeviceSettingsRestoreCommands({ values, devices, targets, nextStamp })!;
    expect(
      commands.flatMap((command) => command.writes.map((write) => write.environmentId)),
    ).toEqual([BUILD, BUILD]);
    expect(commands[0]!.writes[0]!.patch).toMatchObject({
      worktreeBranchPrefix: "team",
      settingsSharing: { worktreeBranchPrefix: { mode: "override" } },
    });
  });

  it("writes nothing for values every device already holds, and nothing without a stamp", () => {
    const devices = [device(MAC, { worktreeBranchPrefix: "team", pullRequestTemplates: false })];
    expect(
      buildDeviceSettingsRestoreCommands({
        values,
        devices,
        targets: { kind: "every" },
        nextStamp,
      }),
    ).toEqual([]);
    expect(
      buildDeviceSettingsRestoreCommands({
        values,
        devices: [device(MAC, {})],
        targets: { kind: "every" },
        nextStamp: () => null,
      }),
    ).toBeNull();
  });

  it("reports a refused value per device", () => {
    const devices = [device(MAC, {}), device(BUILD, {})];
    const commands = buildDeviceSettingsRestoreCommands({
      values: { worktreeBranchPrefix: "team" },
      devices,
      targets: { kind: "every" },
      nextStamp,
    })!;
    const outcomes = summarizeDeviceSettingsRestore(devices, [
      {
        command: commands[0]!,
        result: {
          applied: [{ environmentId: MAC, label: MAC }],
          notApplied: [{ environmentId: BUILD, label: BUILD, reason: "failed", detail: "No." }],
        },
      },
    ]);
    expect(outcomes[1]).toMatchObject({
      applied: [],
      failed: [{ key: "worktreeBranchPrefix", detail: "No." }],
    });
  });
});
