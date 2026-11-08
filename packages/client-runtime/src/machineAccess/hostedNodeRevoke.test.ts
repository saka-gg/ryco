// The revoke surface's decisions and, above all, its claims.
//
// Revoking a node is the only action in the hosted directory that cannot be
// taken back, and it is the one whose copy is easiest to overstate: it looks
// like it does something to the machine, and it does not. What is pinned here is
// therefore the copy's *silence* on that as much as its content, plus the
// failure mapping, whose whole job is to not lie about whether anything changed.

import { describe, expect, it } from "vite-plus/test";

import {
  everyHostedNodeRevokeFailureProbe,
  everyHostedNodeRevokeString,
  hostedNodeRevokeConfirmation,
  hostedNodeRevokeFailure,
  hostedNodeRevokedNotice,
  hostedNodeRevokeRetryable,
  HOSTED_NODE_REVOKE_CONSEQUENCES,
  HOSTED_NODE_REVOKE_REASON_CODE,
} from "./hostedNodeRevoke.ts";

const NODE = {
  id: "node_aaaaaaaaaaaaaaaaaaaaaa",
  label: "Studio",
} as const;

describe("revoke confirmation", () => {
  it("names the node in its title and carries the identifier the label cannot supply", () => {
    const confirmation = hostedNodeRevokeConfirmation(NODE);
    expect(confirmation.title).toContain(NODE.label);
    // The prompt exists to send the reader to the identifier rendered beside it;
    // a confirmation over near-identical rows that names only a shared label
    // catches an accidental click and nothing else.
    expect(confirmation.subjectPrompt.toLowerCase()).toContain("identifier");
  });

  it("gives two nodes sharing a label two different confirmations", () => {
    // The failure this list is shaped to produce is a click on the wrong ROW,
    // not a click on nothing. Two machines named the same way must not produce
    // the same dialog — and this used to assert the OPPOSITE of its own name
    // (`first.title === second.title`) plus a comparison of two string literals
    // that touched no production code at all. Replacing the title with a
    // constant "Revoke this node?" left it green.
    const first = hostedNodeRevokeConfirmation({ id: "node_" + "a".repeat(22), label: "Studio" });
    const second = hostedNodeRevokeConfirmation({ id: "node_" + "b".repeat(22), label: "Studio" });
    // The label alone genuinely cannot separate them, which is why the
    // confirmation carries the identifier as well as the title.
    expect(first.title).toBe(second.title);
    expect(first.subjectId).not.toBe(second.subjectId);
    expect(first.subjectId).toBe("node_" + "a".repeat(22));
  });

  it("states every consequence, and does not drop one silently", () => {
    expect(HOSTED_NODE_REVOKE_CONSEQUENCES.map((entry) => entry.id)).toEqual([
      "access",
      "direct",
      "directory",
      "return",
      "reach",
    ]);
    for (const consequence of HOSTED_NODE_REVOKE_CONSEQUENCES) {
      expect(consequence.text.length, `${consequence.id} is empty`).toBeGreaterThan(20);
    }
  });

  it("scopes the access it revokes to this Hub rather than to the machine", () => {
    // `/api/admin/nodes/{id}/revoke` revokes the NODE's Hub grants. The separate
    // grant route removes a single account's access, so "everyone" is required
    // — but the machine also serves clients that paired with it directly, whose
    // node-local sessions this call does not touch. An owner revoking a stolen
    // laptop who reads "everyone authorized on it" believes the machine is
    // locked down when the thief still reaches it over the LAN.
    const access = HOSTED_NODE_REVOKE_CONSEQUENCES.find((entry) => entry.id === "access")!;
    const lower = access.text.toLowerCase();
    expect(lower).toContain("everyone");
    expect(lower).toContain("hub");
    expect(lower, "it claims the whole machine").not.toContain("authorized on it");
  });

  it("names the door this does not close, and where that one is closed", () => {
    const direct = HOSTED_NODE_REVOKE_CONSEQUENCES.find((entry) => entry.id === "direct")!;
    const lower = direct.text.toLowerCase();
    expect(lower).toContain("paired directly");
    // The remaining step is useless if the owner is not told what it is.
    expect(lower).toContain("ryco auth");
  });

  it("says returning starts on the machine, not with a device code", () => {
    // After a Hub revocation the node still holds its local Hub identity —
    // `HubConnector.enroll()` throws while an `activeNode` is on disk and
    // `resume()` early-returns on `revoked`, so the only exit is `leave()`.
    // "Enroll it again" on its own sends an owner to a machine that refuses
    // before a device code is ever issued, and reads as a Hub bug.
    const returning = HOSTED_NODE_REVOKE_CONSEQUENCES.find((entry) => entry.id === "return")!;
    const lower = returning.text.toLowerCase();
    expect(lower).toContain("enroll");
    expect(lower).toContain("not a reconnection");
    expect(lower).toContain("leave this hub");
    expect(lower).toContain("on the machine itself");
  });

  it("carries the every-account scope on the line that claims it", () => {
    // The scope used to ride entirely on the preceding consequence's "everyone",
    // which is a claim about grants rather than about the directory listing. The
    // Hub answers null from `authorizedDirectoryEntry` for a revoked node on
    // EVERY account, so the copy was weaker than the guarantee.
    const directory = HOSTED_NODE_REVOKE_CONSEQUENCES.find((entry) => entry.id === "directory")!;
    expect(directory.text.toLowerCase()).toContain("every account");
  });

  it("says the revocation is recorded on the Hub and holds for an unreachable node", () => {
    // The one claim an owner is buying this control for: a node that is gone
    // does not have to come back in order to be revoked.
    const reach = HOSTED_NODE_REVOKE_CONSEQUENCES.find((entry) => entry.id === "reach")!;
    const lower = reach.text.toLowerCase();
    expect(lower).toContain("hub");
    expect(lower).toContain("offline");
  });

  it("sends a reason code the Hub's strict body schema accepts", () => {
    // `REASON` on the Hub is `/^[a-z0-9._-]{1,64}$/` and `reasonCode` is
    // REQUIRED, not optional — a value outside it is a 400 that says nothing
    // about which field was wrong.
    expect(HOSTED_NODE_REVOKE_REASON_CODE).toMatch(/^[a-z0-9._-]{1,64}$/);
  });
});

