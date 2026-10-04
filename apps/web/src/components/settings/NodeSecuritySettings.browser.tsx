// The node security panel in LOCAL mode — the desktop app and a browser pointed
// at a node on this machine, which are the same bundle.
//
// The hosted half is `NodeSecuritySettingsHosted.browser.tsx`. Two files rather
// than one because `isHostedHubMode()` is read at module scope through a hoisted
// `vi.mock`, and a suite cannot hold both answers at once — the same reason
// `AccountSettings.browser.tsx` is a hosted-only file.
//
// What is pinned here is not markup. It is the things that would be a security
// defect rather than a cosmetic one:
//
//   * the §13.4 comparison number and the §13.5 session codes reach no storage,
//     no console, no DOM attribute, and no diagnostics export — extending the
//     coverage `HostedE2eeVerification.browser.tsx` already has over this tab's
//     own `WebSAS` to every value this panel draws;
//   * local mode raises no alarm about a relay that is not in the path, and
//     draws no channel panel for a channel that does not exist;
//   * every gate that stands between a click and the network actually stands
//     there — the confirmations, §12.6's preview-then-apply, and the request an
//     approval builds. Those were covered only as strings in a lookup table:
//     replacing `setConfirmation(...)` with a direct `run(...)`, or the preview
//     call with the apply call, or the approval's role with `owner` and its
//     capability set with `["*"]`, left both suites green;
//   * the prohibited-claims list runs over the RENDERED DOM, which is the only
//     scan that reaches copy written inside the `.tsx`.
import "../../index.css";

import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { E2EE_SAFETY_NUMBER_DIGITS, E2EE_WEB_SAS_CHARS } from "@ryco/shared/relayE2eeConstants";

import type {
  NodeE2eeClientListing,
  NodeE2eeContinuity,
  NodeE2eeFallback,
  NodeE2eePolicy,
  NodeE2eePrekey,
  NodeE2eeSessionList,
} from "@ryco/client-runtime/connection";

const calls: string[] = [];
let localSessionRole: "owner" | "client" = "owner";

/**
 * The node's sixteen operator routes, stubbed at the module the panel imports.
 *
 * Stubbed HERE rather than at `fetch`, because the assertion that matters in
 * hosted mode is that the panel never ASKS — the hosted HTTP boundary would
 * throw on the way out, and a `fetch`-level stub would hide the difference
 * between "asked and was refused" and "never asked".
 */
vi.mock("~/environments/primary", async (importOriginal) => ({
  // Spread the real module: this panel is not its only consumer, and replacing
  // the whole surface would strand every other importer in the graph.
  ...(await importOriginal<typeof import("~/environments/primary")>()),
  fetchSessionState: vi.fn(async () => ({
    authenticated: true,
    auth: {
      policy: "loopback-browser" as const,
      bootstrapMethods: ["one-time-token" as const],
      sessionMethods: ["browser-session-cookie" as const],
      sessionCookieName: "ryco_session",
    },
    role: localSessionRole,
    sessionMethod: "browser-session-cookie" as const,
  })),
  fetchHubEnrollment: vi.fn(async () => {
    calls.push("enrollment");
    return { fingerprint: "SHA256:ZZZZenrollmentZZZZ" };
  }),
  fetchNodeE2eeClients: vi.fn(async () => {
    calls.push("clients");
    return clients;
  }),
  fetchNodeE2eeSessions: vi.fn(async () => {
    calls.push("sessions");
    return SESSIONS;
  }),
  fetchNodeE2eePolicy: vi.fn(async () => {
    calls.push("policy");
    return POLICY;
  }),
  fetchNodeE2eePrekey: vi.fn(async () => {
    calls.push("prekey");
    return PREKEY;
  }),
  fetchNodeE2eeContinuity: vi.fn(async () => {
    calls.push("continuity");
    return CONTINUITY;
  }),
  fetchNodeE2eeFallback: vi.fn(async () => {
    calls.push("fallback");
    return FALLBACK;
  }),
  applyNodeE2eeAuthorization: vi.fn(async () => {
    calls.push("authorization");
    return { closedChannels: 0, abortedHandshakes: 0 };
  }),
  createNodeE2eeClientApprovalQr: vi.fn(async () => {
    calls.push("approval-qr");
    return {
      payload: "ryco-e2ee-approval-v1:test",
      approvedAt: 1_700_000_000_000,
      issuedAt: 1_700_000_001_000,
      expiresAt: 1_700_000_301_000,
    };
  }),
  setNodeE2eePairingWindow: vi.fn(async () => {
    calls.push("pairing-window");
    return CLIENTS;
  }),
  clearNodeE2eeRefusals: vi.fn(async () => {
    calls.push("refusals");
    return CLIENTS;
  }),
  previewNodeE2eePolicy: vi.fn(async () => {
    calls.push("policy-preview");
    return { policy: POLICY, withdrawal: true, changed: true, counts: COUNTS };
  }),
  applyNodeE2eePolicy: vi.fn(async () => {
    calls.push("policy-apply");
    return { policy: POLICY, withdrawal: true, changed: true, counts: COUNTS };
  }),
  recoverNodeE2eePolicyGeneration: vi.fn(async () => {
    calls.push("policy-recover");
    return { policy: POLICY, withdrawal: false, changed: true, counts: COUNTS };
  }),
  rotateNodeE2eePrekey: vi.fn(async () => {
    calls.push("prekey-rotate");
    return PREKEY;
  }),
  applyNodeE2eeContinuity: vi.fn(async () => {
    calls.push("continuity-apply");
    return { outcome: "reminted" as const };
  }),
  resetNodeE2eeFallback: vi.fn(async () => {
    calls.push("fallback-reset");
    return FALLBACK;
  }),
}));

