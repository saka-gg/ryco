import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import { resolveSettingsTargetEnvironmentId } from "./settingsTarget";

describe("resolveSettingsTargetEnvironmentId", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-local");
  const routedEnvironmentId = EnvironmentId.make("environment-routed");
  const activeEnvironmentId = EnvironmentId.make("environment-qa");
  const requestedEnvironmentId = EnvironmentId.make("environment-notification");

  it("uses the direct connection when selecting this desktop's Hub alias", () => {
    expect(
      resolveSettingsTargetEnvironmentId({
        requestedEnvironmentId,
        routedEnvironmentId,
        activeEnvironmentId,
        primaryEnvironmentId,
        desktopLocalEnvironmentId: requestedEnvironmentId,
      }),
    ).toBe(primaryEnvironmentId);
  });

  it("targets the active remote task instead of the local primary node", () => {
    expect(
      resolveSettingsTargetEnvironmentId({
        requestedEnvironmentId: null,
        routedEnvironmentId: null,
        activeEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(activeEnvironmentId);
  });

  it("lets an origin-bearing notification override the current task", () => {
    expect(
      resolveSettingsTargetEnvironmentId({
        requestedEnvironmentId,
        routedEnvironmentId,
        activeEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(requestedEnvironmentId);
  });

  it("keeps settings on the routed thread when the shell's active fallback changes", () => {
    expect(
      resolveSettingsTargetEnvironmentId({
        requestedEnvironmentId: null,
        routedEnvironmentId,
        activeEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(routedEnvironmentId);
  });
});
