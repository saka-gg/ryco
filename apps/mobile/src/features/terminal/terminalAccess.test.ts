import { describe, expect, it } from "vite-plus/test";

import { terminalEnvironmentAccess, terminalRoleAllowed } from "./terminalAccess";

describe("terminal access", () => {
  it("follows the node's operator rule, with a non-owner direct pairing as a viewer", () => {
    expect(terminalRoleAllowed("owner")).toBe(true);
    expect(terminalRoleAllowed("operator")).toBe(true);
    expect(terminalRoleAllowed("viewer")).toBe(false);
    expect(terminalRoleAllowed("client")).toBe(false);
    expect(terminalRoleAllowed(undefined)).toBe(false);
  });

  it("takes mutation readiness from the shared environment row and never widens it", () => {
    expect(
      terminalEnvironmentAccess({
        connectionState: "connected",
        mutationReady: true,
        role: "owner",
      }),
    ).toEqual({ connectionState: "connected", mutationReady: true });
    // A hosted session that has not accepted its current snapshot only watches.
    expect(
      terminalEnvironmentAccess({
        connectionState: "reconnecting",
        mutationReady: false,
        role: "owner",
      }),
    ).toEqual({ connectionState: "reconnecting", mutationReady: false });
    expect(
      terminalEnvironmentAccess({
        connectionState: "read-only",
        mutationReady: false,
        role: "viewer",
      }),
    ).toEqual({ connectionState: "read-only", mutationReady: false });
    expect(
      terminalEnvironmentAccess({
        connectionState: "connected",
        mutationReady: true,
        role: "client",
      }),
    ).toEqual({ connectionState: "read-only", mutationReady: false });
    expect(terminalEnvironmentAccess(undefined)).toEqual({
      connectionState: "offline",
      mutationReady: false,
    });
  });
});
