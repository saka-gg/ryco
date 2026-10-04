import type {
  HubConnectorStatus,
  HubConnectorFailureCode,
  HubIdentitySummary,
} from "@ryco/contracts";

/**
 * What the Hub row offers the operator.
 *
 * `none` is not "nothing is wrong" — it is "there is nothing useful for a person
 * to press", which is true while the connector is working and true while it is
 * backing off from a network failure on its own. A slow retry of a failure a
 * person can clear sooner — a locked keychain, a duplicate process — still
 * offers Retry.
 */
export type HubAction =
  | "none"
  | "enable"
  | "disable"
  | "enroll"
  | "cancel-enrollment"
  | "open-hub"
  | "retry"
  | "leave"
  | "restart";

export type HubDot = "success" | "warning" | "destructive" | "idle";

export interface HubPresentation {
  readonly dot: HubDot;
  /** Whether the dot pulses. Reserved for states that are actively moving. */
  readonly ping: boolean;
  readonly headline: string;
  readonly detail: string | null;
  readonly action: HubAction;
  /** A second, lower-emphasis action. */
  readonly secondaryAction: HubAction;
  /** True when the connector will retry on its own and the operator need not act. */
  readonly retrying: boolean;
}

/**
 * Copy for every operator-action failure.
 *
 * Keyed on the full failure code rather than on `degradedMode` alone, because
 * the seven codes that reach `operator_action_required` do not share a remedy —
 * offering "Enroll" for an origin mismatch throws, and offering "Retry" for a
 * dead credential store does nothing.
 *
 * `satisfies` makes this exhaustive: adding a failure code fails the typecheck
 * until copy exists for it, so a new code can never reach the panel as a blank.
 */
const OPERATOR_FAILURES = {
  configuration_invalid: {
    headline: "Hub configuration is invalid",
    detail: "The address this backend started with was rejected. Check it and restart.",
    action: "none",
  },
  identity_unavailable: {
    headline: "Can't read this machine's Hub key",
    detail: "The system keychain is locked or unavailable. Unlock it, then try again.",
    action: "retry",
  },
  // A restart alone repeats the failure when the host has no credential store
  // at all, which is the common headless-Linux cause, so name the fixes first.
  identity_store_unavailable: {
    headline: "Can't open a key store for this machine's Hub key",
    detail:
      "No system credential store answered when Ryco started. Unlock or start it (on Linux, a Secret Service such as GNOME Keyring), or allow the permissioned-file fallback in advanced options, then restart Ryco.",
    action: "restart",
  },
  identity_origin_mismatch: {
    headline: "Enrolled with a different Hub",
    detail: "This machine's key belongs to another Hub. Leave that Hub to enrol here.",
    action: "leave",
  },
  enrollment_unavailable: {
    headline: "Enrollment was denied",
    detail: "Someone declined this request on the Hub. Check with them before trying again.",
    action: "enroll",
  },
  enrollment_expired: {
    headline: "Enrollment expired",
    detail: "The request timed out before it was approved.",
    action: "enroll",
  },
  // Retry first: the same refusal follows a Hub-side incident that clears, and
  // a proxy error once landed here too. Leave stays available as the
  // secondary action for a node that really was removed.
  authentication_failed: {
    headline: "The Hub rejected this machine's key",
    detail: "Check this node's status on the Hub. If it was removed there, leave and enrol again.",
    action: "retry",
  },
  connection_replaced: {
    headline: "Another process connected as this machine",
    detail: "Two copies of Ryco can't share one Hub identity. Stop the other one, then retry.",
    action: "retry",
  },
  protocol_invalid: {
    headline: "The Hub connection kept failing",
    detail: "Ryco stopped retrying after repeated protocol errors. Update Ryco and the Hub.",
    action: "retry",
  },
  // Reached only via `backing_off`, never as an operator action — present so the
  // table stays exhaustive over the failure enum.
  network_unavailable: { headline: "Can't reach the Hub", detail: null, action: "none" },
  tls_unavailable: { headline: "Can't reach the Hub securely", detail: null, action: "none" },
  authentication_timeout: { headline: "The Hub didn't respond", detail: null, action: "none" },
  server_draining: { headline: "The Hub is restarting", detail: null, action: "none" },
  rate_limited: { headline: "The Hub is rate limiting", detail: null, action: "none" },
  heartbeat_timeout: { headline: "The Hub stopped responding", detail: null, action: "none" },
  slow_consumer: { headline: "The connection fell behind", detail: null, action: "none" },
  internal_error: { headline: "The Hub connection failed", detail: null, action: "none" },
} satisfies Record<
  HubConnectorFailureCode,
  { readonly headline: string; readonly detail: string | null; readonly action: HubAction }
>;

/**
 * Failures the connector retries on its own slow schedule that a person may
 * still be able to clear sooner.
 *
 * Reported as `backing_off` with the specific code, so the row can say both
 * what went wrong and that nobody has to act. Showing them as a generic
 * "Reconnecting" would hide a duplicate process or a removed node for an hour;
 * showing them as failures needing action would send people to Leave over a
 * locked keychain.
 */
const SELF_HEALING_FAILURES: Partial<
  Record<
    HubConnectorFailureCode,
    { readonly hint: string; readonly secondaryAction: Exclude<HubAction, "retry"> }
  >
> = {
  identity_unavailable: {
    hint: "Unlock the system keychain to reconnect sooner.",
    secondaryAction: "none",
  },
  connection_replaced: {
    hint: "Another copy of Ryco is using this machine's Hub identity. Stop it to connect here.",
    secondaryAction: "none",
  },
  authentication_failed: {
    hint: "If this machine was removed on the Hub, leave and enrol again.",
    secondaryAction: "leave",
  },
};

