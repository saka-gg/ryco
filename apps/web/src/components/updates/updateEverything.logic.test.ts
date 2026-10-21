import type { UpdateEverythingResult } from "@ryco/client-runtime/updates";
import { describe, expect, it } from "vite-plus/test";

import {
  chatRestartWarning,
  describeDeviceCard,
  describeRunResult,
  getUpdatePillView,
  nextRunParticipants,
  nodeUpdateMetaLabel,
  runProgress,
  updateEverythingDeviceEntries,
  updateEverythingPlanKey,
  updateEverythingPlanSummary,
  updateEverythingSubtitle,
  type UpdatePillInput,
} from "./updateEverything.logic";
import {
  devicePlan,
  EMPTY_PLAN,
  FULL_PLAN,
  LINUX_DEVICE,
  LINUX_ID,
  M4_DEVICE,
  M4_ID,
  OFFLINE_DEVICE,
  runDevice,
  runState,
  THIS_MAC_DEVICE,
  updatePlan,
} from "./updateEverythingTestFixtures";

const NO_RESULT: UpdateEverythingResult = {
  updatedNodes: 0,
  updatedProviders: 0,
  failures: [],
  postponed: [],
  unknown: [],
  skipped: [],
};

function pillInput(overrides: Partial<UpdatePillInput> = {}): UpdatePillInput {
  return {
    plan: FULL_PLAN,
    run: null,
    result: null,
    participants: null,
    desktopUpdate: null,
    providerUpdatesInProgress: [],
    dismissedPlanKey: null,
    ...overrides,
  };
}

describe("plan wording", () => {
  it("says this app restarts last only when it is part of the plan", () => {
    expect(updateEverythingSubtitle(FULL_PLAN)).toBe(
      "Providers update first, then each node restarts on the new Ryco. This app restarts last.",
    );
    expect(updateEverythingSubtitle(updatePlan([M4_DEVICE]))).toBe(
      "Providers update first, then each node restarts on the new Ryco.",
    );
  });

  it("summarizes one-click and manual work", () => {
    expect(updateEverythingPlanSummary(FULL_PLAN)).toBe(
      "2 Ryco updates and 3 provider updates ready. 1 update needs a manual step.",
    );
    expect(updateEverythingPlanSummary(updatePlan([LINUX_DEVICE]))).toBe(
      "Everything is up to date.",
    );
    expect(updateEverythingPlanSummary(EMPTY_PLAN)).toBe("No devices connected.");
    const manualOnly = updatePlan([
      devicePlan({
        environmentId: LINUX_ID,
        node: {
          kind: "manual",
          fromVersion: "0.1.33",
          toVersion: "0.1.35",
          reason: "Source checkouts update by hand.",
          command: "bun run node:update",
        },
      }),
    ]);
    expect(updateEverythingPlanSummary(manualOnly)).toBe("1 update needs a manual step.");
  });

  it("words the chat warning for the restart", () => {
    expect(chatRestartWarning(0, true)).toBeNull();
    expect(chatRestartWarning(1, true)).toBe("1 chat running. It continues after the restart.");
    expect(chatRestartWarning(1, false)).toBe("1 chat running. It will be interrupted.");
    expect(chatRestartWarning(3, true)).toBe("3 chats running. They continue after the restart.");
    expect(chatRestartWarning(2, false)).toBe("2 chats running. They will be interrupted.");
  });

  it("keys the plan by what one click would update", () => {
    const key = updateEverythingPlanKey(FULL_PLAN);
    expect(key).toBe(updateEverythingPlanKey(updatePlan([M4_DEVICE, THIS_MAC_DEVICE])));
    // Devices with nothing to do never change the key.
    expect(key).toBe(
      updateEverythingPlanKey(updatePlan([M4_DEVICE, THIS_MAC_DEVICE, LINUX_DEVICE])),
    );
    const newerRelease = devicePlan({
      ...M4_DEVICE,
      node: {
        kind: "one-click",
        fromVersion: "0.1.33",
        toVersion: "0.1.36",
        via: "package-manager",
      },
    });
    expect(updateEverythingPlanKey(updatePlan([newerRelease, THIS_MAC_DEVICE]))).not.toBe(key);
    expect(updateEverythingPlanKey(EMPTY_PLAN)).toBe("");
  });
});

