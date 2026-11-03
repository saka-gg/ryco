import { describe, expect, it } from "vitest";

import {
  availabilityFromProbe,
  capabilityUnavailableMessage,
  describeBrokenCapabilities,
  parseHelperProbe,
} from "./helperCapabilities.ts";

/** A probe payload with every capability healthy. */
const healthyProbe = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    ok: true,
    protocolVersion: 1,
    capabilities: {
      framebuffer: "ok",
      hid: "ok",
      accessibility: "ok",
      encoder: "ok",
    },
    toolchain: { xcodeVersion: "26.2", xcodeBuild: "17C52", macOS: "Version 26.3" },
    ...overrides,
  });

describe("parseHelperProbe", () => {
  it("reads every capability and the toolchain from a healthy probe", () => {
    const probe = parseHelperProbe(healthyProbe());

    expect(probe.ok).toBe(true);
    expect(probe.capabilities.map((capability) => capability.id)).toEqual([
      "framebuffer",
      "hid",
      "accessibility",
      "encoder",
    ]);
    expect(probe.capabilities.every((capability) => capability.ok)).toBe(true);
    expect(probe.toolchain).toEqual({
      xcodeVersion: "26.2",
      xcodeBuild: "17C52",
      macOS: "Version 26.3",
    });
  });

  it("captures the missing symbol for a broken capability", () => {
    const probe = parseHelperProbe(
      healthyProbe({
        ok: false,
        capabilities: {
          framebuffer: "ok",
          hid: "ok",
          accessibility: { missingSymbol: "AXPTranslator", purpose: "translates the tree" },
          encoder: "ok",
        },
      }),
    );

    expect(probe.ok).toBe(false);
    const accessibility = probe.capabilities.find((entry) => entry.id === "accessibility");
    expect(accessibility).toMatchObject({ ok: false, missingSymbol: "AXPTranslator" });
    // The others are untouched: that separation is the whole point.
    expect(probe.capabilities.filter((entry) => entry.ok)).toHaveLength(3);
  });

  it("treats an unreported capability as broken rather than assuming it works", () => {
    const probe = parseHelperProbe(
      JSON.stringify({ ok: true, capabilities: { framebuffer: "ok", hid: "ok" } }),
    );

    // An older helper genuinely cannot provide what it never measured; claiming
    // otherwise would surface as a mystery failure at the point of use.
    expect(probe.capabilities.find((entry) => entry.id === "accessibility")?.ok).toBe(false);
    expect(probe.ok).toBe(false);
  });

  it("degrades rather than throwing on unreadable output", () => {
    const probe = parseHelperProbe("not json at all");

    expect(probe.ok).toBe(false);
    expect(probe.capabilities).toHaveLength(4);
    expect(probe.capabilities.every((capability) => !capability.ok)).toBe(true);
  });

  it("trusts a helper too old to report capabilities at all", () => {
    const probe = parseHelperProbe(JSON.stringify({ ok: true, protocolVersion: 1 }));

    expect(probe.ok).toBe(true);
    expect(probe.capabilities).toEqual([]);
  });

  it("reads the input transport and the CoreSimulator version", () => {
    const probe = parseHelperProbe(
      healthyProbe({
        inputTransport: "dtuhid",
        toolchain: {
          xcodeVersion: "27.1",
          xcodeBuild: "27A9275",
          coreSimulatorVersion: "1174.9.2",
        },
      }),
    );

    expect(probe.inputTransport).toBe("dtuhid");
    expect(probe.coreSimulatorVersion).toBe("1174.9.2");
    // The contract's toolchain stays as it was: these are server-internal.
    expect(probe.toolchain).toEqual({
      xcodeVersion: "27.1",
      xcodeBuild: "27A9275",
      macOS: undefined,
    });
    expect(parseHelperProbe(healthyProbe({ inputTransport: "indigo" })).inputTransport).toBe(
      "indigo",
    );
  });

  it("reads them from a helper too old to report capabilities", () => {
    const probe = parseHelperProbe(
      JSON.stringify({
        ok: true,
        inputTransport: "indigo",
        toolchain: { coreSimulatorVersion: "1051.17" },
      }),
    );

    expect(probe.inputTransport).toBe("indigo");
    expect(probe.coreSimulatorVersion).toBe("1051.17");
  });

  it("leaves them undefined when missing", () => {
    const probe = parseHelperProbe(healthyProbe());

    expect(probe.inputTransport).toBeUndefined();
    expect(probe.coreSimulatorVersion).toBeUndefined();
  });

  it("ignores values that are not a known transport or a version string", () => {
    for (const inputTransport of ["DTUHID", "hid", "", 1, null, { name: "dtuhid" }]) {
      expect(parseHelperProbe(healthyProbe({ inputTransport })).inputTransport).toBeUndefined();
    }
    for (const coreSimulatorVersion of [1174.9, "", "   ", null, ["1174.9.2"]]) {
      expect(
        parseHelperProbe(
          healthyProbe({ toolchain: { xcodeVersion: "27.1", coreSimulatorVersion } }),
        ).coreSimulatorVersion,
      ).toBeUndefined();
    }
    expect(
      parseHelperProbe(healthyProbe({ toolchain: "1174.9.2" })).coreSimulatorVersion,
    ).toBeUndefined();
  });

  it("leaves them out of a probe whose output is unreadable", () => {
    const probe = parseHelperProbe("not json at all");

    expect(probe.inputTransport).toBeUndefined();
    expect(probe.coreSimulatorVersion).toBeUndefined();
  });
});

