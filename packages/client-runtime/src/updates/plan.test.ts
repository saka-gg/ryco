import { ProviderInstanceId, type NodeUpdateState } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  nodeUpdateState as nodeState,
  updatableProvider as provider,
  updateEverythingEnvironment as environment,
} from "../../test/nodeUpdateFixtures.ts";
import {
  buildUpdateEverythingPlan,
  describeNodeInstallation,
  DEVICE_NOT_OWNER_REASON,
  DEVICE_OFFLINE_REASON,
  NODE_TOO_OLD_TO_UPDATE_REASON,
  type UpdateEverythingEnvironmentInput,
  type UpdateEverythingLocalApp,
} from "./plan.ts";

const localApp = (
  overrides: Partial<NonNullable<UpdateEverythingLocalApp>> = {},
): UpdateEverythingLocalApp => ({
  enabled: true,
  status: "available",
  currentVersion: "0.1.35",
  availableVersion: "0.1.36",
  downloadedVersion: null,
  downloadPercent: null,
  ...overrides,
});

function planOne(input: UpdateEverythingEnvironmentInput, app: UpdateEverythingLocalApp = null) {
  return buildUpdateEverythingPlan({ environments: [input], localApp: app }).devices[0]!;
}

describe("buildUpdateEverythingPlan nodes", () => {
  it("plans a one-click update through the package manager or the remote desktop app", () => {
    expect(planOne(environment("Server")).node).toEqual({
      kind: "one-click",
      fromVersion: "0.1.35",
      toVersion: "0.1.36",
      via: "package-manager",
    });
    expect(
      planOne(
        environment("Laptop", {
          nodeUpdate: nodeState({ installation: { kind: "desktop-app", service: null } }),
        }),
      ).node,
    ).toMatchObject({ kind: "one-click", via: "desktop-app" });
  });

  it("plans a manual update with the node's reason and command", () => {
    expect(
      planOne(
        environment("Checkout", {
          nodeUpdate: nodeState({
            canUpdate: false,
            installation: { kind: "source-checkout", service: null },
            manualReason: "Built from a source checkout.",
            manualCommand: "bun run node:update",
          }),
        }),
      ).node,
    ).toEqual({
      kind: "manual",
      fromVersion: "0.1.35",
      toVersion: "0.1.36",
      reason: "Built from a source checkout.",
      command: "bun run node:update",
    });
  });

  it("plans current, unknown, too-old, and already-running nodes without one-click work", () => {
    expect(
      planOne(environment("A", { nodeUpdate: nodeState({ availability: "current" }) })).node,
    ).toEqual({ kind: "current", version: "0.1.35" });
    expect(
      planOne(
        environment("B", {
          nodeUpdate: nodeState({ availability: "unknown", latestVersion: null }),
        }),
      ).node,
    ).toMatchObject({ kind: "unknown", version: "0.1.35" });
    expect(planOne(environment("C", { nodeUpdate: null })).node).toMatchObject({
      kind: "unknown",
      version: "0.1.35",
    });
    expect(planOne(environment("D", { supportsNodeUpdate: false, nodeUpdate: null })).node).toEqual(
      { kind: "unknown", version: "0.1.35", reason: NODE_TOO_OLD_TO_UPDATE_REASON },
    );
    for (const status of ["preparing", "verifying", "waiting", "restarting"] as const) {
      expect(
        planOne(
          environment("E", {
            nodeUpdate: nodeState({ run: { status, targetVersion: "0.1.36" } }),
          }),
        ).node,
      ).toEqual({ kind: "unknown", version: "0.1.35", reason: "Already updating to 0.1.36." });
    }
    // A postponed relaunch can be asked for again.
    expect(
      planOne(environment("F", { nodeUpdate: nodeState({ run: { status: "postponed" } }) })).node
        .kind,
    ).toBe("one-click");
  });

  it("installs the desktop app hosting this UI itself, never through updateNode", () => {
    const hosted = environment("Mine", {
      hostedByThisApp: true,
      nodeUpdate: nodeState({ installation: { kind: "desktop-app", service: null } }),
    });
    expect(planOne(hosted, localApp()).node).toEqual({
      kind: "this-app",
      fromVersion: "0.1.35",
      toVersion: "0.1.36",
    });
    expect(
      planOne(
        hosted,
        localApp({ status: "downloaded", availableVersion: "0.1.36", downloadedVersion: "0.1.37" }),
      ).node,
    ).toMatchObject({ kind: "this-app", toVersion: "0.1.37" });
    // The node knows a newer release before the app's updater checked.
    expect(
      planOne(hosted, localApp({ status: "idle", availableVersion: null })).node,
    ).toMatchObject({ kind: "this-app", toVersion: "0.1.36" });
    expect(
      planOne(
        { ...hosted, nodeUpdate: nodeState({ availability: "current" }) },
        localApp({ status: "up-to-date", availableVersion: null }),
      ).node,
    ).toEqual({ kind: "current", version: "0.1.35" });
    expect(
      planOne(
        { ...hosted, nodeUpdate: null },
        localApp({ status: "error", availableVersion: null }),
      ).node,
    ).toMatchObject({ kind: "unknown", version: "0.1.35" });
    // Updates off in this build: a newer release is manual, never one click.
    expect(planOne(hosted, localApp({ enabled: false })).node.kind).toBe("manual");
    expect(planOne(hosted, null).node.kind).toBe("manual");
  });
});