import { applyWebE2eeVerificationCode } from "../../../test/hostedConnectionVocabulary";
import { resetWebE2eeSession } from "../../hostedHub/e2eeSession";
import { isHostedHubMode } from "../../env";
import {
  applyNodeE2eeAuthorization,
  applyNodeE2eePolicy,
  createNodeE2eeClientApprovalQr,
  previewNodeE2eePolicy,
} from "~/environments/primary";
import {
  E2EE_WEB_SAS_ADVISORY,
  E2EE_WEB_SAS_COMPARE,
  E2EE_WEB_SAS_DETAIL,
  E2EE_WEB_SAS_MORE,
} from "../hostedHub/HostedE2eeVerification.logic";
import { buildDiagnosticsBundle, serializeDiagnosticsBundle } from "./DiagnosticsPanel.logic";
import { NodeSecuritySettings } from "./NodeSecuritySettings";
import {
  everyNodeSecurityString,
  nodeE2eeActionConfirmation,
  nodeE2eeRecordConfirmation,
  nodePolicyPreviewWarnings,
  NODE_E2EE_APPROVAL_CAPABILITY_SET,
  NODE_SESSION_WEB_SAS_ADVISORY,
} from "./NodeSecuritySettings.logic";

/** A well-formed §13.4 rendering, built from the constants rather than typed. */
const SAFETY_NUMBER = Array.from({ length: E2EE_SAFETY_NUMBER_DIGITS.groups }, (_unused, index) =>
  String(24_680 + index).padStart(E2EE_SAFETY_NUMBER_DIGITS.digitsPerGroup, "0"),
).join(E2EE_SAFETY_NUMBER_DIGITS.separator);

/** Two well-formed §13.5 renderings: one from a node session, one from this tab. */
const NODE_SESSION_CODE = ["7HJ2", "MQ5T"].join(E2EE_WEB_SAS_CHARS.separator);
const OWN_CHANNEL_CODE = ["3QRT", "9KZ0"].join(E2EE_WEB_SAS_CHARS.separator);

const FINGERPRINT = "SHA256:AAAAclientAAAAclientAAAAclientAAAAclientAA0";
/**
 * A second record under THE SAME ACCOUNT AND ORIGIN, approved.
 *
 * Two devices paired under one Hub account is the case the per-record
 * confirmations exist for: the account, the origin and the stored label are
 * identical, so the fingerprint is the only thing that tells the rows apart.
 */
const SECOND_FINGERPRINT = "SHA256:BBBBlaptopBBBBlaptopBBBBlaptopBBBBlaptopB1";
const SECOND_SAFETY_NUMBER = Array.from(
  { length: E2EE_SAFETY_NUMBER_DIGITS.groups },
  (_unused, index) =>
    String(13_570 + index).padStart(E2EE_SAFETY_NUMBER_DIGITS.digitsPerGroup, "0"),
).join(E2EE_SAFETY_NUMBER_DIGITS.separator);

