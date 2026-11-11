import { describe, expect, it } from "vitest";

import {
  classifyLicenseExpression,
  licensePolicyViolation,
  normalizeLicenseExpression,
} from "./third-party-license-policy.ts";

describe("license policy", () => {
  it.each([
    ["MIT", "permissive"],
    ["mit", "permissive"],
    ["Apache 2.0", "permissive"],
    ["(MIT OR CC0-1.0)", "permissive"],
    ["MIT AND OFL-1.1", "permissive"],
    ["Apache-2.0 WITH LLVM-exception", "permissive"],
    ["(BSD-3-Clause OR GPL-2.0)", "permissive"],
    ["BlueOak-1.0.0", "permissive"],
    ["MPL-2.0", "weak-copyleft"],
    ["EPL-2.0 OR MPL-2.0", "weak-copyleft"],
    ["MIT AND MPL-2.0", "weak-copyleft"],
    ["MPL-2.0 OR MIT", "permissive"],
    ["GPL-3.0-only", "copyleft"],
    ["GPL-2.0+", "copyleft"],
    ["LGPL-3.0-or-later", "copyleft"],
    ["AGPL-3.0", "copyleft"],
    ["SSPL-1.0", "copyleft"],
    ["EUPL-1.2", "copyleft"],
    ["CC-BY-SA-4.0", "copyleft"],
    ["CC-BY-NC-4.0", "copyleft"],
    ["MIT AND GPL-2.0-only", "copyleft"],
    ["GPL-2.0-only WITH Classpath-exception-2.0", "copyleft"],
    ["SEE LICENSE IN LICENSE", "unknown"],
    ["LicenseRef-Proprietary", "unknown"],
    ["BSD", "unknown"],
    ["(MIT", "unknown"],
    ["MIT OR", "unknown"],
    ["", "unknown"],
  ])("classifies %s as %s", (expression, expected) => {
    expect(classifyLicenseExpression(expression)).toBe(expected);
  });

  it("admits weak copyleft only with a reviewed entry for that component and license", () => {
    const reviewed = [{ name: "lightningcss", license: "MPL-2.0", reason: "Unmodified." }];

    expect(licensePolicyViolation({ name: "lightningcss", license: "MPL-2.0" }, reviewed)).toBe(
      null,
    );
    expect(licensePolicyViolation({ name: "lightningcss", license: "MPL-2.0" }, [])).toContain(
      "reviewedLicenses",
    );
    expect(licensePolicyViolation({ name: "other", license: "MPL-2.0" }, reviewed)).toContain(
      "reviewedLicenses",
    );
    expect(
      licensePolicyViolation({ name: "lightningcss", license: "GPL-3.0" }, reviewed),
    ).toContain("copyleft");
  });

  it("writes license ids in canonical SPDX casing", () => {
    expect(normalizeLicenseExpression("apache-2.0")).toBe("Apache-2.0");
    expect(normalizeLicenseExpression("(mit OR cc0-1.0)")).toBe("(MIT OR CC0-1.0)");
    expect(normalizeLicenseExpression("MIT and ISC")).toBe("MIT AND ISC");
  });
});