describe("buildUpdateEverythingPlan providers", () => {
  it("plans eligible providers as one-click and the rest of the behind ones as manual", () => {
    const plan = planOne(
      environment("Server", {
        providers: [
          provider("codex", { displayName: "Codex" }),
          provider("codex", { displayName: "Codex" }),
          provider("claudeAgent", { displayName: "Claude Code" }, { canUpdate: false }),
          provider(
            "opencode",
            {},
            { canUpdate: false, updateCommand: "npm i -g opencode", message: "Global npm" },
          ),
          provider("cursor", {}, { status: "current" }),
          provider("grok", { enabled: false }),
          provider("copilot", { installed: false }),
          provider("busy_codex", { driver: "codex" }),
          provider("queued_codex", {
            driver: "codex",
            updateState: {
              status: "queued",
              startedAt: null,
              finishedAt: null,
              message: null,
              output: null,
            },
          }),
        ],
        busyProviderInstanceIds: [ProviderInstanceId.make("busy_codex")],
      }),
    );
    expect(plan.providers).toEqual([
      {
        instanceId: "codex",
        driver: "codex",
        displayName: "Codex",
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
      },
    ]);
    expect(
      plan.manualProviders.map((entry) => [entry.instanceId, entry.command, entry.message]),
    ).toEqual([
      ["claudeAgent", null, null],
      ["opencode", "npm i -g opencode", "Global npm"],
    ]);
    expect(plan.manualProviders[0]?.displayName).toBe("Claude Code");
  });
});

describe("buildUpdateEverythingPlan devices", () => {
  it("skips offline and non-owner devices but keeps their manual items", () => {
    const withWork = {
      providers: [
        provider("codex"),
        provider("claudeAgent", {}, { canUpdate: false, updateCommand: "claude update" }),
      ],
    };
    const plan = buildUpdateEverythingPlan({
      environments: [
        environment("Offline", { ...withWork, connected: false }),
        environment("Viewer", { ...withWork, canMutate: false }),
        environment("Manual", {
          ...withWork,
          canMutate: false,
          nodeUpdate: nodeState({ canUpdate: false, manualCommand: "npm i -g ryco-cli" }),
        }),
      ],
      localApp: null,
    });
    const [manual, offline, viewer] = plan.devices;
    expect(offline).toMatchObject({
      skippedReason: DEVICE_OFFLINE_REASON,
      providers: [],
      node: { kind: "unknown", version: "0.1.35", reason: DEVICE_OFFLINE_REASON },
    });
    expect(offline?.manualProviders).toHaveLength(1);
    expect(viewer?.skippedReason).toBe(DEVICE_NOT_OWNER_REASON);
    expect(manual?.node).toMatchObject({ kind: "manual", command: "npm i -g ryco-cli" });
    expect(plan).toMatchObject({ oneClickCount: 0, manualCount: 4, hasWork: false });
  });

  it("counts one-click work, orders this app first then by label, and carries chat info", () => {
    const plan = buildUpdateEverythingPlan({
      environments: [
        environment("zeta", { providers: [provider("codex"), provider("claudeAgent")] }),
        environment("Alpha", {
          nodeUpdate: nodeState({ canUpdate: false }),
          runningChatCount: 2,
          continueThreadsAfterRestart: false,
        }),
        environment("Mine", {
          hostedByThisApp: true,
          providers: [provider("codex")],
          nodeUpdate: nodeState({ installation: { kind: "desktop-app", service: null } }),
        }),
        environment("beta", { nodeUpdate: nodeState({ availability: "current" }) }),
      ],
      localApp: localApp(),
    });
    expect(plan.devices.map((device) => device.label)).toEqual(["Mine", "Alpha", "beta", "zeta"]);
    expect(plan.devices.map((device) => device.installationLabel)).toEqual([
      "This app",
      "CLI service · npm",
      "CLI service · npm",
      "CLI service · npm",
    ]);
    // Mine: this-app + 1 provider; zeta: node + 2 providers.
    expect(plan).toMatchObject({ oneClickCount: 5, manualCount: 1, hasWork: true });
    expect(plan.devices[1]).toMatchObject({
      runningChatCount: 2,
      continuesChatsAfterRestart: false,
    });
  });

  it("labels each installation", () => {
    const label = (kind: NodeUpdateState["installation"]["kind"], service: "launchd" | null) =>
      describeNodeInstallation({ hostedByThisApp: false, installation: { kind, service } });
    expect(label("desktop-app", null)).toBe("Desktop app");
    expect(label("npm-global", "launchd")).toBe("CLI service · npm");
    expect(label("bun-global", null)).toBe("CLI · bun");
    expect(label("pnpm-global", null)).toBe("CLI · pnpm");
    expect(label("source-checkout", null)).toBe("CLI · source checkout");
    expect(label("ephemeral", null)).toBe("CLI · npx");
    expect(label("unknown", null)).toBe("CLI");
    expect(describeNodeInstallation({ hostedByThisApp: true, installation: null })).toBe(
      "This app",
    );
    expect(describeNodeInstallation({ hostedByThisApp: false, installation: null })).toBe(
      "Unknown install",
    );
  });
});