const CLIENTS: NodeE2eeClientListing = {
  records: [
    {
      status: "pending",
      hubOrigin: "https://hub.example.test",
      accountId: "acct_reader",
      fingerprint: FINGERPRINT,
      maxRole: "",
      capabilitySet: [],
      createdAt: 1_700_000_000_000,
      safetyNumber: SAFETY_NUMBER,
      pairingReserved: false,
      // The owner's own phone: the Hub opens its channels as `owner`.
      observedRole: "owner",
    },
    {
      status: "approved",
      hubOrigin: "https://hub.example.test",
      accountId: "acct_reader",
      fingerprint: SECOND_FINGERPRINT,
      maxRole: "operator",
      capabilitySet: ["ryco.rpc"],
      createdAt: 1_700_000_000_000,
      approvedAt: 1_700_000_000_000,
      safetyNumber: SECOND_SAFETY_NUMBER,
      pairingReserved: false,
      observedRole: "operator",
    },
  ],
  pendingGlobalSaturated: false,
  saturatedAccounts: [],
  refusedPairingAttempts: 2,
};

/** What the clients route answers with in the current test. */
let clients: NodeE2eeClientListing = CLIENTS;

/**
 * `CLIENTS` with one record's observed role replaced — or removed, which is a
 * record from before the node kept it.
 */
function withObservedRole(index: number, observedRole: string | undefined): NodeE2eeClientListing {
  return {
    ...CLIENTS,
    records: CLIENTS.records.map((record, at) => {
      if (at !== index) return record;
      const { observedRole: _previous, ...rest } = record;
      return observedRole === undefined ? rest : { ...rest, observedRole };
    }),
  };
}

const SESSIONS: NodeE2eeSessionList = {
  sessions: [
    {
      sessionIndex: 0,
      tier: "web",
      suite: 1,
      establishedAt: 1_700_000_000_000,
      verificationCode: NODE_SESSION_CODE,
    },
    { sessionIndex: 1, tier: "native", suite: 1, establishedAt: 1_700_000_000_000 },
  ],
};

const POLICY: NodeE2eePolicy = {
  requireE2EE: false,
  requireApprovedClientE2EE: false,
  effectiveRequireE2EE: false,
  admittedPatterns: ["IK", "NX"],
  suiteRegistry: [1],
  generation: 3,
};

const COUNTS = { legacy: 1, nxE2ee: 2, suiteWithdrawn: 0, abortedHandshakes: 0 };

const PREKEY: NodeE2eePrekey = {
  present: true,
  prekeyId: "prekey-1",
  fingerprint: "SHA256:BBBBprekeyBBBBprekeyBBBBprekeyBBBBprekeyBB0",
  createdAt: 1_700_000_000_000,
  expiresAt: 1_800_000_000_000,
  validity: "usable",
};

const CONTINUITY: NodeE2eeContinuity = {
  status: "advertisable",
  continuityId: "lineage-1",
  generation: 5,
  chainLength: 2,
};

const FALLBACK: NodeE2eeFallback = {
  windowStartedAt: 1_700_000_000_000,
  peerLegacy: { occurrences: 1, ringOverflows: 0, lastOccurrenceAt: 1_700_000_100_000 },
  advertisementUnavailable: { occurrences: 0, ringOverflows: 0 },
  ring: [{ occurredAt: 1_700_000_100_000, reason: "peer-legacy" }],
};

let mounted: Awaited<ReturnType<typeof render>> | null = null;