describe("prohibited claims", () => {
  it.each([
    // Revocation is Hub-side state and contacts nothing. Every token below would
    // describe an effect on the machine that does not happen — and the scan is a
    // bare substring match that cannot tell a claim from its denial, so the
    // words are absent in both directions.
    "notif",
    "wipe",
    "erase",
    "delete",
    "uninstall",
    "factory reset",
    "shut down",
    "shutdown",
    "power off",
    "disk",
    "local data",
    "its files",
    // Nor is the node a party to this. It is not asked, told, or waited for.
    "tells the node",
    "informs the node",
    "let the node know",
    "the node is asked",
    // And nothing here is reversible or undoable, so no sentence may hint at it.
    "restore",
    "re-enable",
    "reinstate",
  ])("never says %j", (phrase) => {
    for (const { where, text } of everyHostedNodeRevokeString()) {
      expect(text.toLowerCase(), `${where} says ${phrase}`).not.toContain(phrase);
    }
  });

  it("never tells the owner a refusal the Hub pronounced may have partly landed", () => {
    // The inverse failure: a message that hedges on an action the Hub explicitly
    // refused teaches an owner to distrust every refusal, including the ones
    // that are exact. Only answers the Hub actually sent belong here — a request
    // that got no answer at all is not a refusal, and the row below it used to
    // claim otherwise.
    for (const [where, message] of [
      ["forbidden", hostedNodeRevokeFailure({ code: "forbidden", status: 403 }).message],
      ["rateLimited", hostedNodeRevokeFailure({ code: "rate_limited", status: 429 }).message],
      ["conflict", hostedNodeRevokeFailure({ code: "conflict", status: 409 }).message],
    ] as const) {
      expect(message.toLowerCase(), `${where} hedges`).toContain("nothing was changed");
    }
  });

  it("keeps every message bounded and free of transport detail", () => {
    for (const { where, text } of everyHostedNodeRevokeString()) {
      expect(text.length, `${where} is unbounded`).toBeLessThanOrEqual(280);
      // No status numbers, no wire codes, no paths: the Hub's own vocabulary is
      // not an owner-facing one.
      expect(text, `${where} leaks a wire code`).not.toMatch(
        /node_forbidden|node_not_found|node_rate_limited|invalid_response|\/api\//,
      );
    }
  });

  it("scans every branch the mapping can reach, not the ones someone listed", () => {
    // `everyHostedNodeRevokeString` used to end in a hand-written array of
    // causes, so a new branch — say a 423 whose copy promised the machine's data
    // would be wiped — shipped past the phrase scan, the length bound and the
    // wire-code check untouched, because nothing ever called it. Each branch now
    // carries the input that reaches it, and this asserts that input still does.
    const probes = everyHostedNodeRevokeFailureProbe();
    expect(probes.length, "the branch table is empty").toBeGreaterThan(5);

    const scanned = new Set(everyHostedNodeRevokeString().map((entry) => entry.where));
    const messages = new Set<string>();
    for (const { id, probe } of probes) {
      expect(scanned, `branch ${id} is not scanned`).toContain(`failure(${id})`);
      // A branch its own probe cannot select is a branch the scan reads through
      // some *other* branch's message — a hole that looks like coverage.
      messages.add(hostedNodeRevokeFailure(probe).message);
    }
    expect(messages.size, "two branches answer one probe with one message").toBe(probes.length);
    // And the unreachable-by-probe fallback is scanned too.
    expect(scanned).toContain("failure(fallback)");
  });
});

