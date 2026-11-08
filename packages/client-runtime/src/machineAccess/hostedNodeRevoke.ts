// Every decision and every owner-facing sentence behind revoking a node from
// the hosted directory, shared by the web directory and the phone's machine
// access screen so both say the same thing about an irreversible action.
//
// Pure for the reason `HostedRelayTrustNotice.logic.ts` and
// `NodeSecuritySettings.logic.ts` are: a claim that could mislead an owner about
// what an irreversible action did belongs somewhere a node test can read it
// without a DOM, and under a prohibited-phrase scan. Nothing here imports React
// or React Native.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT REVOKING A NODE ACTUALLY DOES, READ OFF THE HUB
// ─────────────────────────────────────────────────────────────────────────────
// `POST /api/admin/nodes/{nodeId}/revoke` runs one Hub-side transaction:
//
//   * `nodes.revoke` is `UPDATE nodes SET revoked_at=… WHERE id=? AND
//     revoked_at IS NULL`, so it is monotonic. Nothing in the Hub's persistence
//     layer ever writes `revoked_at=NULL` back onto a node row.
//   * `authorizedDirectoryEntry` returns `null` for a node with `revokedAt` set,
//     and `/api/nodes` is that function filtered — so the node leaves EVERY
//     authorized account's directory, not only the acting owner's, and cannot
//     come back.
//   * the revocation signal is an in-process bus. Its relay subscriber closes
//     channels the Hub already holds open and drops the node's own socket if one
//     is connected. There is no leg that contacts the machine.
//
// The last point is the whole reason this control exists, and it is also the
// easiest thing to lie about: a node that is offline, unreachable, or gone for
// good is revoked by exactly this call, on exactly this path. Nothing is sent to
// it, nothing on it changes, and it is not asked to agree.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND WHAT IT DOES NOT REACH, WHICH IS THE SAME FACT READ FORWARDS
// ─────────────────────────────────────────────────────────────────────────────
// "There is no leg that contacts the machine" is what makes this safe, and it is
// also why the copy may not describe it as a kill switch for the machine. The
// node keeps serving the clients that paired with it DIRECTLY: `ryco serve`
// hands out pairing credentials that `SessionCredentialService` exchanges for
// node-local sessions in the node's own table, with no coupling to any Hub
// revocation state, and `apps/server/src/server.ts` merges those auth routes and
// `hubConnectorRoutesLayer` into one router unconditionally. Cutting those takes
// `ryco auth` ON the machine.
//
// The node also keeps its local Hub identity, because the Hub wrote nothing to
// it. `HubConnector.resume()` early-returns on `revoked` and `enroll()` throws
// while an `activeNode` is on disk, so the only exit is `leave()` — surfaced to
// an owner as "Leave this Hub". An owner told to "enroll it again" and nothing
// else walks to the machine and hits a connector that refuses before a device
// code is ever issued.

/**
 * One node, as the confirmation must be able to name it.
 *
 * The `id` is carried in full rather than as a prefix. Two nodes enrolled from
 * the same machine, or simply named the same way, are told apart by nothing else
 * the directory renders — and the dialog paints a scrim over the row behind it,
 * so the row cannot be re-read while the confirmation is up.
 */
export interface HostedNodeRevokeSubject {
  readonly id: string;
  readonly label: string;
}

/**
 * The reason code recorded against the revocation.
 *
 * The Hub requires one — its body schema is strict and the field is not optional
 * — and constrains it to `[a-z0-9._-]{1,64}`. It is a fixed value rather than a
 * free-text field the owner fills in: the string lands in the Hub audit trail and
 * in owner inventory, and a prompt for prose at the moment of an irreversible
 * action buys a worse confirmation, not a better record.
 */
export const HOSTED_NODE_REVOKE_REASON_CODE = "owner_revoked";

/** A single line of the consequence list, in the order an owner reads them. */
export interface HostedNodeRevokeConsequence {
  readonly id: "access" | "direct" | "directory" | "return" | "reach";
  readonly text: string;
}

