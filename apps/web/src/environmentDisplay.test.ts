import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isGenericLocalEnvironmentLabel,
  normalizeDisplayLabel,
  resolveEnvironmentOptionLabel,
  resolveProjectEnvironmentLabel,
} from "./environmentDisplay";

const primaryEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");

describe("environmentDisplay", () => {
  it("normalizes empty display labels", () => {
    expect(normalizeDisplayLabel("  ")).toBeNull();
    expect(normalizeDisplayLabel("  Build box  ")).toBe("Build box");
  });

  it("recognizes generic local labels", () => {
    expect(isGenericLocalEnvironmentLabel("Local")).toBe(true);
    expect(isGenericLocalEnvironmentLabel("Local environment")).toBe(true);
    expect(isGenericLocalEnvironmentLabel("Julius's Mac mini")).toBe(false);
  });

  it("hides generic local labels for the primary environment", () => {
    expect(
      resolveProjectEnvironmentLabel({
        environmentId: primaryEnvironmentId,
        label: "Local",
      }),
    ).toBeNull();
  });

  it("hides generic local labels even when the primary environment is unknown", () => {
    expect(
      resolveProjectEnvironmentLabel({
        environmentId: remoteEnvironmentId,
        label: "Local",
      }),
    ).toBeNull();
  });

  it("keeps custom primary and remote environment labels", () => {
    expect(
      resolveProjectEnvironmentLabel({
        environmentId: primaryEnvironmentId,
        label: "Julius's Mac mini",
      }),
    ).toBe("Julius's Mac mini");
    expect(
      resolveProjectEnvironmentLabel({
        environmentId: remoteEnvironmentId,
        label: "Build box",
      }),
    ).toBe("Build box");
  });
});

describe("resolveEnvironmentOptionLabel", () => {
  it("prefers the primary environment's machine label", () => {
    expect(
      resolveEnvironmentOptionLabel({
        isPrimary: true,
        environmentId: primaryEnvironmentId,
        runtimeLabel: "Julius's Mac mini",
        savedLabel: "Local environment",
      }),
    ).toBe("Julius's Mac mini");
  });

  it("falls back to 'This device' for generic primary labels", () => {
    expect(
      resolveEnvironmentOptionLabel({
        isPrimary: true,
        environmentId: primaryEnvironmentId,
        runtimeLabel: "Local environment",
        savedLabel: "Local",
      }),
    ).toBe("Device connecting…");
  });

  it("keeps configured labels for non-primary environments", () => {
    expect(
      resolveEnvironmentOptionLabel({
        isPrimary: false,
        environmentId: remoteEnvironmentId,
        runtimeLabel: null,
        savedLabel: "Build box",
      }),
    ).toBe("Build box");
  });
});