describe("failure mapping", () => {
  it("keeps the node standing for every refusal the Hub made before changing anything", () => {
    // Every row here is an answer the Hub sent, or a guard that ran before the
    // request was built. `timeout` and `unavailable` used to sit in this list;
    // they are not refusals and they have their own assertion below.
    for (const [where, cause] of [
      ["unauthorized", { code: "session_invalid", status: 401 }],
      ["csrf", { code: "csrf_rejected", status: 403 }],
      ["forbidden", { code: "forbidden", status: 403 }],
      ["conflict", { code: "conflict", status: 409 }],
      ["rateLimited", { code: "node_rate_limited", status: 429 }],
      ["badRequest", { code: "invalid_request", status: 400 }],
      ["unknownShape", new Error("boom")],
    ] as const) {
      const failure = hostedNodeRevokeFailure(cause);
      expect(failure.outcome, `${where} claimed the wrong outcome`).toBe("unchanged");
      // …and the same button is still worth pressing, because the node is
      // exactly where it was.
      expect(hostedNodeRevokeRetryable(failure), `${where} withdrew a live retry`).toBe(true);
      expect(failure.message.length).toBeGreaterThan(0);
    }
  });

  it("refuses to say nothing changed when the request left and no answer came back", () => {
    // `timeout` is this client's own 30-second deadline aborting an in-flight
    // request: the POST was written and the Hub had the whole window to commit
    // `revoked_at`. `unavailable` is a bare fetch rejection, which covers a
    // connection dropped while the response was being read. Neither knows
    // whether the Hub committed, and "nothing was changed" over an irreversible
    // action is how an owner ends up never warning the machine's user and never
    // re-enrolling a node that is in fact revoked.
    for (const [where, cause] of [
      ["timeout", { code: "timeout", status: 0 }],
      ["unavailable", { code: "unavailable", status: 0 }],
      ["bareStatusZero", { status: 0 }],
    ] as const) {
      const failure = hostedNodeRevokeFailure(cause);
      expect(failure.outcome, `${where} claimed an outcome it cannot know`).toBe("unknown");
      const lower = failure.message.toLowerCase();
      expect(lower, `${where} claims nothing was changed`).not.toContain("nothing was changed");
      expect(lower, `${where} does not say the outcome is unread`).toContain("not known");
      // The next useful step is the list, not a second irreversible write
      // against a node that may have taken the first one.
      expect(hostedNodeRevokeRetryable(failure), `${where} re-offers the write`).toBe(false);
    }
  });

  it("separates an owner refusal from an expired session", () => {
    const forbidden = hostedNodeRevokeFailure({ code: "forbidden", status: 403 });
    const unauthorized = hostedNodeRevokeFailure({ code: "session_invalid", status: 401 });
    expect(forbidden.message).not.toBe(unauthorized.message);
    expect(forbidden.message.toLowerCase()).toContain("owner");
    expect(unauthorized.message.toLowerCase()).toContain("sign in");
  });

  it("separates a stale CSRF token from an expired session", () => {
    // A CSRF rejection is not a session expiry, and `csrf_rejected` arrives with
    // status 403 — so folding it into the 401 branch told an owner with a
    // long-lived tab to sign out and back in, losing whatever else was unsaved,
    // when a page refresh was the fix. The client's own vocabulary for this code
    // is "the request could not be verified".
    const csrf = hostedNodeRevokeFailure({ code: "csrf_rejected", status: 403 });
    const unauthorized = hostedNodeRevokeFailure({ code: "session_invalid", status: 401 });
    expect(csrf.outcome).toBe("unchanged");
    expect(csrf.message).not.toBe(unauthorized.message);
    expect(csrf.message.toLowerCase()).toContain("could not be verified");
    expect(csrf.message.toLowerCase()).toContain("refresh");
    expect(csrf.message.toLowerCase(), "it blames the session").not.toContain("sign in");
    // And it is not swallowed by the plain-403 owner refusal either.
    expect(csrf.message.toLowerCase()).not.toContain("owner");
  });

  it("reads a 404 as already gone rather than as a lookup failure", () => {
    // The Hub's update is conditioned on `revoked_at IS NULL`, so a second
    // revoke of the same node answers 404. Reporting that as "no such node"
    // would tell an owner their node is unknown to a Hub that has it on file.
    const failure = hostedNodeRevokeFailure({ code: "not_found", status: 404 });
    expect(failure.outcome).toBe("already-gone");
    expect(failure.message.toLowerCase()).toContain("already revoked");
    // Pressing it again is the same 404 forever, so the button is withdrawn.
    expect(hostedNodeRevokeRetryable(failure)).toBe(false);
  });

  it("refuses to claim an outcome it does not have when the answer is unreadable", () => {
    // `invalid_response` is thrown only AFTER a request the Hub accepted, so
    // "nothing was revoked" there is a guess presented as a fact about an
    // irreversible action.
    const failure = hostedNodeRevokeFailure({ code: "invalid_response", status: 502 });
    expect(failure.outcome).toBe("unknown");
    expect(failure.message.toLowerCase()).toContain("not known");
    expect(failure.message.toLowerCase()).not.toContain("nothing was changed");
    // And it does not re-offer a second irreversible write against a node that
    // may have taken the first one.
    expect(hostedNodeRevokeRetryable(failure)).toBe(false);
  });

  it("treats no failure at all as retryable, so the button exists before anything is pressed", () => {
    expect(hostedNodeRevokeRetryable(null)).toBe(true);
  });

  it("acknowledges a landed revocation by naming the node it removed", () => {
    // The row disappearing is not an acknowledgement: the re-read that removes
    // it settles its own failures into `directoryStatus` and leaves `nodes`
    // untouched, so a blip after an irreversible write leaves the list looking
    // exactly as it did before. And "Node revoked" over a list of near-identical
    // rows is the same ambiguity the confirmation's title exists to avoid.
    const notice = hostedNodeRevokedNotice("Studio");
    expect(notice).toContain("Studio");
    expect(notice.toLowerCase()).toContain("revoked");
    expect(hostedNodeRevokedNotice("Travel")).not.toBe(notice);
  });

  it("reads the error structurally rather than through a class identity", () => {
    // The error crosses a package boundary. An `instanceof` check would be one
    // duplicated class identity away from reporting every Hub refusal as the
    // generic fallback.
    expect(hostedNodeRevokeFailure({ status: 403 }).message.toLowerCase()).toContain("owner");
    expect(hostedNodeRevokeFailure(null).outcome).toBe("unchanged");
    expect(hostedNodeRevokeFailure(undefined).outcome).toBe("unchanged");
    expect(hostedNodeRevokeFailure("403").outcome).toBe("unchanged");
  });
});