beforeEach(() => {
  calls.length = 0;
  localSessionRole = "owner";
  clients = CLIENTS;
  // Call history only — the factory's implementations stay in place. Without it
  // an assertion in one test would be satisfied by a click in an earlier one.
  vi.clearAllMocks();
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  resetWebE2eeSession();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const safetyNumber = () =>
  document.querySelector<HTMLElement>('[data-testid="node-safety-number"]');

/** Every rendered element whose text is exactly `label`, in document order. */
const buttonsLabelled = (label: string) =>
  [...document.querySelectorAll<HTMLElement>("button")].filter(
    (element) => (element.textContent ?? "").trim() === label,
  );

const confirmDialog = () => document.querySelector<HTMLElement>('[data-slot="alert-dialog-popup"]');
const confirmButton = () =>
  document.querySelector<HTMLElement>('[data-testid="node-confirmation-confirm"]');
const applyButton = () => document.querySelector<HTMLElement>('[data-testid="policy-apply"]');
const cancelButton = () =>
  [...document.querySelectorAll<HTMLElement>("button")].find(
    (element) => (element.textContent ?? "").trim() === "Cancel",
  );

async function mountLocalPanel() {
  mounted = await render(<NodeSecuritySettings />);
  await expect.element(page.getByText(SAFETY_NUMBER)).toBeVisible();
  return mounted;
}

describe("local mode: the node's operator state, and no alarm about a relay that is not there", () => {
  it("draws the node's data without a channel panel or a downgrade warning", async () => {
    // The harness has no `.env`, so `isHostedHubMode()` answers false — this is
    // genuinely the local build's behaviour and not a stub of it.
    expect(isHostedHubMode()).toBe(false);
    mounted = await render(<NodeSecuritySettings />);

    await expect.element(page.getByText(SAFETY_NUMBER)).toBeVisible();
    // Panel 6 is ABSENT: there is no relay in local mode, so there is no channel
    // to describe — and no "unavailable" badge inviting a reader to treat the
    // absence of relay encryption as a finding.
    expect(document.querySelector('[data-testid="node-connection-claim"]')).toBeNull();
    const body = document.body.textContent ?? "";
    for (const phrase of ["Not encrypted", "not encrypted", "Insecure", "Unencrypted"]) {
      expect(body, phrase).not.toContain(phrase);
    }
  });

  it("does not ask owner-only routes or expose their controls to a paired client", async () => {
    localSessionRole = "client";
    mounted = await render(<NodeSecuritySettings />);

    await expect
      .element(page.getByText("This browser is paired as a client.", { exact: false }))
      .toBeVisible();
    expect(calls).toEqual([]);
    expect(document.body.textContent).not.toContain("Authorized clients");
    expect(document.body.textContent).not.toContain("Admission policy");
    expect(document.body.textContent).not.toContain(
      "Only owner sessions can manage Hub connectivity",
    );
  });

  it("shows the §13.4 number with its caption and advisory, never behind a disclosure", async () => {
    mounted = await render(<NodeSecuritySettings />);
    await expect.element(page.getByText(SAFETY_NUMBER)).toBeVisible();

    const section = safetyNumber()!;
    expect(section.getAttribute("data-value")).toBe("present");
    // The duty is on the text accompanying the value, and text a reader has to
    // open is text most readers never see.
    expect(section.querySelector("details")).toBeNull();
    expect(section.querySelector("[hidden]")).toBeNull();
    expect(section.textContent).toContain("Compare this with the number the device itself shows");
    // Monospace: the comparison is digit by digit, which a proportional face
    // makes impossible.
    const value = section.querySelector<HTMLElement>('[data-testid="node-safety-number-value"]')!;
    expect(getComputedStyle(value).fontFamily.toLowerCase()).toMatch(/mono/u);
  });

  it("renders a node web session's §13.5 code with the NODE END's advisory", async () => {
    mounted = await render(<NodeSecuritySettings />);
    await expect.element(page.getByText(NODE_SESSION_CODE)).toBeVisible();

    // The advisory travels with the characters, and it is scoped to the value's
    // own container so a sentence elsewhere on the page cannot stand in for it.
    const code = document.querySelector<HTMLElement>('[data-testid="node-session-code"]')!;
    expect(code.textContent).toContain(NODE_SESSION_CODE);
    expect(code.textContent).toContain(NODE_SESSION_WEB_SAS_ADVISORY);

    // THE READER IS AT THE NODE. The shipped advisory says "Compare this code
    // with the one your node's CLI shows" — correct from the browser end, and a
    // comparison of the node against itself here: it always matches and
    // establishes nothing, while the row one line above told the owner to check
    // the browser instead. Both sentences were on screen at once.
    //
    // EVERY BROWSER-END STRING, NOT ONLY THE ONE THAT USED TO BE THE ONLY ONE.
    // §13.5's copy now ships at two lengths with a pointer each, and each of the
    // four inverts here for its own reason: the two advisories send the reader to
    // the wrong screen, `E2EE_WEB_SAS_MORE` points at the page this list is
    // already part of, and `E2EE_WEB_SAS_COMPARE` names the command that produces
    // this very list. Asserting only the first would have let the other three
    // arrive on the node's own session list unnoticed.
    expect(code.textContent).not.toContain("your node's CLI");
    for (const browserEnd of [
      E2EE_WEB_SAS_ADVISORY,
      E2EE_WEB_SAS_MORE,
      E2EE_WEB_SAS_DETAIL,
      E2EE_WEB_SAS_COMPARE,
    ]) {
      expect(document.body.textContent, browserEnd).not.toContain(browserEnd);
    }
    // …and a native session gets the pointer at the long-term value instead of a
    // blank that reads as a missing code.
    expect(document.body.textContent).toContain("Native sessions have no per-session code");
  });
});

describe("§13.4 and §13.5 are never written down", () => {
  it("reaches no storage, no console, and no diagnostics export while the panel is up", async () => {
    // The handshake suite spies the publish path and
    // `HostedE2eeVerification.browser.tsx` spies the WebSAS render path. This
    // one spies THIS panel, which draws four kinds of value the others never
    // see: the §13.4 comparison number, a node session's §13.5 code, this tab's
    // own §13.5 code, and the node's enrollment fingerprint.
    localStorage.clear();
    sessionStorage.clear();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    const clearStorage = vi.spyOn(Storage.prototype, "clear");
    const openDatabase = vi.spyOn(IDBFactory.prototype, "open");
    const sinks = (["debug", "error", "info", "log", "trace", "warn"] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => undefined),
    );

    applyWebE2eeVerificationCode(OWN_CHANNEL_CODE);
    mounted = await render(<NodeSecuritySettings />);
    await expect.element(page.getByText(SAFETY_NUMBER)).toBeVisible();
    await expect.element(page.getByText(NODE_SESSION_CODE)).toBeVisible();

    const secrets = [SAFETY_NUMBER, NODE_SESSION_CODE, OWN_CHANNEL_CODE, FINGERPRINT];

    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(clearStorage).not.toHaveBeenCalled();
    expect(openDatabase).not.toHaveBeenCalled();
    for (const sink of sinks) {
      for (const call of sink.mock.calls) {
        const serialized = call
          .map((argument) => `${String(argument)} ${safeJson(argument)}`)
          .join(" ");
        for (const secret of secrets) expect(serialized).not.toContain(secret);
      }
    }

    // Read back directly too, so a write that bypassed the prototype spies is
    // still caught.
    for (const store of [localStorage, sessionStorage]) {
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index)!;
        for (const secret of secrets) {
          expect(`${key} ${store.getItem(key) ?? ""}`).not.toContain(secret);
        }
      }
    }
    for (const secret of secrets) expect(document.cookie).not.toContain(secret);

    // The operator debug bundle is an allowlist, and none of these are on it.
    const bundle = serializeDiagnosticsBundle(
      buildDiagnosticsBundle({
        generatedAt: new Date(0).toISOString(),
        app: { version: "0.0.0", stage: "test", isElectron: false, userAgent: navigator.userAgent },
        environments: [],
        providers: [],
        observability: null,
        performance: null,
      }),
    );
    for (const secret of secrets) expect(bundle).not.toContain(secret);
  });

  it("puts no displayed value into a DOM attribute a browser could restore", async () => {
    // A `title`, a `value`, or a `data-` payload survives where the text does
    // not: form values are restored on reload and attributes are copied by
    // accessibility tooling.
    mounted = await render(<NodeSecuritySettings />);
    await expect.element(page.getByText(SAFETY_NUMBER)).toBeVisible();

    for (const element of document.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        for (const secret of [SAFETY_NUMBER, NODE_SESSION_CODE]) {
          expect(
            `${attribute.name}=${attribute.value}`,
            `${element.tagName} ${attribute.name}`,
          ).not.toContain(secret);
        }
      }
    }
  });
});