const formatCountdown = (target: string, now: number): string | null => {
  const remainingMs = new Date(target).getTime() - now;
  if (Number.isNaN(remainingMs)) return null;
  // A past retry time means the attempt is due; saying "in -3s" is worse than
  // saying nothing precise.
  if (remainingMs <= 0) return "now";
  const seconds = Math.ceil(remainingMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.ceil(seconds / 60)}m`;
};

/**
 * Map connector and identity state to exactly what one settings row shows.
 *
 * Keyed on `(state, degradedMode, failure)` together. The failure code alone can
 * never drive the button: `protocol_invalid` and `authentication_failed` each
 * appear in both a retrying and a non-retrying form, and `revoked` is reported
 * *as* `authentication_failed` with a terminal state.
 */
export function presentHubStatus(
  status: HubConnectorStatus,
  identity: HubIdentitySummary,
  now: number,
): HubPresentation {
  switch (status.state) {
    case "disabled":
      // Status cannot tell these apart on its own — hence the identity summary.
      return identity.enrolled === "none"
        ? {
            dot: "idle",
            ping: false,
            headline: "Not connected",
            detail: null,
            action: "enable",
            secondaryAction: "none",
            retrying: false,
          }
        : {
            dot: "idle",
            ping: false,
            headline: "Turned off",
            detail: "This machine stays enrolled.",
            action: "enable",
            secondaryAction: "leave",
            retrying: false,
          };

    case "enrolling":
      // Not self-driving: it waits indefinitely for an explicit enrollment call.
      return {
        dot: "warning",
        ping: false,
        headline: "Ready to enrol",
        detail: "Start enrollment, then approve this machine on your Hub.",
        action: "enroll",
        secondaryAction: "disable",
        retrying: false,
      };

    case "awaiting_approval":
      return {
        dot: "warning",
        ping: true,
        headline: "Waiting for approval on the Hub",
        detail: "Compare every field below before approving.",
        action: "open-hub",
        secondaryAction: "cancel-enrollment",
        retrying: false,
      };

    case "connecting":
      return {
        dot: "warning",
        ping: true,
        headline: "Connecting",
        detail: null,
        action: "none",
        secondaryAction: "none",
        retrying: false,
      };

    case "authenticating":
      return {
        dot: "warning",
        ping: true,
        headline: "Authenticating",
        detail: null,
        action: "none",
        secondaryAction: "none",
        retrying: false,
      };

    case "online":
      return {
        dot: "success",
        ping: true,
        headline: "Connected",
        detail:
          status.activeChannels === 1
            ? "1 active session"
            : `${status.activeChannels} active sessions`,
        action: "disable",
        secondaryAction: "none",
        retrying: false,
      };

    case "degraded": {
      if (status.degradedMode === "backing_off") {
        const countdown =
          status.nextRetryAt === undefined ? null : formatCountdown(status.nextRetryAt, now);
        const selfHealing =
          status.failure === undefined ? undefined : SELF_HEALING_FAILURES[status.failure];
        if (status.failure !== undefined && selfHealing !== undefined) {
          return {
            dot: "warning",
            ping: true,
            headline: OPERATOR_FAILURES[status.failure].headline,
            detail: `${
              countdown === null
                ? "Retrying automatically."
                : countdown === "now"
                  ? "Retrying now."
                  : `Retrying automatically in ${countdown}.`
            } ${selfHealing.hint}`,
            action: "retry",
            secondaryAction: selfHealing.secondaryAction,
            retrying: true,
          };
        }
        const attempt = status.reconnectAttempt;
        return {
          dot: "warning",
          ping: true,
          headline: "Reconnecting",
          detail: [
            countdown === null
              ? null
              : countdown === "now"
                ? "Retrying now"
                : `Next attempt in ${countdown}`,
            attempt === undefined || attempt === 0 ? null : `attempt ${attempt}`,
          ]
            .filter((part): part is string => part !== null)
            .join(" · "),
          action: "none",
          secondaryAction: "none",
          retrying: true,
        };
      }
      const failure = OPERATOR_FAILURES[status.failure ?? "internal_error"];
      return {
        dot: "destructive",
        ping: false,
        headline: failure.headline,
        detail: failure.detail,
        action: failure.action,
        secondaryAction: failure.action === "leave" ? "none" : "leave",
        retrying: false,
      };
    }

    case "revoked":
      return {
        dot: "destructive",
        ping: false,
        headline: "Revoked at the Hub",
        // Saying so matters: this state looks identical to a stall otherwise,
        // and an operator waiting for a retry that will never come is worse off
        // than one told to act.
        detail: "This will not retry. Leaving erases this machine's key so you can enrol again.",
        action: "leave",
        secondaryAction: "open-hub",
        retrying: false,
      };

    case "version_incompatible":
      return {
        dot: "destructive",
        ping: false,
        headline: "Incompatible Hub version",
        detail: "This will not retry. Update Ryco, or the Hub, so both speak the same protocol.",
        action: "none",
        secondaryAction: "none",
        retrying: false,
      };

    case "stopping":
      return {
        dot: "idle",
        ping: false,
        headline: "Shutting down",
        detail: null,
        action: "none",
        secondaryAction: "none",
        retrying: false,
      };
  }
}

/**
 * Whether the Hub address may be edited.
 *
 * `unknown` is treated exactly like `active`: when custody cannot be read, an
 * identity may well exist, and offering to re-point it would strand the node in
 * a permanent origin mismatch with no in-product recovery.
 */
export function canEditHubOrigin(identity: HubIdentitySummary): boolean {
  return identity.enrolled === "none";
}
