import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";
import { formatE2eeKeyFingerprint } from "@ryco/shared/relayE2eeKeys";
import { describe, expect, it } from "vite-plus/test";

import { makeNodeClientAuthorizationClient } from "../hubIdentity/NodeClientAuthorizationClient.ts";
import { makeNodeClientAuthorizationStore } from "../hubIdentity/NodeClientAuthorizationStore.ts";
import { E2eeClientListingView, E2eeClientRecordView } from "./e2eeOperatorContract.ts";
import type { HubIdentityRuntimeShape } from "./HubIdentityRuntime.ts";
import { makeNodeE2eeOperator } from "./NodeE2eeOperator.ts";
import { makeNodeE2eeSessionDirectory } from "./NodeE2eeSessionDirectory.ts";

const key = {
  hubOrigin: "https://relay.example",
  accountId: "acct_operator",
  fingerprint: `SHA256:${"B".repeat(42)}A`,
};

describe("node E2EE operator", () => {
  it("runs every command that writes the identity's state as its owner, and leaves pure reads alone", async () => {
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
      // Repairs the continuity chain as it reads it.
      readContinuity: () => operator.readContinuity(),
    };
    for (const [name, command] of Object.entries(commands)) {
      await expect(command(), name).rejects.toThrow("in use by another Ryco process");
    }
    expect(touched).toEqual([]);

    // Reads go straight to the identity.
    await expect(operator.listClients()).rejects.toThrow("identity read");
    expect(() => operator.readPolicy()).toThrow("identity read");
    await expect(operator.readPrekey()).rejects.toThrow("identity read");
  });
});

describe("node E2EE operator client views", () => {
  it("carries a pending request's observed role to the listing and the single read", async () => {
    // The one value the panel's approval is built from. Every other suite stubs
    // the operator or reads the client directly, so dropping it here — or from
    // the contract the CLI decodes with — would leave every pending row with no
    // approval on offer and nothing failing.
    const path = join(await mkdtemp(join(tmpdir(), "ryco-e2ee-operator-")), "clients.json");
    const client = await makeNodeClientAuthorizationClient({
      store: await makeNodeClientAuthorizationStore({ path }),
    });
    const fingerprintBytes = Uint8Array.from({ length: 32 }, (_, offset) => offset + 1);
    const pair = (observedRole: string) =>
      client.commitPairingAdmission(
        client.evaluatePairingAdmission({
          hubOrigin: key.hubOrigin,
          accountId: key.accountId,
          clientIdentityFingerprint: fingerprintBytes,
          safetyNumber: Array.from({ length: 12 }, () => "12345").join(" "),
          observedRole,
        }),
      );
    const operator = makeNodeE2eeOperator({
      identity: { e2eeAuthorizationAdmin: client } as unknown as HubIdentityRuntimeShape,
      sessions: makeNodeE2eeSessionDirectory(),
      hubOrigin: () => key.hubOrigin,
    });
    const recordKey = { ...key, fingerprint: formatE2eeKeyFingerprint(fingerprintBytes) };
    // What the routes answer with is the view through JSON, and what the CLI
    // and the panel read is that JSON decoded against the contract.
    const listed = async () =>
      Schema.decodeUnknownSync(E2eeClientListingView)(
        JSON.parse(JSON.stringify(await operator.listClients())),
      ).records[0];
    const read = async () =>
      Schema.decodeUnknownSync(E2eeClientRecordView)(
        JSON.parse(JSON.stringify(await operator.getClient(recordKey))),
      );

    await pair("operator");
    expect(await listed()).toMatchObject({ status: "pending", observedRole: "operator" });
    expect(await read()).toMatchObject({ status: "pending", observedRole: "operator" });

    // …and the role a later attempt arrived under, which the node holds in
    // memory rather than on disk.
    await pair("owner");
    expect((await listed())?.observedRole).toBe("owner");
    expect((await read()).observedRole).toBe("owner");
  });
});