/**
 * What the owner is agreeing to, in the consequence's own terms.
 *
 * EVERY LINE IS SCOPED TO THE HUB, because that is the only thing this call
 * changes. An owner reaches for a control named "Revoke" on a machine they have
 * stopped trusting — a stolen laptop is the case — and the question they are
 * actually asking is "is that machine locked down now?". The answer is no: the
 * Hub door is shut and the machine's own door is untouched. A line that said
 * "everyone authorized on it" would answer yes, and would talk an owner out of
 * the one step that would help.
 *
 * `direct` states that boundary POSITIVELY rather than as a denial. The
 * prohibited-phrase scan below is a bare substring match and cannot tell a claim
 * from its negation, so "the node is not wiped" would trip it while also
 * planting the idea. Saying what remains true — the machine keeps serving its
 * own paired clients, and here is where those are managed — costs the owner
 * nothing to read and does not require the scan to be weakened.
 *
 * "Everyone" in `access` is load-bearing and is not a flourish. This route
 * revokes the NODE; the separate grant route revokes one account's access. An
 * owner who read this as "I lose my access to it" would be misinformed about a
 * change that reaches every account authorized through this Hub. `directory`
 * carries the same scope in its own words rather than borrowing it from the line
 * above: the two make different claims (grants, and the directory listing), and
 * the Hub guarantees both for every account.
 *
 * `return` names the machine-side step. After a Hub revocation the node still
 * holds its local Hub identity — `enroll()` throws while an `activeNode` exists
 * — so "enroll it again" on its own sends an owner to a machine that refuses
 * before it issues a device code, and reads as a Hub bug.
 */
export const HOSTED_NODE_REVOKE_CONSEQUENCES: ReadonlyArray<HostedNodeRevokeConsequence> =
  Object.freeze([
    Object.freeze({
      id: "access" as const,
      text: "Every Hub grant on this node stops working immediately, for everyone authorized through this Hub — not only for you — and any relay channel it has open right now closes.",
    }),
    Object.freeze({
      id: "direct" as const,
      text: "Clients paired directly with that machine are separate and keep working. Those are managed on the machine itself, with the ryco auth command.",
    }),
    Object.freeze({
      id: "directory" as const,
      text: "It leaves the directory for every account on this Hub, not only yours, and stays gone. There is no undo here and no state it can return to.",
    }),
    Object.freeze({
      id: "return" as const,
      text: "Putting that machine back starts on the machine itself: use “Leave this Hub” there, then enroll it again with a new device code and your approval. It is a new enrollment, not a reconnection.",
    }),
    Object.freeze({
      id: "reach" as const,
      text: "All of that is recorded here, on the Hub. A node that is offline, unreachable, or long gone is revoked in exactly the same way — which is the point of doing it from here.",
    }),
  ]);

export interface HostedNodeRevokeConfirmation {
  readonly title: string;
  readonly consequences: ReadonlyArray<HostedNodeRevokeConsequence>;
  /**
   * The line that sends the reader to the identifier below it, because the label
   * alone cannot settle which machine this is about.
   */
  readonly subjectPrompt: string;
  /**
   * The identifier the dialog renders, carried by the confirmation rather than
   * read off the node a second time in the `.tsx`.
   *
   * It is here so that "two machines named the same way get two different
   * confirmations" is a claim a node test can make. While `subject.id` was
   * accepted and never read, the only thing separating the twins lived in a
   * `.tsx` and a test at this layer could asserts nothing about it — which is
   * how a test named for the twin case came to assert that the two titles are
   * IDENTICAL and compare two string literals to each other.
   *
   * NOT part of the prohibited-phrase scan: it is the caller's own data passing
   * through, not a sentence this module wrote.
   */
  readonly subjectId: string;
  readonly confirmLabel: string;
  readonly pendingLabel: string;
  readonly cancelLabel: string;
  /**
   * What the escape says once retrying is no longer a thing that can happen.
   *
   * NOT the same word as `cancelLabel`. "Cancel" over a dialog whose action has
   * already been refused invites the reading that cancelling undoes something,
   * and after an outcome this surface cannot report there is nothing to undo and
   * nothing left to cancel.
   *
   * NOT "Close" either, and that is not a style preference: the dialog primitive
   * already ships an icon control whose accessible name is exactly `Close`, so a
   * second one puts two differently-shaped buttons under one name in one dialog
   * — the same ambiguity a list of identically named rows creates, in the place
   * where it is least affordable. It names the destination instead, which is
   * where both non-retryable messages already send the reader.
   */
  readonly dismissLabel: string;
}

