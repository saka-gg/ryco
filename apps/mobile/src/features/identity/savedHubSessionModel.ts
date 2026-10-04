import {
  hostedHubFailureExplanation,
  type HostedAccountStatus,
  type HostedHubFailureReason,
} from "@ryco/client-runtime/authorization";

/**
 * What the locked identity screen shows when this device still holds a Hub
 * session but its launch-time access check could not reach the Hub.
 *
 * Free of React and react-native so it is asserted by a real test (the mobile
 * app has no component tests). It decides presentation only: the stored
 * session's presence is never authority here, exactly as in `appAccessModel` —
 * the app stays locked until the shared runtime has revalidated the session.
 */
export interface SavedHubSessionFacts {
  readonly accountStatus: HostedAccountStatus;
  readonly errorReason: HostedHubFailureReason | null;
  /** This device holds a stored Hub session. Presentation input, never authority. */
  readonly savedSession: boolean;
  /** The identity screen is on its entry step, not partway through a ceremony. */
  readonly entryScreen: boolean;
  /** The user chose to sign in another way rather than wait for the Hub. */
  readonly signInRequested: boolean;
}

export type SavedHubSessionView =
  | { readonly kind: "sign-in" }
  | {
      readonly kind: "reconnecting";
      readonly title: string;
      readonly detail: string;
      readonly note: string;
    };

export const SAVED_HUB_SESSION_TITLE = "Reaching your Hub…";
export const SAVED_HUB_SESSION_NOTE =
  "Your sign-in is saved on this device. Ryco keeps trying and opens your workspace as soon as the Hub answers.";
const SAVED_HUB_SESSION_FALLBACK_DETAIL = "Ryco could not reach your Hub.";

export function deriveSavedHubSessionView(facts: SavedHubSessionFacts): SavedHubSessionView {
  // `unavailable` is published only for a failure that said nothing about the
  // session; a rejected session lands in `signed-out` / `session-expired`
  // with its material already cleared, and gets the sign-in form.
  if (
    facts.accountStatus !== "unavailable" ||
    !facts.savedSession ||
    !facts.entryScreen ||
    facts.signInRequested
  ) {
    return { kind: "sign-in" };
  }
  return {
    kind: "reconnecting",
    title: SAVED_HUB_SESSION_TITLE,
    detail:
      facts.errorReason === null
        ? SAVED_HUB_SESSION_FALLBACK_DETAIL
        : hostedHubFailureExplanation(facts.errorReason).message,
    note: SAVED_HUB_SESSION_NOTE,
  };
}