describe("the confirmation stands between the click and the network", () => {
  it("shows the dialog and sends nothing until the owner confirms", async () => {
    // §13.6's withdrawals close the target's live channels before the node
    // acknowledges them. Nothing asserted that a click was gated at all:
    // replacing `setConfirmation({...})` with a direct `run(...)` — every
    // destructive action firing on first click, no dialog — left both suites
    // green.
    await mountLocalPanel();

    const revoke = buttonsLabelled("Revoke");
    expect(revoke.length).toBeGreaterThan(0);
    revoke[0]!.click();

    const dialog = await vi.waitFor(() => {
      const found = confirmDialog();
      expect(found, "no confirmation dialog opened").not.toBeNull();
      return found!;
    });
    expect(applyNodeE2eeAuthorization).not.toHaveBeenCalled();
    expect(calls).not.toContain("authorization");
    // The dialog is the revoke one, tied to the action id rather than to
    // whatever copy happened to be lying in state.
    expect(dialog.textContent).toContain(nodeE2eeActionConfirmation("revoke").title);
    expect(confirmButton()?.textContent?.trim()).toBe(
      nodeE2eeActionConfirmation("revoke").confirmLabel,
    );

    // Cancelling still sends nothing.
    cancelButton()!.click();
    await vi.waitFor(() => {
      expect(confirmDialog()).toBeNull();
    });
    expect(applyNodeE2eeAuthorization).not.toHaveBeenCalled();

    // Reopening and confirming sends it exactly once.
    buttonsLabelled("Revoke")[0]!.click();
    await vi.waitFor(() => {
      expect(confirmButton()).not.toBeNull();
    });
    confirmButton()!.click();
    await vi.waitFor(() => {
      expect(applyNodeE2eeAuthorization).toHaveBeenCalledTimes(1);
    });
    expect(applyNodeE2eeAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ action: "revoke", fingerprint: FINGERPRINT }),
    );
  });

  it("names the record it will withdraw, so two rows do not read the same", async () => {
    // Both records carry the same account and origin and neither has a stored
    // label, so the dialog is the only place the owner can tell the phone from
    // the laptop — and it paints an opaque scrim over the row behind it.
    await mountLocalPanel();

    const revoke = buttonsLabelled("Revoke");
    expect(revoke.length).toBeGreaterThanOrEqual(2);

    revoke[0]!.click();
    const first = await vi.waitFor(() => {
      const found = confirmDialog();
      expect(found).not.toBeNull();
      return found!.textContent ?? "";
    });
    expect(first).toContain(FINGERPRINT);
    expect(first).not.toContain(SECOND_FINGERPRINT);
    // …in a face that makes a character-by-character check possible.
    const facts = document.querySelector<HTMLElement>('[data-testid="node-confirmation-facts"]')!;
    const value = [...facts.querySelectorAll<HTMLElement>("dd")].find((element) =>
      (element.textContent ?? "").includes(FINGERPRINT),
    )!;
    expect(getComputedStyle(value).fontFamily.toLowerCase()).toMatch(/mono/u);

    cancelButton()!.click();
    await vi.waitFor(() => {
      expect(confirmDialog()).toBeNull();
    });

    buttonsLabelled("Revoke")[1]!.click();
    const second = await vi.waitFor(() => {
      const found = confirmDialog();
      expect(found).not.toBeNull();
      return found!.textContent ?? "";
    });
    expect(second).toContain(SECOND_FINGERPRINT);
    expect(second).not.toContain(FINGERPRINT);
  });

  it("echoes the fingerprint a pairing window would admit", async () => {
    await mountLocalPanel();
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Pairing window fingerprint"]',
    )!;
    await userEvent.fill(input, "SHA256:CCCCwindowCCCC");
    buttonsLabelled("Open")[0]!.click();

    const dialog = await vi.waitFor(() => {
      const found = confirmDialog();
      expect(found).not.toBeNull();
      return found!;
    });
    // Its own body names a wrong fingerprint as the risk; withholding the value
    // is withholding the evidence for the risk it just raised.
    expect(dialog.textContent).toContain("lets the wrong device in");
    expect(dialog.textContent).toContain("SHA256:CCCCwindowCCCC");
  });
});

