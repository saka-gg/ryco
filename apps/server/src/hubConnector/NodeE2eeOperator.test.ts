import { describe, expect, it } from "vite-plus/test";

import type { HubIdentityRuntimeShape } from "./HubIdentityRuntime.ts";
import { makeNodeE2eeOperator } from "./NodeE2eeOperator.ts";
import { makeNodeE2eeSessionDirectory } from "./NodeE2eeSessionDirectory.ts";

const key = {
  hubOrigin: "https://relay.example",
  accountId: "acct_operator",
  fingerprint: `SHA256:${"B".repeat(42)}A`,
};

describe("node E2EE operator", () => {
  it("runs every state-changing command as the identity's owner, and no read", async () => {
    // Any use of the identity is visible: a command the gate refused must not
    // have reached it at all.
    const touched: PropertyKey[] = [];
    const identity = new Proxy({} as HubIdentityRuntimeShape, {
      get: (_target, property) => {
        touched.push(property);
        throw new Error("identity read");
      },
    });
    const operator = makeNodeE2eeOperator({
      identity,
      sessions: makeNodeE2eeSessionDirectory(),
      hubOrigin: () => key.hubOrigin,
      asIdentityOwner: async () => {
        throw new Error("in use by another Ryco process");
      },
    });

    const commands = {
      approveClient: () =>
        operator.approveClient({ ...key, maxRole: "operator", capabilitySet: ["ryco.rpc"] }),
      narrowClient: () => operator.narrowClient({ ...key, maxRole: "viewer" }),
      revokeClient: () => operator.revokeClient(key),
      purgeClient: () => operator.purgeClient(key),
      createClientApprovalQr: () => operator.createClientApprovalQr(key),
      openPairingWindow: () => operator.openPairingWindow(key.fingerprint),
      closePairingWindow: () => operator.closePairingWindow(),
      applyPolicy: () => operator.applyPolicy({ requireE2EE: true }),
      recoverPolicyGeneration: () => operator.recoverPolicyGeneration(),
      rotatePrekey: () => operator.rotatePrekey(),
      adoptContinuityId: () => operator.adoptContinuityId("continuity"),
      remintContinuityId: () => operator.remintContinuityId(),
      breakContinuityChain: () => operator.breakContinuityChain(),
      resetFallback: () => operator.resetFallback(),
    };
    for (const [name, command] of Object.entries(commands)) {
      await expect(command(), name).rejects.toThrow("in use by another Ryco process");
    }
    expect(touched).toEqual([]);

    // Reads go straight to the identity.
    await expect(operator.listClients()).rejects.toThrow("identity read");
    expect(() => operator.readPolicy()).toThrow("identity read");
    await expect(operator.readContinuity()).rejects.toThrow("identity read");
  });
});
