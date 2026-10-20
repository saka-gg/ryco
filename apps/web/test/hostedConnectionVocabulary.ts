import type { EnvironmentId } from "@ryco/contracts";

import {
  deriveHostedConnectionStatusText,
  HOSTED_BROWSER_STATUSES,
  HOSTED_E2EE_CHANNEL_STATUSES,
  HOSTED_RELAY_TRANSPORT_STATUSES,
  HOSTED_RYCO_SESSION_STATUSES,
  HOSTED_SELECTION_STATUSES,
  type HostedConnectionGuarantee,
  type HostedConnectionStatusText,
  type WebHostedConnectionStatusInput,
  type WebHostedE2eeChannelStatus,
} from "../src/hostedHub/connectionStatus";
import {
  beginWebE2eeChannelAttempt,
  lockWebE2eeChannelMode,
  publishWebE2eeVerificationCode,
  resetWebE2eeSession,
} from "../src/hostedHub/e2eeSession";

/**
 * Test-side helpers for sweeping the bounded hosted connection vocabulary.
 *
 * Shared rather than copied per suite so a suite cannot quietly cover a subset:
 * every consumer walks the same cross-product, built from the compile-time
 * exhaustive enumerations `connectionStatus.ts` exports.
 *
 * FIVE INPUTS, AND THE FIFTH IS THE ONE THE SHIPPED APP GAINED LAST. The
 * derivation's fifth input is the §4.4 channel state, and `apps/web` now runs a
 * §4.4 machine on every relay socket (`resolveWebRelayE2eeProvider`) and
 * publishes what it locked (`e2eeSession.ts`), which all three connection
 * surfaces read. While the sweep stopped at four, `Browser encrypted`, `Legacy`,
 * and `Securing` were unreachable in every browser render suite — so a surface
 * that dropped the dimension and rendered a §12.2 plaintext downgrade as a green
 * `Online` was indistinguishable, in these suites, from one that did not.
 *
 * The fence is elsewhere and is unaffected by any of this:
 * `src/hostedHub/connectionStatus.ts` narrows the dimension to the states this
 * tier can be in, and `src/hostedHub/connectionStatus.test.ts` sweeps all four of
 * them purely and asserts the native rows stay unreachable from here.
 */

/**
 * This tier's admissible §4.4 channel states, derived from the runtime's
 * exhaustive enumeration rather than written out.
 *
 * A member added to the shared union is a compile error here until someone
 * decides which tier it belongs to — which is the whole reason
 * `HOSTED_E2EE_CHANNEL_STATUSES` exists rather than a literal array. Native
 * verification, account enrollment, and pairing are excluded: web has neither
 * native key custody nor a durable pin (§6.3, §13.1, §18).
 */
export const WEB_HOSTED_E2EE_CHANNEL_STATUSES = HOSTED_E2EE_CHANNEL_STATUSES.filter(
  (status): status is WebHostedE2eeChannelStatus =>
    status !== "verified" && status !== "account-trusted" && status !== "unverified",
);

/** Every combination of the five bounded inputs. Pure — nothing is rendered. */
export function everyHostedConnectionStatusInput(): ReadonlyArray<WebHostedConnectionStatusInput> {
  const combinations: WebHostedConnectionStatusInput[] = [];
  for (const browserStatus of HOSTED_BROWSER_STATUSES) {
    for (const sessionStatus of HOSTED_RYCO_SESSION_STATUSES) {
      for (const selectionStatus of HOSTED_SELECTION_STATUSES) {
        for (const transportStatus of HOSTED_RELAY_TRANSPORT_STATUSES) {
          for (const e2eeStatus of WEB_HOSTED_E2EE_CHANNEL_STATUSES) {
            combinations.push({
              browserStatus,
              sessionStatus,
              selectionStatus,
              transportStatus,
              e2eeStatus,
            });
          }
        }
      }
    }
  }
  return combinations;
}

/**
 * One representative input per bounded status, chosen to be adversarial.
 *
 * The cross-product is walked purely — no component is mounted per
 * combination — so a browser suite only has to render the handful of distinct
 * results.
 *
 * Representatives PREFER `transportStatus: "online"` wherever a status is
 * reachable with the transport up. Keeping the first hit instead made the
 * sweep structurally blind to the icon defect: the transport enumeration
 * begins at `idle`, so only `Online`/`online` would ever have been rendered
 * with the transport online, and a green connected glyph beside
 * `Delivery unknown` or `Authorization removed` could never have been observed.
 */
export function hostedConnectionStatusRepresentatives(): ReadonlyMap<
  HostedConnectionStatusText,
  WebHostedConnectionStatusInput
> {
  const representatives = new Map<HostedConnectionStatusText, WebHostedConnectionStatusInput>();
  for (const input of everyHostedConnectionStatusInput()) {
    const text = deriveHostedConnectionStatusText(input);
    const held = representatives.get(text);
    if (held && (held.transportStatus === "online" || input.transportStatus !== "online")) continue;
    representatives.set(text, input);
  }
  return representatives;
}

