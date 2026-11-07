import type { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import { isLocalComputerEnvironment, preferredLocalComputerEnvironmentId } from "./localComputer";

const primary = "primary-env" as EnvironmentId;
const hub = "hub-alias-env" as EnvironmentId;
const remote = "remote-env" as EnvironmentId;

describe("local computer environment", () => {
  it("treats the direct desktop id and this Mac's Hub id as the same machine", () => {
    const local = { primaryEnvironmentId: primary, hubEnvironmentId: hub };
    expect(isLocalComputerEnvironment(primary, local)).toBe(true);
    expect(isLocalComputerEnvironment(hub, local)).toBe(true);
    expect(isLocalComputerEnvironment(remote, local)).toBe(false);
    expect(isLocalComputerEnvironment(null, local)).toBe(false);
  });

  it("prefers the direct desktop connection over the Hub entry", () => {
    expect(
      preferredLocalComputerEnvironmentId({ primaryEnvironmentId: primary, hubEnvironmentId: hub }),
    ).toBe(primary);
    expect(
      preferredLocalComputerEnvironmentId({ primaryEnvironmentId: null, hubEnvironmentId: hub }),
    ).toBe(hub);
  });

  it("never matches when neither id is known", () => {
    const local = { primaryEnvironmentId: null, hubEnvironmentId: null };
    expect(isLocalComputerEnvironment(remote, local)).toBe(false);
    expect(preferredLocalComputerEnvironmentId(local)).toBeNull();
  });
});