describe("§13.6 the request an approval builds is the one the owner was shown", () => {
  it("approves at the role the device connects with, with a capability set the node can admit", async () => {
    // The dialog and the wire could disagree silently: nothing asserted the
    // built request at all, so `maxRole: "owner", capabilitySet: ["*"]` behind a
    // differently labelled button left both suites green. And the shipped set
    // was EMPTY, which §8.6 step 6 refuses on every native handshake — an
    // `approved` record that cannot connect.
    await mountLocalPanel();

    buttonsLabelled("Approve as owner")[0]!.click();
    await vi.waitFor(() => {
      expect(confirmButton()).not.toBeNull();
    });
    expect(confirmDialog()!.textContent).toContain("Approve this client key as owner?");
    confirmButton()!.click();

    await vi.waitFor(() => {
      expect(applyNodeE2eeAuthorization).toHaveBeenCalledTimes(1);
    });
    expect(applyNodeE2eeAuthorization).toHaveBeenCalledWith({
      hubOrigin: "https://hub.example.test",
      accountId: "acct_reader",
      fingerprint: FINGERPRINT,
      action: "approve",
      maxRole: "owner",
      capabilitySet: NODE_E2EE_APPROVAL_CAPABILITY_SET,
    });
    await vi.waitFor(() => {
      expect(createNodeE2eeClientApprovalQr).toHaveBeenCalledWith({
        hubOrigin: "https://hub.example.test",
        accountId: "acct_reader",
        fingerprint: FINGERPRINT,
      });
      expect(document.body.textContent).toContain("Verify this phone");
    });
    expect(NODE_E2EE_APPROVAL_CAPABILITY_SET.length).toBeGreaterThan(0);
  });

  it("offers no ceiling below the role the device connects with", async () => {
    // §8.3 makes a native client's intended role equal its `channel.open` role,
    // so a smaller ceiling refuses the device rather than limiting it. The
    // buttons this replaced led with "Approve as viewer" — a green row whose
    // every handshake was then refused.
    await mountLocalPanel();
    for (const role of ["viewer", "operator"]) {
      expect(buttonsLabelled(`Approve as ${role}`), role).toHaveLength(0);
    }
    expect(buttonsLabelled("Approve as owner")).toHaveLength(1);
    expect(document.querySelector('[data-testid="node-approval-role-unknown"]')).toBeNull();
  });

  it("offers no approval at all for a request that does not say its role", async () => {
    // A record from before the node kept the role. Any button here would be a
    // guess, and the wrong guess is the lockout — so the row says what to do.
    clients = withObservedRole(0, undefined);
    await mountLocalPanel();
    expect(
      [...document.querySelectorAll<HTMLElement>("button")].filter((element) =>
        (element.textContent ?? "").trim().startsWith("Approve as"),
      ),
    ).toHaveLength(0);
    expect(
      document.querySelector('[data-testid="node-approval-role-unknown"]')?.textContent,
    ).toContain("Have the device try again");
  });

  it("offers Reduce to viewer only where the device would still get in", async () => {
    // The approved record connects as `operator`: a `viewer` ceiling would
    // refuse it on its next handshake, not narrow it — Revoke says that honestly.
    await mountLocalPanel();
    expect(buttonsLabelled("Reduce to viewer")).toHaveLength(0);
    expect(buttonsLabelled("Revoke").length).toBeGreaterThanOrEqual(2);
  });

  it("narrows a record approved above the role it connects with", async () => {
    clients = withObservedRole(1, "viewer");
    await mountLocalPanel();
    expect(buttonsLabelled("Reduce to viewer")).toHaveLength(1);

    buttonsLabelled("Reduce to viewer")[0]!.click();
    await vi.waitFor(() => {
      expect(confirmDialog()).not.toBeNull();
    });
    expect(confirmDialog()!.textContent).toContain(SECOND_FINGERPRINT);
    // …and the confirmation says the capability grant is untouched, because the
    // request carries no capability set and the node reads that as "leave it".
    expect(confirmDialog()!.textContent).toContain(
      nodeE2eeRecordConfirmation("narrow", {
        fingerprint: SECOND_FINGERPRINT,
        accountId: "acct_reader",
        hubOrigin: "https://hub.example.test",
      }).body,
    );
  });
});