describe("app surface", () => {
  it("names the device and the screen, never a browser or a page", () => {
    for (const { id, probe } of everyHostedNodeRevokeFailureProbe()) {
      const message = hostedNodeRevokeFailure(probe, "app").message.toLowerCase();
      expect(message, `${id} names a browser`).not.toContain("browser");
      expect(message, `${id} names a page`).not.toContain("page");
    }
  });

  it("claims exactly the outcome the browser wording claims", () => {
    for (const { id, probe } of everyHostedNodeRevokeFailureProbe()) {
      expect(hostedNodeRevokeFailure(probe, "app").outcome, id).toBe(
        hostedNodeRevokeFailure(probe).outcome,
      );
    }
    const transport = hostedNodeRevokeFailure({ code: "unavailable", status: 0 }, "app");
    expect(transport.message.toLowerCase()).toContain("this device");
    expect(transport.message.toLowerCase()).toContain("not known");
    expect(hostedNodeRevokeRetryable(transport)).toBe(false);
  });

  it("is scanned with the browser wording", () => {
    const scanned = new Set(everyHostedNodeRevokeString().map((entry) => entry.where));
    for (const { id } of everyHostedNodeRevokeFailureProbe()) {
      expect(scanned).toContain(`appFailure(${id})`);
    }
  });
});
