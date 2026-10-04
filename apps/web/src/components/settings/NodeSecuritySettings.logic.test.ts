import { E2EE_SAFETY_NUMBER_DIGITS, E2EE_WEB_SAS_CHARS } from "@ryco/shared/relayE2eeConstants";
import { describe, expect, it } from "vite-plus/test";

import type { NodeE2eeClientRecord } from "@ryco/client-runtime/connection";

import {
  E2EE_WEB_SAS_ADVISORY,
  E2EE_WEB_SAS_DETAIL,
} from "../hostedHub/HostedE2eeVerification.logic";
import {
  everyNodeSecurityString,
  formatNodeEpoch,
  nodeApprovalRole,
  nodeApprovalWithheldNotice,
  nodeApproveConfirmation,
  nodeClientRows,
  nodeClientRowTitle,
  nodeConnectionStatement,
  nodeContinuityRows,
  nodeE2eeActionConfirmation,
  nodeE2eePairingWindowConfirmation,
  nodeE2eePolicyGate,
  nodeE2eeRecordConfirmation,
  nodeE2eeStrictPolicyDisposition,
  nodeEnrollmentFingerprintView,
  nodeFallbackReport,
  nodeNarrowOffered,
  nodePendingInPartition,
  nodePendingPartitionWarning,
  nodeOperatorDataAvailability,
  nodePairingWindowRows,
  nodePolicyChangeDestructive,
  nodePolicyChangeSummary,
  nodePolicyPreviewWarnings,
  nodePolicyRows,
  nodePrekeyRemedy,
  nodePrekeyRows,
  nodeRefusedAttemptsDescription,
  nodeSafetyNumberGroups,
  nodeSafetyNumberView,
  nodeSecurityMode,
  nodeSessionRows,
  nodeSessionVerificationView,
  NODE_APPROVAL_REVOKED_NOTICE,
  NODE_APPROVAL_ROLE_UNKNOWN_PENDING,
  NODE_APPROVE_NUMBER_PROMPT,
  NODE_E2EE_ACTION_IDS,
  NODE_E2EE_APPROVABLE_ROLES,
  NODE_E2EE_APPROVAL_CAPABILITY_SET,
  NODE_E2EE_RECORD_ACTION_IDS,
  NODE_SAFETY_NUMBER_ADVISORY,
  NODE_SAFETY_NUMBER_MATCH_HINT,
  NODE_SESSION_WEB_SAS_ADVISORY,
} from "./NodeSecuritySettings.logic";

/** A well-formed §13.4 rendering, built from the constants rather than typed. */
const SAFETY_NUMBER = Array.from({ length: E2EE_SAFETY_NUMBER_DIGITS.groups }, (_unused, index) =>
  String(index + 10_000).padStart(E2EE_SAFETY_NUMBER_DIGITS.digitsPerGroup, "0"),
).join(E2EE_SAFETY_NUMBER_DIGITS.separator);

describe("mode discrimination", () => {
  it("reads the build mode, which is the fact that decides reachability", () => {
    expect(nodeSecurityMode(false)).toBe("local");
    expect(nodeSecurityMode(true)).toBe("hosted");
  });
});

describe("THE HARD BLOCK: requireApprovedClientE2EE from a browser", () => {
  it("is unavailable in hosted mode and available in local mode", () => {
    expect(nodeE2eeStrictPolicyDisposition("hosted").kind).toBe("blocked");
    expect(nodeE2eeStrictPolicyDisposition("local").kind).toBe("available");
  });

  it("refuses the field in hosted mode whichever way it is being set", () => {
    // Both directions, deliberately. Distinguishing them would make the guard
    // depend on reading a boolean correctly, and there is no reachable hosted
    // session against a node that already has the policy on — such a node would
    // not admit this browser at all.
    for (const value of [true, false]) {
      const gate = nodeE2eePolicyGate("hosted", { requireApprovedClientE2EE: value });
      expect(gate.allowed, `requireApprovedClientE2EE: ${value}`).toBe(false);
      if (gate.allowed) throw new Error("unreachable");
      expect(gate.refusal.length).toBeGreaterThan(0);
    }
  });

  it("refuses it even when it rides along with an otherwise legal proposal", () => {
    // The gate reads the FIELD, not the shape of the request around it: a
    // proposal that also flips `requireE2EE` must not smuggle the blocked one
    // through on the back of an allowed one.
    const gate = nodeE2eePolicyGate("hosted", {
      requireE2EE: true,
      requireApprovedClientE2EE: true,
      suiteRegistry: [1],
    });
    expect(gate.allowed).toBe(false);
  });

  it("still allows every other hosted policy change through the gate", () => {
    // The block is on one field. It is not a blanket refusal of policy edits,
    // and pretending otherwise would hide the fact that the hosted transport
    // refuses them all anyway.
    const gate = nodeE2eePolicyGate("hosted", { requireE2EE: true });
    expect(gate.allowed).toBe(true);
    if (!gate.allowed) throw new Error("unreachable");
    expect(gate.proposal).toEqual({ requireE2EE: true });
  });

  it("lets a local operator apply it, in both directions", () => {
    for (const value of [true, false]) {
      expect(nodeE2eePolicyGate("local", { requireApprovedClientE2EE: value }).allowed).toBe(true);
    }
  });

  it("names the node command rather than only refusing", () => {
    const disposition = nodeE2eeStrictPolicyDisposition("hosted");
    if (disposition.kind !== "blocked") throw new Error("unreachable");
    const lower = disposition.reason.toLowerCase();
    // A refusal with no route out is a dead end: §12.4's policy is a legitimate
    // thing to want, so the copy says where it can be done.
    expect(lower).toContain("ryco e2ee policy set --require-approved-client-e2ee");
    // …and says WHY, in the consequence's own terms.
    expect(lower).toContain("closes browser and legacy access");
    expect(lower).toContain("end this session");
  });
});

