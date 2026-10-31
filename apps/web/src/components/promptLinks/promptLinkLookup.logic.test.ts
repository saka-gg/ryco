import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolvePromptLinkLookup } from "./promptLinkLookup.logic";

const PRIMARY = EnvironmentId.make("env-primary");
const OTHER = EnvironmentId.make("env-other");

describe("resolvePromptLinkLookup", () => {
  it("holds a hosted link until the selected node's session is adoptable", () => {
    const shells = { [PRIMARY]: true, [OTHER]: true };
    // Cached or current shells are not enough: only the lifecycle owner's adoptable session is.
    expect(
      resolvePromptLinkLookup({
        hosted: true,
        hostedSessionAdoptable: false,
        primaryEnvironmentId: null,
        shellCurrentByEnvironmentId: shells,
        connections: [],
      }),
    ).toEqual({ gateOpen: false, settled: false });
    expect(
      resolvePromptLinkLookup({
        hosted: true,
        hostedSessionAdoptable: true,
        primaryEnvironmentId: null,
        shellCurrentByEnvironmentId: shells,
        connections: [],
      }),
    ).toEqual({ gateOpen: true, settled: true });
  });

  it("waits for the primary environment's shell outside hosted mode", () => {
    const input = {
      hosted: false,
      hostedSessionAdoptable: true,
      primaryEnvironmentId: PRIMARY,
      connections: [],
    } as const;
    expect(
      resolvePromptLinkLookup({ ...input, shellCurrentByEnvironmentId: { [PRIMARY]: false } })
        .gateOpen,
    ).toBe(false);
    expect(
      resolvePromptLinkLookup({ ...input, shellCurrentByEnvironmentId: { [PRIMARY]: true } }),
    ).toEqual({ gateOpen: true, settled: true });
    // A browser with saved environments only has no primary to wait for.
    expect(
      resolvePromptLinkLookup({
        ...input,
        primaryEnvironmentId: null,
        shellCurrentByEnvironmentId: {},
      }).gateOpen,
    ).toBe(true);
  });

  it("settles once every machine still connecting has its shell or stops connecting", () => {
    const base = {
      hosted: false,
      hostedSessionAdoptable: false,
      primaryEnvironmentId: PRIMARY,
    } as const;
    expect(
      resolvePromptLinkLookup({
        ...base,
        shellCurrentByEnvironmentId: { [PRIMARY]: true, [OTHER]: false },
        connections: [{ environmentId: OTHER, connectionState: "connecting" }],
      }),
    ).toEqual({ gateOpen: true, settled: false });
    expect(
      resolvePromptLinkLookup({
        ...base,
        shellCurrentByEnvironmentId: { [PRIMARY]: true, [OTHER]: false },
        connections: [{ environmentId: OTHER, connectionState: "error" }],
      }).settled,
    ).toBe(true);
    expect(
      resolvePromptLinkLookup({
        ...base,
        shellCurrentByEnvironmentId: { [PRIMARY]: true, [OTHER]: true },
        connections: [{ environmentId: OTHER, connectionState: "connecting" }],
      }).settled,
    ).toBe(true);
  });
});
