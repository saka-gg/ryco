import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentPlatformArch, ExecutionEnvironmentPlatformOs } from "./baseSchemas.ts";
import { HubEnrollmentCeremonyDetail } from "./hubConnector.ts";
import { HubSpaceRole } from "./hostedIdentity.ts";
import { RelayEffectiveRole } from "./relay.ts";
import { ColorMode } from "./settings.ts";
import { SpaceRole } from "./spaceRole.ts";

describe("shared literal unions", () => {
  it("defines the space role once; the relay and Hub roles are the same schema", () => {
    expect(SpaceRole.literals).toEqual(["viewer", "operator", "owner"]);
    expect(RelayEffectiveRole).toBe(SpaceRole);
    expect(HubSpaceRole).toBe(SpaceRole);
    expect(Schema.is(SpaceRole)("client")).toBe(false);
  });

  it("checks enrollment platforms with the environment platform literals", () => {
    expect(ExecutionEnvironmentPlatformOs.literals).toEqual([
      "darwin",
      "linux",
      "windows",
      "unknown",
    ]);
    expect(ExecutionEnvironmentPlatformArch.literals).toEqual(["arm64", "x64", "other"]);
    expect(HubEnrollmentCeremonyDetail.fields.platformOs).toBe(ExecutionEnvironmentPlatformOs);
    expect(HubEnrollmentCeremonyDetail.fields.platformArch).toBe(ExecutionEnvironmentPlatformArch);
  });

  it("accepts exactly the three color modes", () => {
    const isColorMode = Schema.is(ColorMode);
    expect(["system", "light", "dark"].every(isColorMode)).toBe(true);
    expect(isColorMode("auto")).toBe(false);
    expect(isColorMode(undefined)).toBe(false);
  });
});
