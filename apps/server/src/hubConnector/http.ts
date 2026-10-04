import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { E2EE_SUITE_REGISTRY_MAX_ENTRIES } from "@ryco/shared/relayE2eeConstants";
import { NodeE2eeAdmissionPolicy } from "@ryco/contracts/native-e2ee";

import { AuthError, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { rejectCrossOriginMutation, respondToAuthError } from "../auth/http.ts";
import { HubConnectorService } from "./HubConnectorLive.ts";

const authenticateOwner = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request);
  if (session.role !== "owner") {
    return yield* new AuthError({
      message: "Only owner sessions can manage Hub connectivity.",
      status: 403,
    });
  }
});

const enrollmentFailure = () =>
  new AuthError({
    message: "Hub enrollment operation failed.",
    status: 400,
  });

const leaveFailure = () =>
  new AuthError({
    message: "Hub identity erasure failed.",
    status: 400,
  });

const resumeFailure = () =>
  new AuthError({
    message: "Hub connector resume failed.",
    status: 400,
  });

export const hubConnectorStatusRouteLayer = HttpRouter.add(
  "GET",
  "/api/hub/status",
  Effect.gen(function* () {
    yield* authenticateOwner;
    const connector = yield* HubConnectorService;
    return HttpServerResponse.jsonUnsafe(connector.status(), { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const hubConnectorEnrollmentRouteLayer = HttpRouter.add(
  "POST",
  "/api/hub/enrollment",
  Effect.gen(function* () {
    yield* authenticateOwner;
    yield* rejectCrossOriginMutation;
    const connector = yield* HubConnectorService;
    const result = yield* Effect.tryPromise({
      try: () => connector.enroll(),
      catch: enrollmentFailure,
    });
    return HttpServerResponse.jsonUnsafe(result, { status: 201 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/**
 * Report whether this node holds a Hub identity.
 *
 * Separate from status because `disabled` is reported both for a never-enrolled
 * node and for an enrolled node whose connector is off. The panel gates the
 * origin field and every destructive action on this, so conflating the two would
 * let it offer to re-point a node that is already enrolled.
 */
export const hubConnectorIdentityRouteLayer = HttpRouter.add(
  "GET",
  "/api/hub/identity",
  Effect.gen(function* () {
    yield* authenticateOwner;
    const connector = yield* HubConnectorService;
    const summary = yield* Effect.promise(() => connector.identitySummary());
    return HttpServerResponse.jsonUnsafe(summary, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/**
 * Re-read a pending enrollment ceremony.
 *
 * The device code, fingerprint, and expiry are otherwise only in the enrollment
 * start response, so losing that output — a scrolled terminal, a closed panel, a
 * restart — strands a live ceremony with no way to finish it and no way back in
 * except cancelling, which destroys key custody.
 *
 * 404 means nothing is pending, or a ceremony predates device-code persistence
 * and therefore cannot be displayed.
 */
export const hubConnectorEnrollmentReadRouteLayer = HttpRouter.add(
  "GET",
  "/api/hub/enrollment",
  Effect.gen(function* () {
    yield* authenticateOwner;
    const connector = yield* HubConnectorService;
    const enrollment = yield* Effect.tryPromise({
      try: () => connector.readEnrollment(),
      catch: enrollmentFailure,
    });
    if (enrollment === null) {
      return HttpServerResponse.jsonUnsafe(
        { message: "No Hub enrollment is pending." },
        { status: 404 },
      );
    }
    return HttpServerResponse.jsonUnsafe(enrollment, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/**
 * Retry now rather than on the connector's own schedule.
 *
 * A locked credential store, a duplicate process, and a refused proof all
 * retry on their own, but slowly — and a duplicate stops once its hourly budget
 * is spent. An owner who has just unlocked the store or stopped the other copy
 * should not have to wait that out, or restart the process, which in the
 * desktop tears down every provider session and terminal to retry one outbound
 * socket.
 *
 * `resume()` is deliberately a no-op for `revoked`, a stopping connector, a
 * disabled one, and a connection already up or on its way up. Returning the
 * resulting status rather than an error keeps those cases honest: the caller
 * sees the unchanged state instead of a success that implies something
 * happened.
 */
export const hubConnectorResumeRouteLayer = HttpRouter.add(
  "POST",
  "/api/hub/resume",
  Effect.gen(function* () {
    yield* authenticateOwner;
    yield* rejectCrossOriginMutation;
    const connector = yield* HubConnectorService;
    yield* Effect.tryPromise({
      try: () => connector.resume(),
      catch: resumeFailure,
    });
    return HttpServerResponse.jsonUnsafe(connector.status(), { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const hubConnectorEnrollmentCancelRouteLayer = HttpRouter.add(
  "POST",
  "/api/hub/enrollment/cancel",
  Effect.gen(function* () {
    yield* authenticateOwner;
    yield* rejectCrossOriginMutation;
    const connector = yield* HubConnectorService;
    const status = yield* Effect.tryPromise({
      try: () => connector.cancelEnrollment(),
      catch: enrollmentFailure,
    });
    return HttpServerResponse.jsonUnsafe(status, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/**
 * Erase this node's local Hub identity.
 *
 * The only exit from `revoked` and from a corrupt identity. Destructive and
 * deliberately distinct from turning the connector off, which is reversible and
 * keeps the key.
 *
 * It does not revoke anything at the Hub: the node record survives there until
 * an owner removes it. The node rejoins as a new node.
 */
export const hubConnectorLeaveRouteLayer = HttpRouter.add(
  "POST",
  "/api/hub/leave",
  Effect.gen(function* () {
    yield* authenticateOwner;
    yield* rejectCrossOriginMutation;
    const connector = yield* HubConnectorService;
    const status = yield* Effect.tryPromise({
      try: () => connector.leave(),
      catch: leaveFailure,
    });
    return HttpServerResponse.jsonUnsafe(status, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

// ─── the E2EE operator surface (§6.4, §7.5, §12.5, §12.6, §13.4–§13.6) ───────
//
// Every route below carries the same envelope the rest of this file does: an
// owner session, a cross-origin refusal on every mutation, and a bounded failure
// message that echoes nothing from the underlying error. That last part matters
// more here than anywhere else in this file, because the underlying errors are
// raised while looking at Branch A records: a message that echoed one would turn
// an operator route into a disclosure of which client keys this node has on
// file.
//
// The mutations are grouped by resource rather than split one-per-verb because
// they share a request shape — a record key, or a policy proposal — and a route
// per verb would multiply the auth envelope without adding a boundary.

/**
 * The single bounded failure for every E2EE operator route.
 *
 * ONE MESSAGE FOR EVERY CAUSE, deliberately. The causes include "no record under
 * this key", "this record is not approved", "the approved cap is full", and "the
 * sweep could not finish", and only the last is a condition the operator can act
 * on differently — but distinguishing them here would make the route answer
 * questions about the record set that the owner's own listing already answers
 * without inference. The CLI prints this message and the operator reads the
 * listing.
 */
const e2eeOperationFailure = () =>
  new AuthError({
    message: "Hub E2EE operation failed.",
    status: 400,
  });

const E2eeClientKeyBody = Schema.Struct({
  hubOrigin: Schema.String,
  accountId: Schema.String,
  fingerprint: Schema.String,
});

const E2eeClientAuthorizationBody = Schema.Struct({
  action: Schema.Literals(["approve", "narrow", "revoke", "purge"]),
  hubOrigin: Schema.String,
  accountId: Schema.String,
  fingerprint: Schema.String,
  maxRole: Schema.optional(Schema.String),
  capabilitySet: Schema.optional(Schema.Array(Schema.String)),
  displayLabel: Schema.optional(Schema.String),
});

const E2eePairingWindowBody = Schema.Struct({
  action: Schema.Literals(["open", "close"]),
  fingerprint: Schema.optional(Schema.String),
});

/**
 * §12.6's proposal, including the suite registry.
 *
 * The registry is bounded here rather than trusted: it reaches a durable record
 * and §7.6 element 9 caps it, so an unbounded list would be a body that could
 * grow the advertised statement past what §5.5 can carry.
 */
const E2eePolicyBody = Schema.Struct({
  mode: Schema.optional(NodeE2eeAdmissionPolicy),
  requireE2EE: Schema.optional(Schema.Boolean),
  requireApprovedClientE2EE: Schema.optional(Schema.Boolean),
  suiteRegistry: Schema.optional(
    Schema.Array(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).check(
      Schema.isMaxLength(E2EE_SUITE_REGISTRY_MAX_ENTRIES),
    ),
  ),
});

const E2eeContinuityBody = Schema.Struct({
  action: Schema.Literals(["adopt", "remint", "break"]),
  continuityId: Schema.optional(Schema.String),
});

/**
 * A malformed body is an operator mistake and is answered as one.
 *
 * The decode failure itself is discarded rather than surfaced: a schema issue
 * names the field it rejected, and these bodies carry record keys.
 */
const decodeBody = <A, I, RD>(schema: Schema.Codec<A, I, RD>) =>
  HttpServerRequest.schemaBodyJson(schema).pipe(
    Effect.catch(() => Effect.fail(e2eeOperationFailure())),
  );

export const hubConnectorE2eeClientsRouteLayer = HttpRouter.add(
  "GET",
  "/api/hub/e2ee/clients",
  Effect.gen(function* () {
    yield* authenticateOwner;
    const connector = yield* HubConnectorService;
    const listing = yield* Effect.tryPromise({
      try: () => connector.e2ee.listClients(),
      catch: e2eeOperationFailure,
    });
    return HttpServerResponse.jsonUnsafe(listing, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/**
 * §13.4's display surface: the safety number for one named record.
 *
 * A POST with the key in the body rather than a GET with it in the path,
 * because the key's third element is a `SHA256:`-prefixed fingerprint and the
 * account id is client-chosen text — neither belongs in a URL an access log or a
 * shell history keeps. It mutates nothing and takes the cross-origin refusal
 * anyway, for the same reason.
 */
export const hubConnectorE2eeClientReadRouteLayer = HttpRouter.add(
  "POST",
  "/api/hub/e2ee/clients/read",
  Effect.gen(function* () {
    yield* authenticateOwner;
    yield* rejectCrossOriginMutation;
    const body = yield* decodeBody(E2eeClientKeyBody);
    const connector = yield* HubConnectorService;
    const record = yield* Effect.tryPromise({
      try: () => connector.e2ee.getClient(body),
      catch: e2eeOperationFailure,
    });
    if (record === undefined) {
      return HttpServerResponse.jsonUnsafe(
        { message: "No client authorization record was found." },
        { status: 404 },
      );
    }
    return HttpServerResponse.jsonUnsafe(record, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/**
 * Create a short-lived node-signed QR for one already approved client.
 *
 * It mutates no authorization state, but uses POST so the record key never
 * enters a URL or access log. The cross-origin refusal also makes a local web
 * page unable to turn the node identity key into a signing oracle.
 */
export const hubConnectorE2eeClientApprovalQrRouteLayer = HttpRouter.add(
  "POST",
  "/api/hub/e2ee/clients/approval-qr",
  Effect.gen(function* () {
    yield* authenticateOwner;
    yield* rejectCrossOriginMutation;
    const body = yield* decodeBody(E2eeClientKeyBody);
    const connector = yield* HubConnectorService;
    const result = yield* Effect.tryPromise({
      try: () => connector.e2ee.createClientApprovalQr(body),
      catch: e2eeOperationFailure,
    });
    return HttpServerResponse.jsonUnsafe(result, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/**
 * §13.6's four owner commands.
 *
 * The response is produced only after the client's ordered procedure has
 * completed — commit, then sweep — because the client's promise does not settle
 * before then and this route awaits it. A sweep that could not finish rejects,
 * so the operator never reads a success for a withdrawal that left a channel
 * open under the old authority.
 */
export const hubConnectorE2eeAuthorizationRouteLayer = HttpRouter.add(
  "POST",
  "/api/hub/e2ee/clients/authorization",
  Effect.gen(function* () {
    yield* authenticateOwner;
    yield* rejectCrossOriginMutation;
    const body = yield* decodeBody(E2eeClientAuthorizationBody);
    const connector = yield* HubConnectorService;
    const key = {
      hubOrigin: body.hubOrigin,
      accountId: body.accountId,
      fingerprint: body.fingerprint,
    };
    const result = yield* Effect.tryPromise({
      try: () => {
        switch (body.action) {
          case "approve":
            return connector.e2ee.approveClient({
              ...key,
              maxRole: body.maxRole ?? "",
              capabilitySet: body.capabilitySet ?? [],
              ...(body.displayLabel === undefined ? {} : { displayLabel: body.displayLabel }),
            });
          case "narrow":
            return connector.e2ee.narrowClient({
              ...key,
              ...(body.maxRole === undefined ? {} : { maxRole: body.maxRole }),
              ...(body.capabilitySet === undefined ? {} : { capabilitySet: body.capabilitySet }),
            });
          case "revoke":
            return connector.e2ee.revokeClient(key);
          case "purge":
            return connector.e2ee.purgeClient(key);
        }
      },
      catch: e2eeOperationFailure,
    });
    return HttpServerResponse.jsonUnsafe(result, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const hubConnectorE2eePairingWindowRouteLayer = HttpRouter.add(
  "POST",
  "/api/hub/e2ee/clients/pairing-window",
  Effect.gen(function* () {
    yield* authenticateOwner;
    yield* rejectCrossOriginMutation;
    const body = yield* decodeBody(E2eePairingWindowBody);
    const connector = yield* HubConnectorService;
    const listing = yield* Effect.tryPromise({
      try: () =>
        body.action === "open"
          ? // §13.6: the discriminator is REQUIRED, and an absent one is refused
            // here rather than defaulted to anything. There is no undiscriminated
            // window.
            connector.e2ee.openPairingWindow(body.fingerprint ?? "")
          : connector.e2ee.closePairingWindow(),
      catch: e2eeOperationFailure,
    });
    return HttpServerResponse.jsonUnsafe(listing, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/**
 * §13.6: the owner action that clears the pairing-attempt refusal count.
 *
 * §13.6 makes the count "bounded, owner-clearable", and a count with no clearing
 * command is a number that only ever grows — which is the same as no
 * instrumentation once a flood has run. Its own route rather than a pairing
 * window action, because it touches no window and closing one is not what an
 * owner means when they clear a counter.
 */
export const hubConnectorE2eeRefusalsRouteLayer = HttpRouter.add(
  "POST",
  "/api/hub/e2ee/clients/refusals/clear",
  Effect.gen(function* () {
    yield* authenticateOwner;
    yield* rejectCrossOriginMutation;
    const connector = yield* HubConnectorService;
    const listing = yield* Effect.tryPromise({
      try: () => connector.e2ee.clearRefusedPairingAttempts(),
      catch: e2eeOperationFailure,
    });
    return HttpServerResponse.jsonUnsafe(listing, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/** §13.5: the node's half of the per-session comparison, for sessions open now. */
export const hubConnectorE2eeSessionsRouteLayer = HttpRouter.add(
  "GET",
  "/api/hub/e2ee/sessions",
  Effect.gen(function* () {
    yield* authenticateOwner;
    const connector = yield* HubConnectorService;
    return HttpServerResponse.jsonUnsafe(connector.e2ee.listSessions(), { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const hubConnectorE2eePolicyReadRouteLayer = HttpRouter.add(
  "GET",
  "/api/hub/e2ee/policy",
  Effect.gen(function* () {
    yield* authenticateOwner;
    const connector = yield* HubConnectorService;
    return HttpServerResponse.jsonUnsafe(connector.e2ee.readPolicy(), { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/**
 * §12.6's display duty needs the counts BEFORE the change runs, so the preview
 * is its own route rather than a flag on the change.
 *
 * A flag would make one request able to warn or to sweep depending on a boolean,
 * which is the shape most likely to sweep when an operator meant to look.
 */
export const hubConnectorE2eePolicyPreviewRouteLayer = HttpRouter.add(
  "POST",
  "/api/hub/e2ee/policy/preview",
  Effect.gen(function* () {
    yield* authenticateOwner;
    yield* rejectCrossOriginMutation;
    const body = yield* decodeBody(E2eePolicyBody);
    const connector = yield* HubConnectorService;
    return HttpServerResponse.jsonUnsafe(connector.e2ee.previewPolicy(body), { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/** §12.6 in full. Returns only after (a) and (b), and reports the (c) counts. */
export const hubConnectorE2eePolicyApplyRouteLayer = HttpRouter.add(
  "POST",
  "/api/hub/e2ee/policy",
  Effect.gen(function* () {
    yield* authenticateOwner;
    yield* rejectCrossOriginMutation;
    const body = yield* decodeBody(E2eePolicyBody);
    const connector = yield* HubConnectorService;
    const result = yield* Effect.tryPromise({
      try: () => connector.e2ee.applyPolicy(body),
      catch: e2eeOperationFailure,
    });
    return HttpServerResponse.jsonUnsafe(result, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/**
 * §5.7's recovery command.
 *
 * A route of its own, and a POST with no body: it takes no proposal, because the
 * only thing it changes is the generation. Routing it through the policy route
 * would make one body able to recover or to reconfigure depending on a field,
 * and §5.7 requires the jump to be deliberate.
 */
export const hubConnectorE2eePolicyRecoverRouteLayer = HttpRouter.add(
  "POST",
  "/api/hub/e2ee/policy/recover",
  Effect.gen(function* () {
    yield* authenticateOwner;
    yield* rejectCrossOriginMutation;
    const connector = yield* HubConnectorService;
    const result = yield* Effect.tryPromise({
      try: () => connector.e2ee.recoverPolicyGeneration(),
      catch: e2eeOperationFailure,
    });
    return HttpServerResponse.jsonUnsafe(result, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/** §6.4: the prekey this node holds, read without issuing one. */
export const hubConnectorE2eePrekeyReadRouteLayer = HttpRouter.add(
  "GET",
  "/api/hub/e2ee/prekey",
  Effect.gen(function* () {
    yield* authenticateOwner;
    const connector = yield* HubConnectorService;
    const certificate = yield* Effect.tryPromise({
      try: () => connector.e2ee.readPrekey(),
      catch: e2eeOperationFailure,
    });
    return HttpServerResponse.jsonUnsafe(certificate, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/** §6.4's forced rotation: a new keypair and a new certificate, immediately. */
export const hubConnectorE2eePrekeyRotateRouteLayer = HttpRouter.add(
  "POST",
  "/api/hub/e2ee/prekey/rotate",
  Effect.gen(function* () {
    yield* authenticateOwner;
    yield* rejectCrossOriginMutation;
    const connector = yield* HubConnectorService;
    const certificate = yield* Effect.tryPromise({
      try: () => connector.e2ee.rotatePrekey(),
      catch: e2eeOperationFailure,
    });
    return HttpServerResponse.jsonUnsafe(certificate, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const hubConnectorE2eeContinuityReadRouteLayer = HttpRouter.add(
  "GET",
  "/api/hub/e2ee/continuity",
  Effect.gen(function* () {
    yield* authenticateOwner;
    const connector = yield* HubConnectorService;
    const status = yield* Effect.tryPromise({
      try: () => connector.e2ee.readContinuity(),
      catch: e2eeOperationFailure,
    });
    return HttpServerResponse.jsonUnsafe(status, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/**
 * §7.5's recovery, with the two outcomes the operator must choose between, and
 * the separate deliberate chain break.
 *
 * All three are one route because they are one decision an operator makes about
 * one lineage; the discriminator is required and there is no default, so no
 * request can reach a mint without having named it.
 */
export const hubConnectorE2eeContinuityRouteLayer = HttpRouter.add(
  "POST",
  "/api/hub/e2ee/continuity",
  Effect.gen(function* () {
    yield* authenticateOwner;
    yield* rejectCrossOriginMutation;
    const body = yield* decodeBody(E2eeContinuityBody);
    const connector = yield* HubConnectorService;
    const result = yield* Effect.tryPromise({
      try: () => {
        switch (body.action) {
          case "adopt":
            return connector.e2ee.adoptContinuityId(body.continuityId ?? "");
          case "remint":
            return connector.e2ee.remintContinuityId();
          case "break":
            return connector.e2ee.breakContinuityChain();
        }
      },
      catch: e2eeOperationFailure,
    });
    return HttpServerResponse.jsonUnsafe(result, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const hubConnectorE2eeFallbackReadRouteLayer = HttpRouter.add(
  "GET",
  "/api/hub/e2ee/fallback",
  Effect.gen(function* () {
    yield* authenticateOwner;
    const connector = yield* HubConnectorService;
    return HttpServerResponse.jsonUnsafe(connector.e2ee.readFallback(), { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/** §12.5's only reset authority. No automatic path reaches this. */
export const hubConnectorE2eeFallbackResetRouteLayer = HttpRouter.add(
  "POST",
  "/api/hub/e2ee/fallback/reset",
  Effect.gen(function* () {
    yield* authenticateOwner;
    yield* rejectCrossOriginMutation;
    const connector = yield* HubConnectorService;
    const state = yield* Effect.tryPromise({
      try: () => connector.e2ee.resetFallback(),
      catch: e2eeOperationFailure,
    });
    return HttpServerResponse.jsonUnsafe(state, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const hubConnectorRoutesLayer = Layer.mergeAll(
  hubConnectorStatusRouteLayer,
  hubConnectorEnrollmentRouteLayer,
  hubConnectorEnrollmentCancelRouteLayer,
  hubConnectorResumeRouteLayer,
  hubConnectorEnrollmentReadRouteLayer,
  hubConnectorIdentityRouteLayer,
  hubConnectorLeaveRouteLayer,
  hubConnectorE2eeClientsRouteLayer,
  hubConnectorE2eeClientReadRouteLayer,
  hubConnectorE2eeClientApprovalQrRouteLayer,
  hubConnectorE2eeAuthorizationRouteLayer,
  hubConnectorE2eePairingWindowRouteLayer,
  hubConnectorE2eeRefusalsRouteLayer,
  hubConnectorE2eeSessionsRouteLayer,
  hubConnectorE2eePolicyReadRouteLayer,
  hubConnectorE2eePolicyPreviewRouteLayer,
  hubConnectorE2eePolicyApplyRouteLayer,
  hubConnectorE2eePolicyRecoverRouteLayer,
  hubConnectorE2eePrekeyReadRouteLayer,
  hubConnectorE2eePrekeyRotateRouteLayer,
  hubConnectorE2eeContinuityReadRouteLayer,
  hubConnectorE2eeContinuityRouteLayer,
  hubConnectorE2eeFallbackReadRouteLayer,
  hubConnectorE2eeFallbackResetRouteLayer,
);