describe("§12.6 preview first, always", () => {
  it("previews without applying, warns, and applies only on the second press", async () => {
    // Nothing distinguished the non-mutating preview route from the mutating
    // apply route: swapping `previewNodeE2eePolicy` for `applyNodeE2eePolicy`
    // left both suites green, which commits the policy and sweeps the channels
    // §12.6 says to warn about, then offers to "Apply" what already happened.
    await mountLocalPanel();

    document.querySelector<HTMLElement>('[data-testid="require-e2ee"]')!.click();
    await vi.waitFor(() => {
      expect(previewNodeE2eePolicy).toHaveBeenCalledTimes(1);
    });
    expect(calls.filter((entry) => entry.startsWith("policy-"))).toEqual(["policy-preview"]);
    expect(applyNodeE2eePolicy).not.toHaveBeenCalled();
    expect(previewNodeE2eePolicy).toHaveBeenCalledWith({ requireE2EE: true });

    const dialog = await vi.waitFor(() => {
      const found = applyButton();
      expect(found, "the §12.6 dialog did not open").not.toBeNull();
      return confirmDialog()!;
    });
    for (const warning of nodePolicyPreviewWarnings(
      { policy: POLICY, withdrawal: true, changed: true, counts: COUNTS },
      { requireE2EE: true },
      POLICY,
    )) {
      expect(dialog.textContent).toContain(warning);
    }

    applyButton()!.click();
    await vi.waitFor(() => {
      expect(applyNodeE2eePolicy).toHaveBeenCalledTimes(1);
    });
    expect(calls.filter((entry) => entry.startsWith("policy-"))).toEqual([
      "policy-preview",
      "policy-apply",
    ]);
  });

  it("applies nothing when the preview dialog is dismissed", async () => {
    await mountLocalPanel();
    document.querySelector<HTMLElement>('[data-testid="require-e2ee"]')!.click();
    await vi.waitFor(() => {
      expect(applyButton()).not.toBeNull();
    });

    [...document.querySelectorAll<HTMLElement>("button")]
      .find((element) => (element.textContent ?? "").trim() === "Leave it")!
      .click();
    await vi.waitFor(() => {
      expect(applyButton()).toBeNull();
    });
    expect(applyNodeE2eePolicy).not.toHaveBeenCalled();
  });

  it("reports §12.6(c)'s counts rather than a generic acknowledgement", async () => {
    // The summary was built and then overwritten by "Policy applied." in the
    // same microtask, so the counts the apply route exists to return were never
    // painted.
    await mountLocalPanel();
    document.querySelector<HTMLElement>('[data-testid="require-e2ee"]')!.click();
    await vi.waitFor(() => {
      expect(applyButton()).not.toBeNull();
    });
    applyButton()!.click();

    await vi.waitFor(() => {
      const body = document.body.textContent ?? "";
      expect(body).toContain(`${COUNTS.legacy} legacy channel(s)`);
      expect(body).toContain(`${COUNTS.nxE2ee} browser channel(s)`);
    });
    expect(document.body.textContent).not.toContain("Policy applied.");
  });
});