export const HOSTED_NODE_REVOKE_SUBJECT_PROMPT =
  "Check the identifier below against the machine you meant. Two nodes can carry the same name, " +
  "and this is the only value that tells them apart.";

/**
 * The confirmation, with the node written into its title.
 *
 * The title names the label AND the identifier is rendered beside it, because a
 * confirmation over a list of near-identical rows that does not name its target
 * catches an accidental click and nothing else — it cannot catch a click on the
 * wrong row, which is the failure this list is actually shaped to produce.
 *
 * `confirmLabel` does not repeat the neutral verb: an owner scanning two buttons
 * reads the labels rather than the paragraph above them, so the destructive one
 * has to say what it does on its own.
 */
export function hostedNodeRevokeConfirmation(
  subject: HostedNodeRevokeSubject,
): HostedNodeRevokeConfirmation {
  return {
    title: `Revoke ${subject.label}?`,
    consequences: HOSTED_NODE_REVOKE_CONSEQUENCES,
    subjectPrompt: HOSTED_NODE_REVOKE_SUBJECT_PROMPT,
    subjectId: subject.id,
    confirmLabel: "Revoke this node",
    pendingLabel: "Revoking…",
    cancelLabel: "Cancel",
    dismissLabel: "Back to the list",
  };
}

/** The trigger's own copy, which lives on the detail sheet beside Connect. */
export const HOSTED_NODE_REVOKE_ACTION_LABEL = "Revoke";

/**
 * What the directory says once a revocation has actually landed.
 *
 * THE ROW GOING AWAY IS NOT AN ACKNOWLEDGEMENT, because the row is not
 * guaranteed to go away. The re-read that removes it is
 * `hostedHubController.refreshDirectory()`, whose own failure path settles into
 * `directoryStatus: "stale"` and leaves `nodes` exactly as it found them, then
 * resolves — so a Hub restart or a network blip in the second after an
 * irreversible write leaves the owner looking at an unchanged list with the row
 * still on it and not one word saying the revocation happened. That is
 * indistinguishable from a dismissed dialog.
 *
 * It names the node. "Node revoked" over a list of near-identical rows is the
 * same failure the confirmation's own title exists to avoid.
 */
export function hostedNodeRevokedNotice(label: string): string {
  return `${label} was revoked. It is gone from this Hub's directory for every account, and this cannot be undone.`;
}

/**
 * What a failure says about the node's state on the Hub afterwards.
 *
 * `unchanged` — the Hub refused before it changed anything, so the node is still
 * there and the row must keep standing.
 * `already-gone` — the Hub has no un-revoked node under this id. A second revoke
 * lands here, because the update is conditioned on `revoked_at IS NULL`.
 * `unknown` — the request left this browser and no answer came back that says
 * what became of it. It is NOT reported as a failure to revoke, because it may
 * well have committed.
 */
export type HostedNodeRevokeOutcome = "unchanged" | "already-gone" | "unknown";

export interface HostedNodeRevokeFailure {
  readonly message: string;
  readonly outcome: HostedNodeRevokeOutcome;
}

/**
 * Whether pressing the same button again is a thing that can still work.
 *
 * Only `unchanged` is retryable, and that is not a styling detail. Re-offering
 * the action after `already-gone` invites an owner to keep pressing a control
 * whose every attempt is the same 404; re-offering it after `unknown` invites a
 * second irreversible write against a node that may have taken the first one.
 * Both are cases where the next useful step is to look at the list, and the
 * dialog is what is standing in front of it.
 */
