import { UNIFIED_WORKSPACE_MAX_CONNECTIONS } from "@ryco/client-runtime/state/workspace";
import { EnvironmentId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../platform/appLifecycle", () => ({
  mobileAppLifecycle: { isForeground: () => true, subscribe: () => () => undefined },
}));

import { mobileHostedConnectionScopes } from "../../connection/hostedConnectionScopes";
import {
  isTaskMachineReachable,
  promoteTaskMachine,
  registerTaskConnectionDemand,
  setTaskDemandHub,
} from "./taskConnectionDemand";

const machines = ["a", "b", "c", "d", "e"].map((id) => EnvironmentId.make(`env-hub-${id}`));
const OFFLINE = EnvironmentId.make("env-hub-offline");
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const leased = () =>
  mobileHostedConnectionScopes
    .list()
    .filter((entry) => entry.scope.type === "local-tasks")
    .map((entry) => entry.environmentId);

function hub(current = true) {
  return {
    authority: "account",
    current,
    candidates: [
      ...machines.map((environmentId) => ({
        environmentId,
        eligible: true,
        ready: false,
        failed: false,
      })),
      { environmentId: OFFLINE, eligible: false, ready: false, failed: false },
    ],
  };
}

afterEach(async () => {
  setTaskDemandHub({ authority: null, current: false, candidates: [] });
  await flush();
  mobileHostedConnectionScopes.reset();
});

describe("taskConnectionDemand", () => {
  it("leases Hub machines within the warm set and never an offline one", async () => {
    setTaskDemandHub(hub());
    const release = registerTaskConnectionDemand([...machines, OFFLINE]);
    await flush();
    const held = leased();
    // The live ones plus the one being read, leaving the selected machine its slot.
    expect(held.length).toBe(UNIFIED_WORKSPACE_MAX_CONNECTIONS);
    expect(held).not.toContain(OFFLINE);
    expect(isTaskMachineReachable(machines[4]!)).toBe(true);
    expect(isTaskMachineReachable(OFFLINE)).toBe(false);

    release();
    await flush();
    expect(leased()).toEqual([]);
  });

  it("puts a machine being written to into the live set", async () => {
    setTaskDemandHub(hub());
    const release = registerTaskConnectionDemand(machines);
    await flush();
    promoteTaskMachine(machines[4]!);
    await flush();
    expect(leased()).toContain(machines[4]);
    expect(leased().length).toBeLessThanOrEqual(UNIFIED_WORKSPACE_MAX_CONNECTIONS);
    release();
  });

  it("asks for nothing until the Hub session is current", async () => {
    setTaskDemandHub(hub(false));
    const release = registerTaskConnectionDemand(machines);
    await flush();
    expect(leased()).toEqual([]);
    release();
  });
});