describe("device cards", () => {
  it("describes a node update, its providers, the chat warning and manual items", () => {
    const card = describeDeviceCard({ environmentId: M4_ID, device: M4_DEVICE, run: null });
    expect(card).toMatchObject({
      label: "MacBook Pro M4",
      installationLabel: "CLI service · npm",
      dot: "muted",
      pulse: false,
      version: { kind: "change", from: "0.1.33", to: "0.1.35", emphasize: true },
      providers: [
        { name: "Claude Code", from: "2.1.40", to: "2.1.44" },
        { name: "Codex", from: "0.130", to: "0.132" },
      ],
      chatWarning: "1 chat running. It continues after the restart.",
      notes: [],
      manual: [{ text: "Copilot needs a manual update.", command: "npm i -g @github/copilot" }],
      status: null,
      canUpdate: true,
    });
  });

  it("marks an up-to-date device and warns no one about chats it never restarts", () => {
    const card = describeDeviceCard({
      environmentId: LINUX_ID,
      device: { ...LINUX_DEVICE, runningChatCount: 2 },
      run: null,
    });
    expect(card).toMatchObject({
      dot: "success",
      version: { kind: "current", version: "0.1.35" },
      chatWarning: null,
      notes: ["Up to date."],
      canUpdate: false,
    });
  });

  it("shows why a skipped device has nothing to run, once", () => {
    const card = describeDeviceCard({
      environmentId: OFFLINE_DEVICE.environmentId,
      device: OFFLINE_DEVICE,
      run: null,
    });
    expect(card.notes).toEqual(["Not connected right now."]);
    expect(card.version).toEqual({ kind: "current", version: "0.1.30" });
    expect(card.canUpdate).toBe(false);
  });

  it("offers a manual node update with its command and flags it", () => {
    const card = describeDeviceCard({
      environmentId: LINUX_ID,
      device: devicePlan({
        environmentId: LINUX_ID,
        node: {
          kind: "manual",
          fromVersion: "0.1.33",
          toVersion: "0.1.35",
          reason: "Source checkouts update by hand.",
          command: "bun run node:update",
        },
      }),
      run: null,
    });
    expect(card).toMatchObject({
      dot: "warning",
      version: { kind: "change", from: "0.1.33", to: "0.1.35", emphasize: false },
      manual: [{ text: "Source checkouts update by hand.", command: "bun run node:update" }],
      canUpdate: false,
    });
  });

  it("uses a provider's own message when there is no command to copy", () => {
    const card = describeDeviceCard({
      environmentId: M4_ID,
      device: devicePlan({
        environmentId: M4_ID,
        manualProviders: [
          { ...M4_DEVICE.manualProviders[0]!, command: null, message: "Run the installer." },
        ],
      }),
      run: null,
    });
    expect(card.manual).toEqual([
      { key: "copilot", text: "Copilot: Run the installer.", command: null },
    ]);
  });

  it("follows the run's live status", () => {
    const updating = describeDeviceCard({
      environmentId: M4_ID,
      device: M4_DEVICE,
      run: runDevice(M4_DEVICE, "updating", "Installing Ryco 0.1.35…"),
    });
    expect(updating.dot).toBe("primary");
    expect(updating.pulse).toBe(true);
    expect(updating.status).toEqual({
      label: "Updating Ryco",
      message: "Installing Ryco 0.1.35…",
      tone: "primary",
      active: true,
      failures: [],
    });

    const failed = describeDeviceCard({
      environmentId: M4_ID,
      device: M4_DEVICE,
      run: runDevice(M4_DEVICE, "failed", "1 provider update failed.", ["Codex: exit 1"]),
    });
    expect(failed).toMatchObject({
      dot: "error",
      pulse: false,
      status: { label: "Failed", tone: "error", active: false, failures: ["Codex: exit 1"] },
    });
  });

  it("does not repeat what the run's status already says", () => {
    const card = describeDeviceCard({
      environmentId: LINUX_ID,
      device: LINUX_DEVICE,
      run: runDevice(LINUX_DEVICE, "skipped", "Up to date."),
    });
    expect(card.status).toMatchObject({ label: "Skipped", message: "Up to date." });
    expect(card.notes).toEqual([]);
  });

  it("still lists a device that left the plan mid-run", () => {
    const card = describeDeviceCard({
      environmentId: M4_ID,
      device: null,
      run: runDevice(M4_DEVICE, "unknown", "The node did not report back."),
    });
    expect(card).toMatchObject({
      label: "MacBook Pro M4",
      installationLabel: null,
      dot: "warning",
      status: { label: "No answer", message: "The node did not report back." },
      canUpdate: false,
    });
  });
});

