/**
 * Per-row presentation of the async durable trust result.
 *
 * PURE MODULE. It imports no react and no platform adapter so it can be tested;
 * `useHomeEnvironments.ts` is the only binding that touches the store.
 *
 * DISPLAY ONLY. Eligibility is resolved before this module by the durable async
 * classifier. This module merely narrows that authoritative result to the two
 * labels supported by existing inbox presentation.
 */

/**
 * The mandatory §13.1 label, reused verbatim from client-runtime's
 * `HOSTED_CONNECTION_STATUS_INDICATORS` (the `"Not verified"` key). §12.2
 * requires one vocabulary for the claim across every user-facing surface, so
 * this wave introduces no second phrasing for the same condition — the inbox row
 * says exactly what the hosted connection pill says. `nodeTrustModel.test.ts`
 * pins the string against drift in either direction.
 */
export const NODE_TRUST_UNVERIFIED_LABEL = "Not verified";
export const NODE_TRUST_ACCOUNT_LABEL = "Encrypted · Account trusted";

export type NodeTrust = "verified" | "account-trusted" | "unverified";

/**
 * The per-environment trust marker for a roster of Hub nodes.
 *
 * Returns `null` — no claims at all, not a list of "unverified" — when the
 * device marker is `unobtainable`. §4.4 forbids treating unobtainable evidence
 * as an unset marker, and the marker is exactly the guard that rule protects: a
 * direct-only build never hydrates the trust store, so every read is
 * unobtainable, and rendering that as "Not verified" on every row would be a
 * fabricated security claim about nodes this device has no evidence about.
 *
 * A node is `"verified"` only when EXACTLY ONE verified record hints at its
 * node id, mirroring `resolveE2eeTrustRecord`'s ambiguity rule: two records
 * carrying the same Hub-minted id is a state only the Hub can produce, and
 * picking either would let it choose which claim renders. Ambiguity refuses.
 *
 * The false negative is the safe direction and it is reachable: a Hub-inducible
 * re-enrolment mints a new node id, which unmatches a hint on a pin that is
 * still genuinely the owner's. That row then reads "Not verified" until the
 * next authenticated statement re-associates it — an under-claim, which is the
 * only error this surface is allowed to make.
 */
export function deriveNodeTrustByEnvironment(input: {
  readonly authoritativeTrustByEnvironmentId: ReadonlyMap<
    string,
    "not-required" | "unknown" | "unverified" | "account-trusted" | "verified" | "identity-conflict"
  >;
}): ReadonlyMap<string, NodeTrust> {
  const trustByEnvironmentId = new Map<string, NodeTrust>();
  for (const [environmentId, trust] of input.authoritativeTrustByEnvironmentId) {
    trustByEnvironmentId.set(
      environmentId,
      trust === "verified"
        ? "verified"
        : trust === "account-trusted"
          ? "account-trusted"
          : "unverified",
    );
  }
  return trustByEnvironmentId;
}