export function hostedNodeRevokeRetryable(failure: HostedNodeRevokeFailure | null): boolean {
  return failure === null || failure.outcome === "unchanged";
}

/**
 * One classified failure, with the input that reaches it.
 *
 * `probe` exists so the scan and the branch cannot drift apart: it is an error
 * shape that must select this branch and nothing else, and it is what
 * `everyHostedNodeRevokeString` feeds back through `hostedNodeRevokeFailure`. A
 * branch added without one does not compile.
 */
interface HostedNodeRevokeFailureBranch {
  readonly id: string;
  readonly probe: unknown;
  readonly selects: (status: number | null, code: string | null) => boolean;
  readonly failure: HostedNodeRevokeFailure;
  /**
   * The same claim worded for the native app, where only the wording that names
   * a browser or a page differs. The outcome is never different: what the Hub
   * did does not depend on which client asked.
   */
  readonly appFailure?: HostedNodeRevokeFailure;
}

/**
 * Which client is asking. The web says "this browser" and "refresh the page";
 * the phone has neither, so its sentences name the device and the screen.
 */
export type HostedNodeRevokeSurface = "browser" | "app";

/**
 * The Hub's answer, as one bounded sentence and one claim about what happened.
 *
 * KEYED ON THE STATUS FIRST. The `code` on a `HostedHubApiError` is narrowed
 * client-side on some routes and arrives verbatim on others, while the status is
 * whatever the Hub actually answered — and the distinction that matters most
 * here (was anything changed?) is a status distinction. The code is consulted
 * only where the status cannot separate two meanings.
 *
 * NO BRANCH CLAIMS MORE THAN IT KNOWS, AND THAT IS DECIDED BY WHETHER THE
 * REQUEST LEFT. `unchanged` is a statement of fact about an irreversible action
 * and is only available to a refusal the Hub itself pronounced, or to a guard
 * that ran before any I/O. Everything after `fetch` was invoked is `unknown`:
 *
 *   * `invalid_response` is thrown after a request the Hub accepted and
 *     answered.
 *   * `timeout` is this client's own 30-second deadline aborting an in-flight
 *     request (`REQUEST_DEADLINE_MS`). The POST was written and the Hub had the
 *     whole window to commit; only the answer was never read.
 *   * `unavailable` is a bare `fetch` rejection, which covers a connection reset
 *     while the response was being read exactly as much as it covers a DNS
 *     failure. The transport cannot tell the two apart, so this module may not.
 *
 * Telling an owner "nothing was changed" there is the specific failure that
 * ends with a revoked machine nobody warned and nobody re-enrolled. All three
 * send the reader to the list and withdraw the retry, rather than offering a
 * second irreversible write against a node that may have taken the first.
 *
 * Nor does any branch promise something this surface does not do. A message
 * saying the directory has been re-read is a claim about behaviour, and it is
 * the kind that rots quietly: nothing here re-reads anything.
 */
/**
 * One frozen branch, annotated.
 *
 * `Object.freeze` around an object literal infers its own type argument and
 * swallows the contextual one, which leaves every `selects` parameter implicitly
 * `any`. Going through a typed identity restores it, so a branch whose predicate
 * misreads its inputs is a compile error rather than a hole.
 */
const branch = (value: HostedNodeRevokeFailureBranch): HostedNodeRevokeFailureBranch =>
  Object.freeze(value);