describe("availabilityFromProbe", () => {
  it("maps a healthy probe to available, carrying the capability detail", () => {
    const availability = availabilityFromProbe(parseHelperProbe(healthyProbe()));

    expect(availability.kind).toBe("available");
    if (availability.kind !== "available") throw new Error("expected available");
    expect(availability.capabilities).toHaveLength(4);
    expect(availability.toolchain?.xcodeVersion).toBe("26.2");
  });

  it("maps a partial failure to degraded rather than setup-required", () => {
    const availability = availabilityFromProbe(
      parseHelperProbe(
        healthyProbe({
          ok: false,
          capabilities: {
            framebuffer: "ok",
            hid: "ok",
            accessibility: { missingSymbol: "AXPTranslator" },
            encoder: "ok",
          },
        }),
      ),
    );

    // setup-required would tell the user to install something; there is nothing
    // to install, and the pane must still open.
    expect(availability.kind).toBe("degraded");
    if (availability.kind !== "degraded") throw new Error("expected degraded");
    expect(availability.capabilities.filter((capability) => !capability.ok)).toHaveLength(1);
  });

  it("maps a total failure to helper-unavailable", () => {
    const availability = availabilityFromProbe(
      parseHelperProbe(
        healthyProbe({
          ok: false,
          capabilities: {
            framebuffer: { missingSymbol: "SimServiceContext" },
            hid: { missingSymbol: "IndigoHIDMessageForButton" },
            accessibility: { missingSymbol: "AXPTranslator" },
            encoder: { error: "no session" },
          },
        }),
      ),
    );

    // Nothing works, so this is not "partly usable" — it is a broken helper.
    expect(availability.kind).toBe("helper-unavailable");
  });

  it("reports a framework load failure as helper-unavailable, not degraded", () => {
    const availability = availabilityFromProbe(
      parseHelperProbe(JSON.stringify({ ok: false, error: "CoreSimulator would not load" })),
    );

    expect(availability).toEqual({
      kind: "helper-unavailable",
      message: "CoreSimulator would not load",
    });
  });

  it("stays available when the helper predates capability reporting", () => {
    const availability = availabilityFromProbe(parseHelperProbe(JSON.stringify({ ok: true })));

    expect(availability).toEqual({ kind: "available" });
  });
});

describe("capability failure messages", () => {
  it("names the capability, the Xcode, and the missing symbol", () => {
    const message = capabilityUnavailableMessage(
      { id: "accessibility", ok: false, missingSymbol: "AXPTranslator" },
      { xcodeVersion: "26.3", xcodeBuild: "17D1" },
    );

    expect(message).toBe(
      "Accessibility inspection is unavailable with Xcode 26.3 (17D1). The device helper could not resolve 'AXPTranslator'.",
    );
  });

  it("still names the capability when the toolchain is unknown", () => {
    const message = capabilityUnavailableMessage({ id: "hid", ok: false }, undefined);

    expect(message).toBe("Touch and keyboard input is unavailable.");
  });

  it("joins several broken capabilities into one phrase", () => {
    const summary = describeBrokenCapabilities(
      [
        { id: "accessibility", ok: false },
        { id: "hid", ok: false },
      ],
      { xcodeVersion: "26.3" },
    );

    expect(summary).toBe(
      "accessibility inspection and touch and keyboard input unavailable with Xcode 26.3",
    );
  });
});