describe("device entries", () => {
  it("lists the plan's devices outside a run", () => {
    expect(
      updateEverythingDeviceEntries(FULL_PLAN, null).map((entry) => entry.environmentId),
    ).toEqual(FULL_PLAN.devices.map((device) => device.environmentId));
  });

  it("follows the run's order, keeps devices that left the plan and adds new ones", () => {
    const run = runState([runDevice(M4_DEVICE, "updating"), runDevice(THIS_MAC_DEVICE, "queued")]);
    const plan = updatePlan([THIS_MAC_DEVICE, LINUX_DEVICE]);
    const entries = updateEverythingDeviceEntries(plan, run);
    expect(
      entries.map((entry) => [entry.environmentId, entry.device !== null, entry.run !== null]),
    ).toEqual([
      [M4_DEVICE.environmentId, false, true],
      [THIS_MAC_DEVICE.environmentId, true, true],
      [LINUX_DEVICE.environmentId, true, false],
    ]);
  });
});

describe("run progress", () => {
  it("counts the devices the run set out to update, including one skipped later", () => {
    const start = runState([
      runDevice(THIS_MAC_DEVICE, "queued"),
      runDevice(LINUX_DEVICE, "skipped", "Up to date."),
      runDevice(M4_DEVICE, "providers", "Updating Codex…"),
    ]);
    const participants = nextRunParticipants(null, start);
    expect(participants?.environmentIds).toEqual([THIS_MAC_DEVICE.environmentId, M4_ID]);
    expect(runProgress(start, participants)).toMatchObject({
      done: 0,
      total: 2,
      fraction: 0.25,
      current: { environmentId: M4_ID },
    });

    const later = runState([
      runDevice(THIS_MAC_DEVICE, "updating", "Installing Ryco 0.1.35."),
      runDevice(LINUX_DEVICE, "skipped", "Up to date."),
      runDevice(M4_DEVICE, "skipped", "Lost the connection or permission to update this node."),
    ]);
    const same = nextRunParticipants(participants, later);
    expect(same).toBe(participants);
    expect(runProgress(later, same)).toMatchObject({
      done: 1,
      total: 2,
      fraction: 0.75,
      current: { environmentId: THIS_MAC_DEVICE.environmentId },
    });
    // Without the history, the device skipped later falls out of the count.
    expect(runProgress(later, null)).toMatchObject({ done: 0, total: 1 });
  });

  it("starts over for a new run and clears when none is left", () => {
    const first = nextRunParticipants(
      null,
      runState([runDevice(M4_DEVICE, "queued")], "providers", 1),
    );
    const second = nextRunParticipants(
      first,
      runState([runDevice(THIS_MAC_DEVICE, "queued")], "providers", 2),
    );
    expect(second).toEqual({ startedAt: 2, environmentIds: [THIS_MAC_DEVICE.environmentId] });
    expect(nextRunParticipants(second, null)).toBeNull();
  });
});

describe("node report", () => {
  it("names the channel and the last check", () => {
    const now = Date.parse("2026-10-21T12:00:00.000Z");
    expect(
      nodeUpdateMetaLabel({ channel: "latest", checkedAt: "2026-10-21T11:55:00.000Z" }, now),
    ).toBe("Stable channel · checked 5m ago");
    expect(nodeUpdateMetaLabel({ channel: "nightly", checkedAt: null }, now)).toBe(
      "Nightly channel · not checked yet",
    );
    expect(nodeUpdateMetaLabel(null, now)).toBeNull();
  });
});

