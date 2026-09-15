import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import { AutomationCentreCommand } from "./automationCentre.ts";

describe("owner automation command boundary", () => {
  const input = {
    kind: "read",
    projectId: "p",
    requestId: "r",
    runId: "run",
    expectedUpdatedAt: "2026-09-15T00:00:00.000Z",
    unread: false,
  };
  it("accepts only the command payload, never a supplied security principal", () => {
    expect(Schema.decodeUnknownSync(AutomationCentreCommand)(input).kind).toBe("read");
    for (const kind of ["automation-owner", "provider-session", "external-integration"]) {
      expect(() =>
        Schema.decodeUnknownSync(AutomationCentreCommand)({ ...input, principal: { kind } }),
      ).toThrow();
    }
  });
  it("does not expose automatic execution or arbitrary control plans", () => {
    expect(() =>
      Schema.decodeUnknownSync(AutomationCentreCommand)({ ...input, kind: "automationRun" }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AutomationCentreCommand)({ ...input, authorizeRoutine: true }),
    ).toThrow();
  });
});