const HOSTED_NODE_REVOKE_FAILURE_BRANCHES: ReadonlyArray<HostedNodeRevokeFailureBranch> =
  Object.freeze([
    branch({
      id: "invalidResponse",
      probe: Object.freeze({ code: "invalid_response", status: 502 }),
      selects: (_status, code) => code === "invalid_response",
      failure: Object.freeze({
        message:
          "The Hub accepted the request and its answer could not be read, so whether this node was revoked is not known here. Refresh the list and check before trying again.",
        outcome: "unknown" as const,
      }),
    }),
    branch({
      id: "transport",
      probe: Object.freeze({ code: "unavailable", status: 0 }),
      selects: (status, code) => status === 0 || code === "timeout" || code === "unavailable",
      failure: Object.freeze({
        // Deliberately not "nothing was changed": the request had already left
        // this browser, and no answer came back to say what became of it.
        message:
          "The request left this browser and no answer came back, so whether this node was revoked is not known here. Check your connection, then refresh the list and look before trying again.",
        outcome: "unknown" as const,
      }),
      appFailure: Object.freeze({
        message:
          "The request left this device and no answer came back, so whether this node was revoked is not known here. Check your connection, then refresh the list and look before trying again.",
        outcome: "unknown" as const,
      }),
    }),
    branch({
      id: "csrf",
      // Ahead of the 403 branch, and ahead of the session branch it used to be
      // folded into: a stale token in a long-lived tab is not an expired
      // session, and telling an owner to sign in costs them whatever else was
      // unsaved in the app when a refresh was the actual fix. The vocabulary is
      // the one the client already uses for this code.
      probe: Object.freeze({ code: "csrf_rejected", status: 403 }),
      selects: (_status, code) => code === "csrf_rejected",
      failure: Object.freeze({
        message:
          "This request could not be verified, so nothing was changed. Refresh the page and try again.",
        outcome: "unchanged" as const,
      }),
      appFailure: Object.freeze({
        message:
          "This request could not be verified, so nothing was changed. Close this screen and try again.",
        outcome: "unchanged" as const,
      }),
    }),
    branch({
      id: "unauthorized",
      probe: Object.freeze({ code: "session_invalid", status: 401 }),
      selects: (status, code) => status === 401 || code === "session_invalid",
      failure: Object.freeze({
        message:
          "Your Hub session is no longer valid, so nothing was changed. Sign in and try again.",
        outcome: "unchanged" as const,
      }),
    }),
    branch({
      id: "forbidden",
      probe: Object.freeze({ code: "forbidden", status: 403 }),
      selects: (status) => status === 403,
      failure: Object.freeze({
        message: "Only an owner of this Hub can revoke a node. Nothing was changed.",
        outcome: "unchanged" as const,
      }),
    }),
    branch({
      id: "notFound",
      probe: Object.freeze({ code: "not_found", status: 404 }),
      selects: (status) => status === 404,
      failure: Object.freeze({
        message:
          "The Hub has no active node under this identifier: it was already revoked, or it is not this Hub's. Either way there is nothing here left to revoke.",
        outcome: "already-gone" as const,
      }),
    }),
    branch({
      id: "conflict",
      probe: Object.freeze({ code: "conflict", status: 409 }),
      selects: (status) => status === 409,
      failure: Object.freeze({
        message:
          "The Hub reported a conflicting change on this node, so nothing was changed. Refresh and look at it again before retrying.",
        outcome: "unchanged" as const,
      }),
    }),
    branch({
      id: "rateLimited",
      probe: Object.freeze({ code: "node_rate_limited", status: 429 }),
      selects: (status) => status === 429,
      failure: Object.freeze({
        message:
          "The Hub is refusing further owner changes for now, so nothing was changed. Wait a little and try again.",
        outcome: "unchanged" as const,
      }),
    }),
    branch({
      id: "badRequest",
      // `revokeNode` raises this from its own id and reason-code guards BEFORE
      // it calls `fetch`, so `unchanged` here is a fact rather than a guess.
      probe: Object.freeze({ code: "invalid_request", status: 400 }),
      selects: (status, code) => status === 400 || code === "invalid_request",
      failure: Object.freeze({
        message: "The Hub refused this request, so nothing was changed.",
        outcome: "unchanged" as const,
      }),
    }),
  ]);

/**
 * What an error this module does not recognise is reported as.
 *
 * `unchanged` is the safe reading for a shape that never reached the transport
 * at all — a programming error, a rejected guard — which is what an
 * unclassifiable throw from this call path is. Anything the transport itself
 * raises is classified above.
 */
const HOSTED_NODE_REVOKE_FALLBACK_FAILURE: HostedNodeRevokeFailure = Object.freeze({
  message: "This node could not be revoked. Nothing was changed. Try again in a moment.",
  outcome: "unchanged" as const,
});

