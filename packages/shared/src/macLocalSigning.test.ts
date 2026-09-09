import { describe, expect, it } from "vitest";
import { selectLocalMacSigningIdentity } from "./macLocalSigning.js";
const one = "A".repeat(40);
const two = "B".repeat(40);
describe("free local signing identity selection", () => {
  it("selects one usable development identity by hash", () => {
    expect(
      selectLocalMacSigningIdentity(
        `1) ${one} "Apple Development: Test (TEAM)"\n 1 valid identities found`,
      ),
    ).toBe(one);
  });
  it("does not choose between developers or substitute a distribution identity", () => {
    expect(
      selectLocalMacSigningIdentity(
        `1) ${one} "Apple Development: One"\n2) ${two} "Apple Development: Two"`,
      ),
    ).toBeUndefined();
    expect(
      selectLocalMacSigningIdentity(`1) ${one} "Developer ID Application: One"`),
    ).toBeUndefined();
    expect(selectLocalMacSigningIdentity("0 valid identities found")).toBeUndefined();
  });
  it("keeps renewed certificates for the same developer usable", () => {
    expect(
      selectLocalMacSigningIdentity(
        `1) ${two} "Apple Development: Same (TEAM)"\n2) ${one} "Apple Development: Same (TEAM)"`,
      ),
    ).toBe(one);
  });
});