describe("the local mode raises no alarm about a relay that is not there", () => {
  it("states what the connection is and stays quiet about relay encryption", () => {
    const { headline, body } = nodeConnectionStatement("local", null);
    expect(headline.toLowerCase()).toContain("direct");
    expect(body.toLowerCase()).toContain("on this machine");
    // A red badge in local mode trains an owner to ignore the one that matters.
    // There is no relay here, so there is nothing to warn about — and nothing to
    // reassure about either.
    for (const phrase of ["warning", "insecure", "unencrypted", "not encrypted", "at risk"]) {
      expect(body.toLowerCase(), phrase).not.toContain(phrase);
    }
  });

  it("does not offer node operator data it cannot reach, and says where it lives", () => {
    // `resolvePrimaryEnvironmentHttpUrl` throws in hosted mode, so the sixteen
    // operator routes are unreachable from a hosted browser. The panel says so
    // rather than rendering an empty table that reads as "no clients".
    //
    // THE ASSERTION IS ON THE FUNCTION THIS TEST IS NAMED FOR. It used to check
    // `nodeConnectionStatement("hosted", null).body` for the substring "hub" — a
    // different function, and one the LOCAL body also satisfies ("No Ryco Hub
    // sits between them"). `nodeOperatorDataAvailability` had no node coverage at
    // all, so replacing it with `{ available: true }` left this suite green.
    expect(nodeOperatorDataAvailability("hosted")).toEqual({
      available: false,
      unavailableBody: expect.stringContaining("ryco e2ee"),
    });
    expect(nodeOperatorDataAvailability("local")).toEqual({
      available: true,
      unavailableBody: "",
    });
    expect(nodeOperatorDataAvailability("local", "client")).toEqual({
      available: false,
      unavailableBody: expect.stringContaining("owner-only"),
    });
    expect(nodeOperatorDataAvailability("local", "checking")).toEqual({
      available: false,
      unavailableBody: expect.stringContaining("Checking"),
    });
    expect(nodeOperatorDataAvailability("local", "unavailable")).toEqual({
      available: false,
      unavailableBody: expect.stringContaining("could not verify"),
    });
  });

  it("says something DIFFERENT about the connection in each mode", () => {
    // Substring presence is not discrimination. Both bodies contain "hub", so
    // the earlier check passed under a mutation that returned the local
    // statement for hosted too — which puts §2.4's forbidden conclusion
    // ("nothing you send leaves this machine") on a Hub-served page.
    const local = nodeConnectionStatement("local", null);
    const hosted = nodeConnectionStatement("hosted", null);
    expect(hosted.body).not.toBe(local.body);
    expect(hosted.headline).not.toBe(local.headline);
    expect(local.body).toContain("No Ryco Hub sits between them");
    expect(hosted.body).toContain("through the Ryco Hub relay");
    expect(hosted.body).not.toContain("No Ryco Hub sits between them");
  });

  it("does not name the far end of a hosted channel as the reader's node", () => {
    // §2.3's web bullet: this client "retains no durable latch, no pin of any
    // kind", so the identity of the peer is exactly what this tier cannot
    // establish. `HostedRelayTrustNotice.logic.ts` calls it "the node this tab
    // was routed to" for that reason, and this sentence is drawn ABOVE that
    // disclosure in the larger, earlier position.
    expect(nodeConnectionStatement("hosted", null).body).not.toContain("your node");
  });
});

describe("§13.4 the safety number and its ceiling are one value", () => {
  it("returns the digits, the caption and the advisory together, or nothing", () => {
    const view = nodeSafetyNumberView(SAFETY_NUMBER);
    expect(view).not.toBeNull();
    expect(view!.display).toBe(SAFETY_NUMBER);
    expect(view!.groups).toHaveLength(E2EE_SAFETY_NUMBER_DIGITS.groups);
    expect(view!.caption.length).toBeGreaterThan(0);
    expect(view!.advisory).toBe(NODE_SAFETY_NUMBER_ADVISORY);
  });

  it("cannot be constructed without its advisory", () => {
    // The whole mechanism: rendering the number without the sentence beside it
    // has to be a deliberate deletion of a field from a returned object, never
    // an omitted second call.
    //
    // THE ASSERTION IS OVER THE REAL RETURN VALUE. This test used to build two
    // object literals and assert `Object.hasOwn` on them — it executed no
    // production code, so making `advisory` optional on the interface and
    // dropping it from the returned object left the test that carries the
    // mechanism's name green.
    const view = nodeSafetyNumberView(SAFETY_NUMBER);
    expect(view).not.toBeNull();
    expect(Object.keys(view!)).toContain("advisory");
    expect(view!.advisory.trim().length).toBeGreaterThan(0);
    // …and there is no accessor that hands back the digits alone: the format
    // validator returns groups, so joining them is a visible act.
    expect(Array.isArray(nodeSafetyNumberGroups(SAFETY_NUMBER))).toBe(true);
  });

  it("is the only export that hands back a §13.4 display string", () => {
    // `nodeSafetyNumberGroups` is the format validator and returns the groups,
    // never a joined display value — so a caller reaching for "just the digits"
    // has to join them itself, which is a visible act rather than an omission.
    expect(nodeSafetyNumberGroups(SAFETY_NUMBER).join(" ")).toBe(SAFETY_NUMBER);
    expect(Array.isArray(nodeSafetyNumberGroups(SAFETY_NUMBER))).toBe(true);
  });

  it("refuses anything that is not the exact §13.4 format", () => {
    for (const malformed of [
      "",
      "12345",
      SAFETY_NUMBER.replace(" ", "-"),
      `${SAFETY_NUMBER} 99999`,
      SAFETY_NUMBER.replace("1", "x"),
      SAFETY_NUMBER.slice(1),
    ]) {
      expect(nodeSafetyNumberView(malformed), JSON.stringify(malformed)).toBeNull();
      expect(nodeSafetyNumberGroups(malformed)).toEqual([]);
    }
  });

  it("quotes the format constants rather than writing the numbers", () => {
    const view = nodeSafetyNumberView(SAFETY_NUMBER)!;
    expect(view.caption).toContain(String(E2EE_SAFETY_NUMBER_DIGITS.digits));
    expect(view.caption).toContain(String(E2EE_SAFETY_NUMBER_DIGITS.groups));
    expect(view.caption).toContain(String(E2EE_SAFETY_NUMBER_DIGITS.digitsPerGroup));
  });

  it("tells the owner to read the other screen, not to trust this one", () => {
    // §13.2 step 5 is where this value is used: the owner compares it against
    // the device before approving the key.
    const lower = NODE_SAFETY_NUMBER_ADVISORY.toLowerCase();
    expect(lower).toContain("compare this with the number the device itself shows");
    expect(lower).toContain("approve nothing whose number you have not read");
  });
});