export function hostedNodeRevokeFailure(
  cause: unknown,
  surface: HostedNodeRevokeSurface = "browser",
): HostedNodeRevokeFailure {
  const status = errorStatus(cause);
  const code = errorCode(cause);
  for (const branch of HOSTED_NODE_REVOKE_FAILURE_BRANCHES) {
    if (!branch.selects(status, code)) continue;
    return surface === "app" ? (branch.appFailure ?? branch.failure) : branch.failure;
  }
  return HOSTED_NODE_REVOKE_FALLBACK_FAILURE;
}

/**
 * The status off a `HostedHubApiError`, or `null` for anything else.
 *
 * Read structurally rather than with `instanceof`: the error crosses a package
 * boundary and the surface must not be one duplicated class identity away from
 * reporting every Hub refusal as the generic fallback.
 */
function errorStatus(cause: unknown): number | null {
  if (typeof cause !== "object" || cause === null) return null;
  const { status } = cause as { status?: unknown };
  return typeof status === "number" && Number.isFinite(status) ? status : null;
}

function errorCode(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null) return null;
  const { code } = cause as { code?: unknown };
  return typeof code === "string" ? code : null;
}

/**
 * Every failure branch, as `(id, probe)` — the table the scan and the tests walk.
 *
 * The probe is fed back through `hostedNodeRevokeFailure`, so a branch that
 * stops being selectable by its own probe is a test failure rather than a silent
 * hole in the scan.
 */
export function everyHostedNodeRevokeFailureProbe(): ReadonlyArray<{
  readonly id: string;
  readonly probe: unknown;
}> {
  return HOSTED_NODE_REVOKE_FAILURE_BRANCHES.map((branch) => ({
    id: branch.id,
    probe: branch.probe,
  }));
}

/**
 * Every owner-facing sentence this module produces, flattened for the scan.
 *
 * IT WALKS THE PRODUCERS, and now it actually does. This used to end in a
 * hand-written array of causes, which enumerated the branches someone remembered
 * — a `status === 423` branch could be added with copy claiming the machine's
 * data was about to be wiped and every guard in the suite stayed green, because
 * none of them ever called it. The list below is derived from
 * `HOSTED_NODE_REVOKE_FAILURE_BRANCHES` itself, so a new branch is covered by
 * the phrase scan, the length bound, and the wire-code check the moment it
 * exists.
 */
export function everyHostedNodeRevokeString(): ReadonlyArray<{
  readonly where: string;
  readonly text: string;
}> {
  const strings: { where: string; text: string }[] = [];
  const push = (where: string, text: string) => {
    strings.push({ where, text });
  };

  const confirmation = hostedNodeRevokeConfirmation({
    id: "node_aaaaaaaaaaaaaaaaaaaaaa",
    label: "Studio",
  });
  push("confirmation.title", confirmation.title);
  push("confirmation.subjectPrompt", confirmation.subjectPrompt);
  push("confirmation.confirmLabel", confirmation.confirmLabel);
  push("confirmation.pendingLabel", confirmation.pendingLabel);
  push("confirmation.cancelLabel", confirmation.cancelLabel);
  push("confirmation.dismissLabel", confirmation.dismissLabel);
  for (const consequence of confirmation.consequences) {
    push(`confirmation.consequence(${consequence.id})`, consequence.text);
  }
  push("actionLabel", HOSTED_NODE_REVOKE_ACTION_LABEL);
  push("revokedNotice", hostedNodeRevokedNotice("Studio"));

  for (const { id, probe } of everyHostedNodeRevokeFailureProbe()) {
    push(`failure(${id})`, hostedNodeRevokeFailure(probe).message);
    push(`appFailure(${id})`, hostedNodeRevokeFailure(probe, "app").message);
  }
  // The one message with no branch of its own, so it cannot be reached by a
  // probe: anything this module does not recognise lands here.
  push("failure(fallback)", hostedNodeRevokeFailure(new Error("boom")).message);
  return strings;
}