/**
 * Put the REAL §13 projection into one channel state, for a render sweep.
 *
 * Through the module's own publishers and never by writing its state: the
 * surfaces read `webE2eeSessionState()`, so a helper that set the field directly
 * would render a state the §4.4 machine's own transitions cannot produce. The
 * sequence here is the one `resolveWebRelayE2eeProvider` drives — a channel
 * begins, and then it locks once.
 *
 * Without an environment the whole projection is reset and the displayed entry
 * is driven; with one, only that environment's own entry, as its channel would.
 */
export function applyWebE2eeChannelStatus(
  status: WebHostedE2eeChannelStatus,
  environmentId?: EnvironmentId,
): void {
  resetWebE2eeSession(environmentId);
  if (status === "unavailable") return;
  beginWebE2eeChannelAttempt(environmentId);
  if (status === "negotiating") return;
  lockWebE2eeChannelMode(status === "web-unsigned" ? "e2ee" : "legacy", environmentId);
}

/**
 * Put the REAL §13 projection into a locked `e2ee` channel holding one §13.5
 * code, for a render sweep.
 *
 * The publish order is the §4.4 machine's, and it is the order that matters:
 * `publishWebE2eeVerificationCode` runs from INSIDE the mode lock, so the
 * projection is still `negotiating` at that instant and only the caller's
 * post-operation sync moves it to `web-unsigned`. A helper that locked first
 * would drive a sequence the shipped machine never produces, and a surface
 * gating on the lock would pass here while failing in the app.
 *
 * The environment is addressed as in {@link applyWebE2eeChannelStatus}.
 */
export function applyWebE2eeVerificationCode(code: string, environmentId?: EnvironmentId): void {
  resetWebE2eeSession(environmentId);
  beginWebE2eeChannelAttempt(environmentId);
  publishWebE2eeVerificationCode(code, environmentId);
  lockWebE2eeChannelMode("e2ee", environmentId);
}

/**
 * The unconditional sentence `HostedRelayTrustNotice` shipped before the claim
 * became a function of the channel state.
 *
 * Kept HERE rather than in the component, because it must not be reachable from
 * the app: it asserts the opposite of what a locked NX channel makes true, and
 * `docs/relay-e2ee-protocol.md` §2.2 forbids a surface presenting either tier's
 * claim for the other's configuration. The browser suites that used to pin it as
 * the expected copy now assert it is nowhere on the page.
 */
export const RETIRED_HOSTED_RELAY_TRUST_SENTENCE =
  "Hosted connections use WSS transport security, but they are not application-level end-to-end encrypted. The trusted relay can observe forwarded bytes in memory and must not log or persist payloads.";

/**
 * "Connected" restated from the raw inputs in the derivation's gate order —
 * browser lifecycle, then session, then selection, and only then transport.
 *
 * Deliberately independent of `HOSTED_CONNECTION_STATUS_INDICATORS`: it is the
 * second opinion the indicator's glyph is checked against, and it is what
 * fails when the glyph is chosen from `transportStatus` alone.
 */
export function hostedConnectionConnectedByGateOrder(
  value: WebHostedConnectionStatusInput,
): boolean {
  if (value.browserStatus !== "current") return false;
  if (value.sessionStatus === "delivery-unknown") return false;
  if (value.selectionStatus === "authorization-removed") return false;
  if (value.selectionStatus === "revoked") return false;
  if (value.selectionStatus === "incompatible") return false;
  if (value.transportStatus !== "online" || value.sessionStatus !== "ready") return false;
  // §4.4's channel state, restated from the input. A `negotiating` channel has
  // released nothing, so it is not a session the owner can use. `legacy` is
  // usable and says so (§12.2), and so is `web-unsigned` — §13.1's release gate
  // is native-only by construction, so a web NX channel releases payload exactly
  // as a locked native one does.
  return (value.e2eeStatus ?? "unavailable") !== "negotiating";
}

/**
 * The §2.2 claim the state is entitled to, restated from the raw inputs.
 *
 * The second opinion for `HostedConnectionStatusIndicator.guarantee`. On this
 * tier `e2ee` is unreachable by construction — the fence removes `verified`
 * before the derivation ever sees it — so the interesting rows are §12.2's
 * mandatory `legacy` label and §2.2's `web` row, which is WEAKER than `e2ee`
 * rather than a flavour of it: the Hub serves the code that draws it (§2.4).
 */
export function hostedConnectionGuaranteeByGateOrder(
  value: WebHostedConnectionStatusInput,
): HostedConnectionGuarantee {
  if (!hostedConnectionConnectedByGateOrder(value)) return "none";
  if (value.e2eeStatus === "web-unsigned") return "web";
  if (value.e2eeStatus === "legacy") return "legacy";
  return "none";
}