describe("prohibited claims", () => {
  it.each([
    // §2.2/§2.4: this panel describes the node. It may never spell the native
    // row's claim about the reader's own session, qualified or not — the scan
    // cannot judge qualification, so the phrase is absent.
    "end-to-end encrypted",
    // §13.5/§13.4: no comparison here is proof of anything, and "operator-proof"
    // carries the same token.
    "proof",
    "no interposer",
    // §2.6/§2.4: nothing here may be presented as unconditional.
    "cannot be intercepted",
    "unforgeable",
    "guaranteed",
    // §2.2's `verified` row is native-only and is a CONNECTION claim. This panel
    // reuses §13.6's own record vocabulary — pending, approved, revoked — and
    // borrows no word from the connection ladder.
    "verified",
  ])("never says %j", (phrase) => {
    for (const { where, text } of everyNodeSecurityString()) {
      expect(text.toLowerCase(), `${where} says ${phrase}`).not.toContain(phrase);
    }
  });

  it("never claims that reading this panel says anything about the reader's session", () => {
    // The panel describes the NODE's operator state. §2.4 denies the web tier
    // operator-proof protection, so no sentence may let a hosted reader conclude
    // that a healthy-looking node makes their own channel safe.
    for (const { where, text } of everyNodeSecurityString()) {
      const lower = text.toLowerCase();
      for (const phrase of [
        "your connection is secure",
        "this session is protected",
        "you are protected",
        "nobody can read",
      ]) {
        expect(lower, `${where} says ${phrase}`).not.toContain(phrase);
      }
    }
  });

  it("ships a non-empty string everywhere it ships one at all", () => {
    // A scan over strings is vacuous if the strings are empty, and an empty
    // confirmation body is a confirmation dialog with no consequence stated.
    const strings = everyNodeSecurityString();
    expect(strings.length).toBeGreaterThan(20);
    for (const { where, text } of strings) {
      expect(text.trim().length, where).toBeGreaterThan(0);
    }
  });

  it("reaches every function in this module that produces owner-facing prose", () => {
    // THE SCAN WALKED A HAND-KEPT LIST AND THAT WAS THE HOLE. It enumerated call
    // sites, so the fallback report's class meanings, the listing notices, the
    // preview warnings, the change summary and the prekey remedy were all
    // rendered to owners and none of them was ever read. Banned phrases written
    // into any of them passed. Pinning the producers by name here fails when one
    // is dropped from the flattener, which a "length > 20" check cannot.
    const covered = everyNodeSecurityString().map((entry) => entry.where);
    for (const producer of [
      "listingNotices",
      "fallbackClass",
      "fallbackOverflow",
      "fallbackUndersized",
      "prekeyRemedy",
      "policyChangeSummary",
      "previewWarnings",
      "refusedAttempts",
      "pairingWindowRows",
      "record(",
      "pairingWindow.",
      "policyGateRefusal",
      "nodeSessionSasAdvisory",
      "policyNoWithdrawal",
      "policyValueUnreadable",
      "approvalWithheld",
      "pendingPartitionWarning",
      "safetyNumberMatchLabel",
      "approveNumberPrompt",
      // The claim-bearing `.tsx` copy, moved here so a unit scan can see it. The
      // browser suite runs the same list over the rendered DOM for the rest.
      "requireE2eeDescription",
      "strictDescription",
      "nodeSessionRowDescription",
      "panelSubtitle",
    ]) {
      expect(
        covered.some((where) => where.includes(producer)),
        `everyNodeSecurityString() never reaches ${producer}`,
      ).toBe(true);
    }
  });
});

