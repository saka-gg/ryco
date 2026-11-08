import type { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildMachinePickerModel, machinePickerSelection } from "./machinePickerModel";

const MAC = "mac" as EnvironmentId;
const PI = "pi" as EnvironmentId;
const MACHINES = [
  { environmentId: MAC, label: "Mac mini", connectionState: "connected" as const },
  { environmentId: PI, label: "Pi", connectionState: "offline" as const },
];

describe("machine picker", () => {
  it("names All machines with a partial dot when one is offline", () => {
    const model = buildMachinePickerModel({ environments: MACHINES, selected: null });
    expect(model).toMatchObject({ label: "All machines", dot: "partial" });
    expect(model.actions.map((action) => [action.id, action.state, action.subtitle])).toEqual([
      ["all", "on", undefined],
      ["machine:mac", "off", "Connected"],
      ["machine:pi", "off", "Offline"],
      ["manage", undefined, undefined],
    ]);
  });

  it("names the picked machine and its own state", () => {
    const model = buildMachinePickerModel({ environments: MACHINES, selected: PI });
    expect(model).toMatchObject({ label: "Pi", dot: "offline" });
    expect(model.accessibilityLabel).toBe("Machine: Pi. Choose a machine");
  });

  it("reads an action back", () => {
    expect(machinePickerSelection("all")).toBeNull();
    expect(machinePickerSelection("machine:mac")).toBe("mac");
    expect(machinePickerSelection("manage")).toBeUndefined();
  });
});