describe("the rendered panel makes no claim it has not earned", () => {
  it.each([
    // The same list the unit scan walks, run over the DOM — which is the only
    // scan that reaches copy written inside the `.tsx`. The unit scan sees only
    // what this module produces, and the local mode is where the client list,
    // the sessions, the policy and the fallback report are all drawn.
    "end-to-end encrypted",
    "proof",
    "no interposer",
    "cannot be intercepted",
    "unforgeable",
    "guaranteed",
    "verified",
    "your connection is secure",
    "this session is protected",
    "you are protected",
    "nobody can read",
  ])("never renders %j anywhere on the page", async (phrase) => {
    await mountLocalPanel();
    // Every action's confirmation copy too: the dialogs are rendered on demand,
    // so open one before scanning.
    buttonsLabelled("Revoke")[0]!.click();
    await vi.waitFor(() => {
      expect(confirmDialog()).not.toBeNull();
    });
    expect((document.body.textContent ?? "").toLowerCase()).not.toContain(phrase);
  });

  it("covers with the DOM scan what the unit scan cannot see", async () => {
    // A sanity check on the scan itself: the panel must actually be rendering
    // the module's sentences, or the `it.each` above is vacuous.
    await mountLocalPanel();
    const body = document.body.textContent ?? "";
    const rendered = everyNodeSecurityString().filter((entry) => body.includes(entry.text));
    expect(rendered.length).toBeGreaterThan(10);
  });
});

/** One argument flattened as far as it goes, for a string scan. */
function safeJson(argument: unknown): string {
  try {
    return JSON.stringify(argument) ?? "";
  } catch {
    return "";
  }
}