describe("owner actions carry a confirmation proportionate to the consequence", () => {
  it("has one for every action, and marks the irreversible ones", () => {
    for (const action of NODE_E2EE_ACTION_IDS) {
      const confirmation = nodeE2eeActionConfirmation(action);
      expect(confirmation.title.length, action).toBeGreaterThan(0);
      expect(confirmation.body.length, action).toBeGreaterThan(0);
      expect(confirmation.confirmLabel.length, action).toBeGreaterThan(0);
    }
    // §13.6's withdrawals close live channels before the node acknowledges them,
    // and §7.5's re-mint sends every paired client back through pairing. Those
    // are the ones that cannot be undone by pressing the button again.
    for (const action of [
      "narrow",
      "revoke",
      "purge",
      "remint-continuity",
      "break-continuity",
      "recover-policy",
    ] as const) {
      expect(nodeE2eeActionConfirmation(action).destructive, action).toBe(true);
    }
    for (const action of ["approve", "open-window", "rotate-prekey", "reset-fallback"] as const) {
      expect(nodeE2eeActionConfirmation(action).destructive, action).toBe(false);
    }
  });

  it("says that revoking closes the client's live channels immediately", () => {
    // §13.6: "no channel admitted under the withdrawn authority is still open"
    // by the time the command is acknowledged. An owner who thinks revocation
    // takes effect at the next reconnect would revoke and walk away.
    for (const action of ["revoke", "narrow", "purge"] as const) {
      const lower = nodeE2eeActionConfirmation(action).body.toLowerCase();
      expect(lower, action).toMatch(
        /closes? (immediately|before)|loses access now|immediate disconnection/u,
      );
    }
  });

  it("names the role it grants back in the confirmation, with what a smaller one does", () => {
    expect([...NODE_E2EE_APPROVABLE_ROLES]).toEqual(["viewer", "operator", "owner"]);
    for (const role of NODE_E2EE_APPROVABLE_ROLES) {
      const confirmation = nodeApproveConfirmation(role);
      expect(confirmation.title, role).toContain(role);
      expect(confirmation.confirmLabel, role).toContain(role);
      // The capability the approval actually grants is named, rather than the
      // sentence implying an empty grant is a smaller one.
      for (const capability of NODE_E2EE_APPROVAL_CAPABILITY_SET) {
        expect(confirmation.body, role).toContain(capability);
      }
      // …and the owner who wants to grant less is told that a lower ceiling
      // locks the device out, and pointed at the action that says so honestly.
      expect(confirmation.body, role).toContain("would refuse the device rather than limit it");
      expect(confirmation.body, role).toContain("revoke the key instead");
    }
    // Three distinct confirmations, so no two roles read the same.
    const labels = NODE_E2EE_APPROVABLE_ROLES.map(
      (role) => nodeApproveConfirmation(role).confirmLabel,
    );
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("approves at the role the device connects with, and at no other", () => {
    // §8.3 makes a native client's intended role equal its `channel.open` role,
    // and §8.6 step 6 admits it only under a `maxRole` at least that high. The
    // three buttons this replaced led with `viewer`, which approved the owner's
    // own phone into a green row that every handshake then refused.
    const record = (
      observedRole: string | undefined,
      status: NodeE2eeClientRecord["status"] = "pending",
    ): NodeE2eeClientRecord => ({
      status,
      hubOrigin: "https://hub.example.test",
      accountId: "acct_reader",
      fingerprint: "SHA256:AAAAphone0",
      maxRole: "viewer",
      capabilitySet: [],
      createdAt: 0,
      safetyNumber: SAFETY_NUMBER,
      pairingReserved: false,
      ...(observedRole === undefined ? {} : { observedRole }),
    });
    for (const role of NODE_E2EE_APPROVABLE_ROLES) {
      expect(nodeApprovalRole(record(role)), role).toBe(role);
      expect(nodeApprovalWithheldNotice(record(role)), role).toBeNull();
    }
    // Nothing to approve on an approved record.
    expect(nodeApprovalRole(record("owner", "approved"))).toBeNull();
    expect(nodeApprovalWithheldNotice(record(undefined, "approved"))).toBeNull();

    // A record that does not say which role is offered NONE — never a guess,
    // and in particular never `owner` because the account looks like the
    // owner's — and the row says what to do instead.
    for (const observedRole of [undefined, "superuser"]) {
      expect(nodeApprovalRole(record(observedRole)), String(observedRole)).toBeNull();
    }
    expect(nodeApprovalWithheldNotice(record(undefined))).toBe(NODE_APPROVAL_ROLE_UNKNOWN_PENDING);

    // A revoked record's role is the one the device introduced itself with —
    // frozen there, since a peer's hello never rewrites it — and the Hub may
    // assign another now. Re-approving at it widens authority on a value the
    // panel can no longer vouch for, so a revoked key is re-approved nowhere
    // here, whether or not it carries a role, and the row says what to do.
    for (const observedRole of [...NODE_E2EE_APPROVABLE_ROLES, undefined]) {
      const revoked = record(observedRole, "revoked");
      expect(nodeApprovalRole(revoked), String(observedRole)).toBeNull();
      expect(nodeApprovalWithheldNotice(revoked), String(observedRole)).toBe(
        NODE_APPROVAL_REVOKED_NOTICE,
      );
    }
    expect(NODE_APPROVAL_REVOKED_NOTICE).toContain("introduce itself again");
    expect(NODE_APPROVAL_REVOKED_NOTICE).toContain("ryco e2ee client approve --max-role");
  });

  it("says when the role it shows was read, once the node stopped following it", () => {
    // The node refreshes the observed role only while a record is pending; an
    // approved or revoked one keeps the role from its introduction, which the
    // Hub may have changed since.
    const record = (status: NodeE2eeClientRecord["status"]): NodeE2eeClientRecord => ({
      status,
      hubOrigin: "https://hub.example.test",
      accountId: "acct_reader",
      fingerprint: "SHA256:AAAAphone0",
      maxRole: "owner",
      capabilitySet: [],
      createdAt: 0,
      safetyNumber: SAFETY_NUMBER,
      pairingReserved: false,
      observedRole: "owner",
    });
    const labels = (status: NodeE2eeClientRecord["status"]) =>
      nodeClientRows(record(status)).map((row) => row.label);
    expect(labels("pending")).toContain("Connects as");
    for (const status of ["approved", "revoked"] as const) {
      expect(labels(status), status).toContain("Connected as (when introduced)");
      expect(labels(status), status).not.toContain("Connects as");
    }
  });

  it("offers a narrowing only when the device would still get in", () => {
    // A ceiling below the role the device connects with refuses it rather than
    // narrowing it, on both suites. "Reduce to viewer" on an owner's phone was a
    // revocation whose dialog promised a reconnect.
    const approved = (maxRole: string, observedRole?: string): NodeE2eeClientRecord => ({
      status: "approved",
      hubOrigin: "https://hub.example.test",
      accountId: "acct_reader",
      fingerprint: "SHA256:AAAAphone0",
      maxRole,
      capabilitySet: ["ryco.rpc"],
      createdAt: 0,
      safetyNumber: SAFETY_NUMBER,
      pairingReserved: false,
      ...(observedRole === undefined ? {} : { observedRole }),
    });
    expect(nodeNarrowOffered(approved("owner", "owner"), "viewer")).toBe(false);
    expect(nodeNarrowOffered(approved("operator", "operator"), "viewer")).toBe(false);
    // A record that does not carry the role cannot be shown to survive it.
    expect(nodeNarrowOffered(approved("owner"), "viewer")).toBe(false);
    // The one case that genuinely narrows: approved above what it connects with.
    expect(nodeNarrowOffered(approved("operator", "viewer"), "viewer")).toBe(true);
    expect(nodeNarrowOffered(approved("owner", "operator"), "operator")).toBe(true);
    // Never a no-op, and never on a record that is not approved.
    expect(nodeNarrowOffered(approved("viewer", "viewer"), "viewer")).toBe(false);
    expect(nodeNarrowOffered({ ...approved("owner", "viewer"), status: "revoked" }, "viewer")).toBe(
      false,
    );
  });

  it("carries the whole number into the approval dialog, and never a tail", () => {
    // The dialog's scrim hides the row the owner just compared, so the last look
    // before approving has to be inside it. A tail is not a comparison: a Hub
    // that holds the phone's enrolled key can grind a key to match one.
    const subject = {
      fingerprint: "SHA256:AAAAphoneAAAA",
      accountId: "acct_reader",
      hubOrigin: "https://hub.example.test",
      safetyNumber: SAFETY_NUMBER,
      pendingInPartition: 1,
    };
    const confirmation = nodeApproveConfirmation("owner", subject);
    const number = confirmation.facts?.find((fact) => fact.value === SAFETY_NUMBER);
    expect(number, "the approval dialog does not carry the whole number").toBeDefined();
    expect(number!.mono).toBe(true);
    expect(confirmation.body).toContain(NODE_APPROVE_NUMBER_PROMPT);
    // One request under the account: nothing to warn about.
    expect(confirmation.body).not.toContain("requests are waiting");
    // An unreadable number is not drawn as one.
    expect(
      nodeApproveConfirmation("owner", { ...subject, safetyNumber: "12345" }).facts?.map(
        (fact) => fact.label,
      ),
    ).not.toContain("Comparison number");
    // The statement that gates the action is about all the digits.
    expect(NODE_SAFETY_NUMBER_MATCH_HINT).toContain(String(E2EE_SAFETY_NUMBER_DIGITS.digits));
  });

  it("warns when an account has more than one request waiting, on the row and in the dialog", () => {
    const pending = (fingerprint: string, accountId = "acct_reader"): NodeE2eeClientRecord => ({
      status: "pending",
      hubOrigin: "https://hub.example.test",
      accountId,
      fingerprint,
      maxRole: "viewer",
      capabilitySet: [],
      createdAt: 0,
      safetyNumber: SAFETY_NUMBER,
      pairingReserved: false,
      observedRole: "owner",
    });
    const phone = pending("SHA256:AAAAphone0");
    const hubKey = pending("SHA256:BBBBunknown1");
    const otherAccount = pending("SHA256:CCCCother2", "acct_other");
    const approved: NodeE2eeClientRecord = {
      ...pending("SHA256:DDDDlaptop3"),
      status: "approved",
      maxRole: "owner",
      capabilitySet: ["ryco.rpc"],
    };
    const listing = {
      records: [phone, hubKey, otherAccount, approved],
      pendingGlobalSaturated: false,
      saturatedAccounts: [],
      refusedPairingAttempts: 0,
    };

    // The partition is (hubOrigin, accountId), and only pending records count.
    expect(nodePendingInPartition(listing, phone)).toBe(2);
    expect(nodePendingInPartition(listing, hubKey)).toBe(2);
    expect(nodePendingInPartition(listing, otherAccount)).toBe(1);
    expect(nodePendingInPartition(listing, approved)).toBe(0);
    expect(nodePendingInPartition(null, phone)).toBe(0);

    expect(nodePendingPartitionWarning(1)).toBeNull();
    expect(nodePendingPartitionWarning(0)).toBeNull();
    const warning = nodePendingPartitionWarning(2)!;
    expect(warning).toContain("2 requests are waiting under this account");
    expect(warning.toLowerCase()).toContain("matches the phone in your hand");

    const dialog = nodeApproveConfirmation("owner", {
      fingerprint: phone.fingerprint,
      accountId: phone.accountId,
      hubOrigin: phone.hubOrigin,
      safetyNumber: phone.safetyNumber,
      pendingInPartition: 2,
    });
    expect(dialog.body).toContain(warning);
  });

  it("does not promise a reconnect a narrowing cannot deliver", () => {
    const lower = nodeE2eeActionConfirmation("narrow").body.toLowerCase();
    expect(lower).not.toContain("the device reconnects with the smaller role ceiling");
    expect(lower).toContain("refused, not limited");
    // The role it was offered on is the one from its introduction, which the
    // Hub may have raised since — the sentence says that case is refused too.
    expect(lower).toContain("if the hub has raised its account's role since");
  });

  it("says that approving takes effect only on a fresh connection", () => {
    // §13.6: authority-widening changes "take effect only on a fresh ticket,
    // channel, and handshake, and never retroactively on an open one".
    expect(nodeE2eeActionConfirmation("approve").body.toLowerCase()).toContain(
      "not on anything open now",
    );
  });

  it("has a distinct confirm label for every action", () => {
    // Two actions sharing a button label is how an owner confirms the wrong one.
    const labels = NODE_E2EE_ACTION_IDS.map(
      (action) => nodeE2eeActionConfirmation(action).confirmLabel,
    );
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("grants a capability set the node can actually admit", () => {
    // §8.6 step 6 refuses a native handshake unless the record's capability set
    // contains the intended capability, unconditionally on that tier. The relay
    // vocabulary has one member, so an EMPTY set matches nothing: the record
    // commits as `approved`, the row goes green, and every handshake dies with
    // fatal P12 `authorization`. The node's own CLI forbids that state
    // (`--capability` is `Flag.atLeast(1)`); this panel could reach it.
    expect(NODE_E2EE_APPROVAL_CAPABILITY_SET.length).toBeGreaterThan(0);
    for (const capability of NODE_E2EE_APPROVAL_CAPABILITY_SET) {
      expect(capability.trim().length).toBeGreaterThan(0);
    }
  });

  it("names the record in every per-record withdrawal, not only the verb", () => {
    // §13.6's withdrawals act on one record and close its channels before the
    // node acknowledges them. Two devices under one Hub account render with the
    // same account, the same origin, and the same fallback label, and the dialog
    // paints an opaque scrim over the row behind it — so a confirmation that
    // names no record catches an accidental click and nothing else.
    const subject = {
      fingerprint: "SHA256:AAAAphoneAAAA",
      accountId: "acct_reader",
      hubOrigin: "https://hub.example.test",
    };
    const other = { ...subject, fingerprint: "SHA256:BBBBlaptopBBBB" };
    for (const action of NODE_E2EE_RECORD_ACTION_IDS) {
      const confirmation = nodeE2eeRecordConfirmation(action, subject);
      const values = (confirmation.facts ?? []).map((fact) => fact.value);
      expect(values, action).toContain(subject.fingerprint);
      expect(values, action).toContain(subject.accountId);
      expect(values, action).toContain(subject.hubOrigin);
      // Mono, because the comparison is character by character.
      expect(
        confirmation.facts!.find((fact) => fact.value === subject.fingerprint)!.mono,
        action,
      ).toBe(true);
      // …and two records do not produce the same dialog.
      expect(JSON.stringify(nodeE2eeRecordConfirmation(action, other)), action).not.toBe(
        JSON.stringify(confirmation),
      );
    }
  });

  it("echoes the fingerprint a pairing window would admit", () => {
    // The body names a wrong fingerprint as the exact risk, and the input it was
    // typed into sits behind the dialog's scrim, so this is the last place a
    // transposed character or a stale paste can be caught. The node parses the
    // value and refuses only an unparseable one, never a wrong one.
    const confirmation = nodeE2eePairingWindowConfirmation("SHA256:CCCCwindowCCCC");
    expect((confirmation.facts ?? []).map((fact) => fact.value)).toContain("SHA256:CCCCwindowCCCC");
    expect(confirmation.body).toContain("lets the wrong device in");
  });

  it("says the narrow leaves the capability grant alone", () => {
    // The panel sends `narrow` with no capability set and the node reads that as
    // "leave capabilities alone" (`capabilitySet ?? found.entry.capabilitySet`),
    // so only the role ceiling moves — while §13.6 treats the capability grant
    // as a separate authority the owner names.
    const lower = nodeE2eeActionConfirmation("narrow").body.toLowerCase();
    expect(lower).toContain("capability grant is left exactly as it is");
    expect(lower).toContain("only the ceiling drops");
  });

  it("tells two client rows apart when the node stored no label", () => {
    const base = {
      status: "pending" as const,
      hubOrigin: "https://hub.example.test",
      accountId: "acct_reader",
      maxRole: "",
      capabilitySet: [],
      createdAt: 0,
      safetyNumber: SAFETY_NUMBER,
      pairingReserved: false,
    };
    const phone = nodeClientRowTitle({ ...base, fingerprint: "SHA256:AAAAphone0" });
    const laptop = nodeClientRowTitle({ ...base, fingerprint: "SHA256:BBBBlaptop1" });
    expect(phone).not.toBe(laptop);
    expect(phone).not.toBe("Client key");
    // A stored label still wins: it is the owner's own name for the device.
    expect(
      nodeClientRowTitle({ ...base, fingerprint: "SHA256:AAAAphone0", displayLabel: "Phone" }),
    ).toBe("Phone");
    // …and a blank one does not, because a blank title tells nobody anything.
    expect(
      nodeClientRowTitle({ ...base, fingerprint: "SHA256:AAAAphone0", displayLabel: "   " }),
    ).toBe(phone);
  });
});

describe("§12.6 the preview is what the warning is computed from", () => {
  const CURRENT = {
    requireE2EE: true,
    requireApprovedClientE2EE: false,
    effectiveRequireE2EE: true,
    admittedPatterns: ["IK", "NX"] as const,
    suiteRegistry: [1],
    generation: 4,
  };
  const preview = {
    // §12.6's preview answers with the RESULTING policy, which is why the
    // widening branches are read against `CURRENT` and not against this.
    policy: CURRENT,
    withdrawal: true,
    changed: true,
    counts: { legacy: 2, nxE2ee: 1, suiteWithdrawn: 0, abortedHandshakes: 3 },
  };

  it("states §12.4's three duties when the strict policy is being enabled", () => {
    const warnings = nodePolicyPreviewWarnings(
      preview,
      { requireApprovedClientE2EE: true },
      CURRENT,
    );
    const joined = warnings.join(" ").toLowerCase();
    expect(joined).toContain("closes browser and legacy access entirely");
    expect(joined).toContain("strands remote access");
    expect(joined).toContain("closes live channels");
  });

  it("does not state the enable-time warning when the policy is being turned OFF", () => {
    // The discriminator is `=== true`, and nothing exercised the other side of
    // it: relaxing it to `!== undefined` showed a local operator the consequence
    // of the OPPOSITE action immediately before they confirmed.
    const joined = nodePolicyPreviewWarnings(
      { ...preview, withdrawal: false },
      { requireApprovedClientE2EE: false },
      { ...CURRENT, requireApprovedClientE2EE: true },
    ).join(" ");
    expect(joined).not.toContain("strands remote access");
    expect(joined).not.toContain(
      "requireApprovedClientE2EE closes browser and legacy access entirely",
    );
  });

  it("reports §12.6's approximate counts and says they are approximate", () => {
    const joined = nodePolicyPreviewWarnings(preview, { requireE2EE: true }, CURRENT).join(" ");
    expect(joined).toContain("2 legacy");
    expect(joined).toContain("1 browser");
    expect(joined).toContain("3 handshake(s) in flight");
    expect(joined.toLowerCase()).toContain("move while you read them");
  });

  it("says so when the change would do nothing", () => {
    const joined = nodePolicyPreviewWarnings(
      { ...preview, withdrawal: false, changed: false },
      { requireE2EE: true },
      CURRENT,
    ).join(" ");
    expect(joined.toLowerCase()).toContain("changes nothing");
  });

  it("states what a widening re-admits, in the consequence's own terms", () => {
    // A widening closes nothing by construction, so `withdrawal` is false and
    // the count sentence is true and useless. This branch used to return `[]`,
    // which the dialog rendered as "The node reports that this closes no live
    // channels." — one reassuring sentence, offered for the change that puts the
    // plaintext path back for every browser and legacy client.
    const joined = nodePolicyPreviewWarnings(
      { ...preview, withdrawal: false },
      { requireE2EE: false },
      CURRENT,
    )
      .join(" ")
      .toLowerCase();
    expect(joined).toContain("re-admits plaintext");
    expect(joined).toContain("has not encrypted");

    const clearing = nodePolicyPreviewWarnings(
      { ...preview, withdrawal: false },
      { requireApprovedClientE2EE: false },
      { ...CURRENT, requireApprovedClientE2EE: true },
    )
      .join(" ")
      .toLowerCase();
    expect(clearing).toContain("re-admits the browser and legacy tiers");
  });

  it("stays quiet about a widening the node is not actually making", () => {
    // A proposal restating a value the node already holds is not a widening, and
    // saying it re-admits plaintext would train the owner to ignore the sentence
    // that matters.
    const joined = nodePolicyPreviewWarnings(
      { ...preview, withdrawal: false },
      { requireE2EE: false, suiteRegistry: [1, 2] },
      { ...CURRENT, requireE2EE: false },
    )
      .join(" ")
      .toLowerCase();
    expect(joined).not.toContain("re-admits plaintext");
  });

  it("warns about a widening it cannot rule out, when the policy was never read", () => {
    // Not knowing what the node enforces now is not a reason to tell an owner
    // nothing is being given up.
    const joined = nodePolicyPreviewWarnings(
      { ...preview, withdrawal: false },
      { requireE2EE: false },
      null,
    )
      .join(" ")
      .toLowerCase();
    expect(joined).toContain("re-admits plaintext");
  });

  it("never returns nothing, in any branch", () => {
    // The dialog renders whatever comes back, and an empty list rendered as a
    // reassurance. Every reachable combination has to say something.
    for (const [where, proposal, current] of [
      ["widen suite", { suiteRegistry: [1, 2] }, CURRENT],
      ["no fields", {}, CURRENT],
      ["restate", { requireE2EE: true }, CURRENT],
    ] as const) {
      expect(
        nodePolicyPreviewWarnings({ ...preview, withdrawal: false }, proposal, current).length,
        where,
      ).toBeGreaterThan(0);
    }
  });

  it("reserves the destructive confirmation for changes that cost something", () => {
    // Every policy change drawing the same red Apply is the pattern that trains
    // an owner to click through the one that strands their access.
    expect(nodePolicyChangeDestructive(preview, { requireE2EE: true }, CURRENT)).toBe(true);
    expect(
      nodePolicyChangeDestructive(
        { ...preview, withdrawal: false },
        { requireE2EE: false },
        CURRENT,
      ),
    ).toBe(true);
    expect(
      nodePolicyChangeDestructive(
        { ...preview, withdrawal: false },
        { suiteRegistry: [1, 2] },
        CURRENT,
      ),
    ).toBe(false);
  });

  it("reports §12.6(c)'s counts after the change, broken out by class", () => {
    // The apply route answers with these so the operator can be told what the
    // change actually did; the panel used to build the sentence and overwrite it
    // with "Policy applied." in the same microtask.
    const summary = nodePolicyChangeSummary(preview);
    expect(summary).toContain("2 legacy channel(s)");
    expect(summary).toContain("1 browser channel(s)");
    expect(summary).toContain("3 handshake(s)");
    expect(nodePolicyChangeSummary({ ...preview, changed: false })).toContain("Policy unchanged.");
  });
});

describe("§12.3/§12.4 the policy display shows raw and effective, always", () => {
  it("never shows one without the other", () => {
    const rows = nodePolicyRows({
      requireE2EE: false,
      requireApprovedClientE2EE: true,
      effectiveRequireE2EE: true,
      admittedPatterns: ["IK"],
      suiteRegistry: [1, 2],
      generation: 9,
    });
    const labels = rows.map((row) => row.label);
    expect(labels).toContain("requireE2EE");
    expect(labels).toContain("requireApprovedClientE2EE");
    expect(labels).toContain("Effective requireE2EE");
    // §12.4's implication makes them differ, and a display of only one would
    // either understate the guarantee or misreport the configuration.
    expect(rows.find((row) => row.label === "requireE2EE")!.value).toBe("false");
    expect(rows.find((row) => row.label === "Effective requireE2EE")!.value).toBe("true");
  });

  it("says the policy is unknown rather than inventing a default", () => {
    expect(nodePolicyRows(null)).toEqual([{ label: "Admission policy", value: "unknown" }]);
  });
});

describe("an unread value is a stated absence, never the reassuring one", () => {
  it("does not report a pairing window as closed on a listing it never read", () => {
    // `snapshot.clients` is null on every mount and stays null for the whole
    // session whenever a read keeps failing — a non-owner local session, a node
    // predating these routes, a network fault. Optional-chaining straight to
    // `pairingWindow === undefined` collapsed that into "closed", an affirmative
    // "no device can introduce itself right now" about state the panel does not
    // have.
    expect(nodePairingWindowRows(null)).toEqual([{ label: "Pairing window", value: "unknown" }]);
    expect(
      nodePairingWindowRows({
        records: [],
        pendingGlobalSaturated: false,
        saturatedAccounts: [],
        refusedPairingAttempts: 0,
      }),
    ).toEqual([{ label: "Pairing window", value: "closed" }]);
  });

  it("does not report zero refused attempts on a listing it never read", () => {
    expect(nodeRefusedAttemptsDescription(null)).not.toContain("0 attempt");
    expect(nodeRefusedAttemptsDescription(null).toLowerCase()).toContain("has not been read");
    expect(
      nodeRefusedAttemptsDescription({
        records: [],
        pendingGlobalSaturated: false,
        saturatedAccounts: [],
        refusedPairingAttempts: 2,
      }),
    ).toContain("2 attempt(s)");
  });
});

describe("§13.5 from the node's end of the comparison", () => {
  /** Built from the format's own constants rather than typed. */
  const CODE = ["7HJ2", "MQ5T"].join(E2EE_WEB_SAS_CHARS.separator);

  it("never sends the reader to compare the node against itself", () => {
    // The shipped advisory is written from the BROWSER end — "Compare this code
    // with the one your node's CLI shows" — and it is correct there. Rendered on
    // the node's own live-session list it inverts: the reader is already at the
    // node, so the comparison always matches and establishes nothing, and the
    // ceiling clause blames "the Hub operator, who serves this page" for a page
    // the node itself served in local mode.
    const view = nodeSessionVerificationView(CODE);
    expect(view).not.toBeNull();
    expect(view!.advisory).toBe(NODE_SESSION_WEB_SAS_ADVISORY);
    // NEITHER LENGTH OF THE BROWSER-END SENTENCE, because §13.5's copy now ships
    // as a short form and a long one and both invert here in the same way.
    expect(view!.advisory).not.toBe(E2EE_WEB_SAS_ADVISORY);
    expect(view!.advisory).not.toBe(E2EE_WEB_SAS_DETAIL);
    expect(view!.advisory.toLowerCase()).not.toContain("your node's cli");
    expect(view!.advisory.toLowerCase()).toContain("that browser is showing");
  });

  it("carries no pointer, because the reader is already on the page one would name", () => {
    // The browser end ships a second required field — a pointer at Settings →
    // Security, or at the command that reads the node's end. On the node's own
    // list in local mode the reader is inside Settings → Security and the
    // command produces this very list, so both would be circular. The node-end
    // view is a different shape rather than the same shape with a wrong value.
    //
    // STATED AS `null` RATHER THAN LEFT OUT. `VerificationCode` draws both ends
    // from one prop, and an optional field there cannot tell "this end has no
    // second sentence" from "this caller dropped one" — so the field is present
    // and empty, and the renderer's type requires it.
    expect(Object.keys(nodeSessionVerificationView(CODE)!)).toEqual([
      "groups",
      "display",
      "advisory",
      "more",
    ]);
    expect(nodeSessionVerificationView(CODE)!.more).toBeNull();
  });

  it("keeps §13.5's denial at full strength in node-end terms", () => {
    // §13.5 forbids using the derivation "to strengthen the claims of §2.4 or
    // §17.5". Rewriting the referent may not soften the ceiling.
    const lower = NODE_SESSION_WEB_SAS_ADVISORY.toLowerCase();
    expect(lower).toContain("cannot protect against whoever served that page");
    expect(lower).toContain("does not rule out someone sitting in the middle");
  });

  it("reuses the shipped validator rather than parsing a second time", () => {
    // A value the shipped function refuses is refused here: half a comparison is
    // worse than none.
    expect(nodeSessionVerificationView(null)).toBeNull();
    expect(nodeSessionVerificationView("nope")).toBeNull();
    expect(nodeSessionVerificationView(CODE)!.display).toBe(CODE);
  });

  it("carries its advisory as a required field of the returned object", () => {
    expect(Object.keys(nodeSessionVerificationView(CODE)!)).toContain("advisory");
  });
});

describe("§6.4 and §7.5 carry their own remedies", () => {
  it("tells a node with no prekey apart from one that expired", () => {
    expect(nodePrekeyRows({ present: false })).toEqual([
      { label: "Agreement prekey", value: "none held" },
    ]);
    expect(nodePrekeyRemedy({ present: false })).toContain("re-signs one at startup");
    // An expired one carries §6.4's own sentence, from the module that raised
    // the diagnostic rather than restated here.
    expect(
      nodePrekeyRemedy({ present: true, validity: "expired", remedy: "§6.4's own words." }),
    ).toBe("§6.4's own words.");
    expect(nodePrekeyRemedy({ present: true, validity: "usable" })).toBeNull();
  });

  it("reports an unresolvable lineage as unresolvable, with its reason", () => {
    const rows = nodeContinuityRows({ status: "unavailable", reason: "anchor_disagrees" });
    expect(rows).toEqual([
      { label: "Continuity", value: "unresolvable" },
      { label: "Reason", value: "anchor_disagrees" },
    ]);
  });

  it("shows the generation for an advertisable lineage", () => {
    const rows = nodeContinuityRows({
      status: "advertisable",
      continuityId: "lineage",
      generation: 7,
      chainLength: 2,
    });
    expect(rows.find((row) => row.label === "Rotation generation")!.value).toBe("7");
  });
});

describe("§12.5 the fallback report is readable rather than a dump", () => {
  it("keeps the two classes separate and never sums them", () => {
    const report = nodeFallbackReport({
      windowStartedAt: 1_000,
      peerLegacy: { occurrences: 3, ringOverflows: 0, lastOccurrenceAt: 2_000 },
      advertisementUnavailable: { occurrences: 5, ringOverflows: 1 },
      ring: [
        { occurredAt: 2_000, reason: "peer-legacy" },
        { occurredAt: 1_500, reason: "statement-unavailable" },
      ],
    })!;
    expect(report.classes).toHaveLength(2);
    expect(report.classes[0]!.occurrences).toBe(3);
    expect(report.classes[1]!.occurrences).toBe(5);
    // Each class says what it MEANS, because "advertisement-unavailable: 5" is a
    // number an owner cannot act on.
    for (const entry of report.classes) expect(entry.meaning.length).toBeGreaterThan(0);
    expect(report.quiet).toBe(false);
  });

  it("puts the retained occurrences in time order with their reasons", () => {
    // §12.5 requires the SHAPE to be legible, and a count is not a shape.
    const report = nodeFallbackReport({
      peerLegacy: { occurrences: 1, ringOverflows: 0 },
      advertisementUnavailable: { occurrences: 0, ringOverflows: 0 },
      ring: [
        { occurredAt: 3_000, reason: "peer-legacy" },
        { occurredAt: 1_000, reason: "undersized-connection" },
      ],
    })!;
    expect(report.entries.map((entry) => entry.reason)).toEqual([
      "undersized-connection",
      "peer-legacy",
    ]);
  });

  it("says an overflowed ring is an incomplete account", () => {
    const report = nodeFallbackReport({
      peerLegacy: { occurrences: 9, ringOverflows: 2 },
      advertisementUnavailable: { occurrences: 0, ringOverflows: 0 },
      ring: [],
    })!;
    expect(report.overflowNotice).not.toBeNull();
    expect(report.overflowNotice!.toLowerCase()).toContain("not evidence in either direction");
  });

  it("shows both numbers for a live undersized connection, because it is the comparison", () => {
    const report = nodeFallbackReport({
      peerLegacy: { occurrences: 0, ringOverflows: 0 },
      advertisementUnavailable: { occurrences: 0, ringOverflows: 0 },
      ring: [],
      undersizedConnection: { assertedMaxDataChunkBytes: 100, advertisementMinChunkBytes: 512 },
    })!;
    expect(report.undersizedNotice).toContain("100");
    expect(report.undersizedNotice).toContain("512");
    // Absent when the condition is not live: §12.5 scopes the pair to the
    // current connection, so its absence is not "never was".
    expect(
      nodeFallbackReport({
        peerLegacy: { occurrences: 0, ringOverflows: 0 },
        advertisementUnavailable: { occurrences: 0, ringOverflows: 0 },
        ring: [],
      })!.undersizedNotice,
    ).toBeNull();
  });

  it("reports a quiet window as quiet", () => {
    expect(
      nodeFallbackReport({
        peerLegacy: { occurrences: 0, ringOverflows: 0 },
        advertisementUnavailable: { occurrences: 0, ringOverflows: 0 },
        ring: [],
      })!.quiet,
    ).toBe(true);
  });
});

describe("§13.5 a native session has no per-session code and says so", () => {
  it("labels the tier with the node's own words and claims nothing about them", () => {
    const native = nodeSessionRows({
      sessionIndex: 0,
      tier: "native",
      suite: 1,
      establishedAt: 1_000,
    });
    expect(native.find((row) => row.label === "Tier")!.value).toBe("native (IK)");
    const web = nodeSessionRows({ sessionIndex: 1, tier: "web", suite: 1, establishedAt: 1_000 });
    expect(web.find((row) => row.label === "Tier")!.value).toBe("browser (NX)");
  });
});

describe("this node's own enrollment fingerprint", () => {
  it("is shown while a ceremony is pending and stated absent otherwise", () => {
    // No route on this node exposes its long-term identity fingerprint once
    // enrollment completes: `GET /api/hub/enrollment` answers 404 and
    // `GET /api/hub/identity` carries no fingerprint by design. The panel says
    // where to get it rather than showing the §6.4 AGREEMENT prekey fingerprint
    // under an identity heading — different keys, and the wrong one would send
    // an owner into a pairing comparison with a value that will never match.
    const pending = nodeEnrollmentFingerprintView("SHA256:abc");
    expect(pending.available).toBe(true);
    expect(pending.fingerprint).toBe("SHA256:abc");

    const absent = nodeEnrollmentFingerprintView(null);
    expect(absent.available).toBe(false);
    expect(absent.fingerprint).toBeNull();
    expect(absent.caption).toContain("ryco hub status");
  });
});

describe("timestamps", () => {
  it("says never rather than rendering an epoch for an absent one", () => {
    expect(formatNodeEpoch(undefined)).toBe("never");
    expect(formatNodeEpoch(0)).not.toBe("never");
  });
});