describe("the sidebar pill", () => {
  it("offers everything one click would update", () => {
    expect(getUpdatePillView(pillInput())).toMatchObject({
      kind: "available",
      tone: "primary",
      icon: "download",
      title: "Update everything",
      count: "5",
      countLabel: "5 updates",
      progress: null,
      dismiss: "plan",
      description: "2 Ryco updates and 3 provider updates ready. 1 update needs a manual step.",
    });
  });

  it("stays hidden without one-click work, and while dismissed until the plan changes", () => {
    expect(getUpdatePillView(pillInput({ plan: updatePlan([LINUX_DEVICE]) }))).toBeNull();
    const key = updateEverythingPlanKey(FULL_PLAN);
    expect(getUpdatePillView(pillInput({ dismissedPlanKey: key }))).toBeNull();
    const changed = updatePlan([
      M4_DEVICE,
      {
        ...THIS_MAC_DEVICE,
        node: { kind: "this-app", fromVersion: "0.1.34", toVersion: "0.1.36" },
      },
    ]);
    expect(getUpdatePillView(pillInput({ plan: changed, dismissedPlanKey: key }))?.kind).toBe(
      "available",
    );
  });

  it("follows a run with the device it is busy with, done/total and a bar", () => {
    const run = runState([
      runDevice(THIS_MAC_DEVICE, "queued"),
      runDevice(LINUX_DEVICE, "skipped", "Up to date."),
      runDevice(M4_DEVICE, "updating", "Installing Ryco 0.1.35…"),
    ]);
    const view = getUpdatePillView(
      pillInput({ run, participants: nextRunParticipants(null, run), dismissedPlanKey: "x" }),
    );
    expect(view).toMatchObject({
      kind: "running",
      icon: "progress",
      title: "Updating MacBook Pro M4",
      count: "0/2",
      countLabel: "0 of 2 done",
      progress: 0.25,
      description: "Installing Ryco 0.1.35…",
      dismiss: null,
    });
  });

  it("shows a finished run's outcome until it is dismissed", () => {
    const run = runState([runDevice(M4_DEVICE, "done", "Updated Ryco to 0.1.35.")], "finished");
    expect(
      getUpdatePillView(
        pillInput({ run, result: { ...NO_RESULT, updatedNodes: 1, updatedProviders: 2 } }),
      ),
    ).toMatchObject({
      kind: "finished",
      tone: "success",
      icon: "done",
      title: "Updated 1 node and 2 providers",
      dismiss: "run",
      autoDismissMs: 4_000,
    });
    expect(
      getUpdatePillView(
        pillInput({ run, result: { ...NO_RESULT, failures: ["MacBook Pro M4 · Ryco: exit 1"] } }),
      ),
    ).toMatchObject({
      kind: "finished",
      tone: "error",
      icon: "problem",
      title: "An update failed",
      autoDismissMs: null,
    });
    // A run that did nothing at all leaves the pill to the plan.
    expect(getUpdatePillView(pillInput({ run, result: NO_RESULT }))?.kind).toBe("available");
  });

  it("shows this app's own download outside a run", () => {
    const view = getUpdatePillView(
      pillInput({
        desktopUpdate: {
          enabled: true,
          status: "downloading",
          availableVersion: "0.1.36",
          downloadPercent: 45.7,
        },
      }),
    );
    expect(view).toMatchObject({
      kind: "downloading",
      title: "Downloading Ryco 0.1.36",
      count: "45%",
      progress: 0.45,
      dismiss: null,
    });
    expect(
      getUpdatePillView(
        pillInput({
          desktopUpdate: {
            enabled: true,
            status: "downloading",
            availableVersion: null,
            downloadPercent: null,
          },
        }),
      ),
    ).toMatchObject({ title: "Downloading Ryco", count: null, progress: null });
  });

  it("shows provider updates started elsewhere", () => {
    expect(getUpdatePillView(pillInput({ providerUpdatesInProgress: ["Codex"] }))).toMatchObject({
      kind: "providers",
      title: "Updating Codex",
      description: "Codex update is in progress.",
    });
    expect(
      getUpdatePillView(pillInput({ providerUpdatesInProgress: ["Codex", "Cursor"] })),
    ).toMatchObject({
      title: "Updating 2 providers",
      description: "Codex and Cursor updates are in progress.",
    });
  });

  it("puts a running update before everything else", () => {
    const run = runState([runDevice(M4_DEVICE, "providers", "Updating Codex…")], "providers");
    expect(
      getUpdatePillView(
        pillInput({
          run,
          providerUpdatesInProgress: ["Codex"],
          desktopUpdate: {
            enabled: true,
            status: "downloading",
            availableVersion: "0.1.36",
            downloadPercent: 10,
          },
        }),
      )?.kind,
    ).toBe("running");
  });
});

describe("run results", () => {
  it("maps the runtime's description", () => {
    expect(describeRunResult(null)).toBeNull();
    expect(describeRunResult(NO_RESULT)).toBeNull();
    expect(describeRunResult({ ...NO_RESULT, updatedProviders: 1 })).toEqual({
      tone: "success",
      title: "Updated 1 provider",
      description: null,
    });
  });
});
