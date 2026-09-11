import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@ryco/contracts";
import { isLocalHubAlias, resolveDeviceName } from "./deviceName.logic";
const primary = EnvironmentId.make("direct");
const alias = EnvironmentId.make("hub-alias");
const remote = EnvironmentId.make("remote");
describe("device display names", () => {
  it("hides only the colocated Hub alias when a direct device is present", () => {
    expect(isLocalHubAlias(alias, primary, alias)).toBe(true);
    expect(isLocalHubAlias(primary, primary, alias)).toBe(false);
    expect(isLocalHubAlias(remote, primary, alias)).toBe(false);
    expect(isLocalHubAlias(alias, null, alias)).toBe(false);
    expect(isLocalHubAlias(primary, primary, primary)).toBe(false);
  });

  it("uses the custom Hub name for the direct device without borrowing another device's name", () => {
    const input = {
      primaryEnvironmentId: primary,
      localHubEnvironmentId: alias,
      machines: [
        { environmentId: alias, label: "Laurin’s MacBook Pro" },
        { environmentId: remote, label: "Build server" },
      ],
      fallback: "System hostname",
    };
    expect(resolveDeviceName({ ...input, environmentId: primary })).toBe("Laurin’s MacBook Pro");
    expect(resolveDeviceName({ ...input, environmentId: remote })).toBe("Build server");
    expect(resolveDeviceName({ ...input, environmentId: null })).toBe("System hostname");
    expect(resolveDeviceName({ ...input, machines: [], environmentId: primary })).toBe(
      "System hostname",
    );
  });
  it("uses the available descriptor during startup and changes when the catalog is renamed", () => {
    expect(
      resolveDeviceName({ environmentId: primary, machines: [], fallback: " Studio Mac " }),
    ).toBe("Studio Mac");
    expect(
      resolveDeviceName({
        environmentId: primary,
        machines: [{ environmentId: primary, label: "Renamed Mac" }],
        fallback: "Studio Mac",
      }),
    ).toBe("Renamed Mac");
  });
});
