import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { hostedSessionAdmits, resolveHostedRpcCapability } from "./capabilities";
import { resolveHostedDeliveryNotice } from "./deliveryNotice";

describe("hosted UI capabilities", () => {
  it("keeps standard direct and desktop behavior unchanged", () => {
    expect(
      resolveHostedRpcCapability({
        hosted: false,
        role: null,
        fresh: false,
        method: WS_METHODS.serverGetStatistics,
      }).allowed,
    ).toBe(true);
  });

  it("fails closed while role state is absent or stale", () => {
    expect(
      resolveHostedRpcCapability({
        hosted: true,
        role: "owner",
        fresh: false,
        method: WS_METHODS.projectsList,
      }),
    ).toMatchObject({ allowed: false, reason: expect.any(String) });
  });

  it("fails closed while the browser resume or Ryco session is stale", () => {
    expect(
      resolveHostedRpcCapability({
        hosted: true,
        role: "operator",
        fresh: true,
        browserCurrent: false,
        sessionReady: true,
        method: ORCHESTRATION_WS_METHODS.dispatchCommand,
      }).allowed,
    ).toBe(false);
    expect(
      resolveHostedRpcCapability({
        hosted: true,
        role: "operator",
        fresh: true,
        browserCurrent: true,
        sessionReady: false,
        method: ORCHESTRATION_WS_METHODS.dispatchCommand,
      }).allowed,
    ).toBe(false);
  });

  it("adapts viewer, operator, and owner actions from the server policy", () => {
    const allowed = (role: "viewer" | "operator" | "owner", method: string) =>
      resolveHostedRpcCapability({ hosted: true, role, fresh: true, method }).allowed;
    expect(allowed("viewer", WS_METHODS.projectsList)).toBe(true);
    expect(allowed("viewer", ORCHESTRATION_WS_METHODS.dispatchCommand)).toBe(false);
    expect(allowed("operator", ORCHESTRATION_WS_METHODS.dispatchCommand)).toBe(true);
    expect(allowed("operator", WS_METHODS.subscribeTerminalEvents)).toBe(true);
    expect(allowed("operator", WS_METHODS.serverGetStatistics)).toBe(false);
    expect(allowed("owner", WS_METHODS.serverGetStatistics)).toBe(true);
    expect(allowed("owner", WS_METHODS.subscribeAuthAccess)).toBe(false);
  });
});

describe("hosted session admission", () => {
  it("admits everything in a ready session", () => {
    const ready = { sessionStatus: "ready", sessionRecoveredAfterUnknown: false } as const;
    expect(hostedSessionAdmits(ready, WS_METHODS.terminalWrite)).toBe(true);
    expect(hostedSessionAdmits(ready, WS_METHODS.projectsReadFile)).toBe(true);
  });

  it("admits only reads after recovering with unconfirmed delivery", () => {
    const recovered = {
      sessionStatus: "delivery-unknown",
      sessionRecoveredAfterUnknown: true,
    } as const;
    expect(hostedSessionAdmits(recovered, WS_METHODS.projectsReadFile)).toBe(true);
    expect(hostedSessionAdmits(recovered, WS_METHODS.vcsReadLocalChanges)).toBe(true);
    expect(hostedSessionAdmits(recovered, ORCHESTRATION_WS_METHODS.getThreadWindow)).toBe(true);
    expect(hostedSessionAdmits(recovered, WS_METHODS.terminalWrite)).toBe(false);
    expect(hostedSessionAdmits(recovered, ORCHESTRATION_WS_METHODS.dispatchCommand)).toBe(false);
    expect(
      hostedSessionAdmits(
        { sessionStatus: "delivery-unknown", sessionRecoveredAfterUnknown: false },
        WS_METHODS.projectsReadFile,
      ),
    ).toBe(false);
    expect(
      hostedSessionAdmits(
        { sessionStatus: "stale", sessionRecoveredAfterUnknown: false },
        WS_METHODS.projectsReadFile,
      ),
    ).toBe(false);
  });
});

describe("hosted delivery notice", () => {
  it("is absent unless delivery is unconfirmed", () => {
    expect(
      resolveHostedDeliveryNotice({ sessionStatus: "ready", sessionRecoveredAfterUnknown: false }),
    ).toBeNull();
    expect(
      resolveHostedDeliveryNotice({ sessionStatus: "stale", sessionRecoveredAfterUnknown: false }),
    ).toBeNull();
  });

  it("waits for the replacement session before offering to continue", () => {
    expect(
      resolveHostedDeliveryNotice(
        { sessionStatus: "delivery-unknown", sessionRecoveredAfterUnknown: false },
        "Studio Mac",
      ),
    ).toMatchObject({ canAcknowledge: false, actionLabel: "Synchronizing…" });
    const recovered = resolveHostedDeliveryNotice(
      { sessionStatus: "delivery-unknown", sessionRecoveredAfterUnknown: true },
      "Studio Mac",
    );
    expect(recovered).toMatchObject({ canAcknowledge: true, actionLabel: "Continue" });
    expect(recovered?.description).toContain("Studio Mac");
    expect(
      resolveHostedDeliveryNotice(
        { sessionStatus: "delivery-unknown", sessionRecoveredAfterUnknown: true },
        "  ",
      )?.description,
    ).toContain("this machine");
  });
});
