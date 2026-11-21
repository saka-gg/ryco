/**
 * The links and one-time codes a surface found for a pending user action request
 * (`user-action.hint` activities, e.g. a terminal's `gh auth login` device code), for the card's
 * Open and Copy. The newest hint of a request replaces earlier ones. Links are http(s) only, also
 * when an older node or a row from elsewhere says otherwise.
 *
 * @module userActionHints
 */
import { USER_ACTION_HINT_ACTIVITY_KIND } from "@ryco/contracts/user-action-request";
import { UserActionHintActivityPayload } from "@ryco/contracts/user-action-request-details";
import * as Schema from "effect/Schema";

export interface UserActionHint {
  readonly links: ReadonlyArray<string>;
  readonly codes: ReadonlyArray<string>;
}

const decodeHint = Schema.decodeUnknownOption(UserActionHintActivityPayload);

/** A link a card may open: http or https, nothing else. */
export function isOpenableHintLink(link: string): boolean {
  try {
    const url = new URL(link);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Each request's newest hint, by request id. */
export function userActionRequestHints(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
): ReadonlyMap<string, UserActionHint> {
  const hints = new Map<string, UserActionHint>();
  for (const activity of activities) {
    if (activity.kind !== USER_ACTION_HINT_ACTIVITY_KIND) continue;
    const decoded = decodeHint(activity.payload);
    if (decoded._tag === "None") continue;
    hints.set(decoded.value.requestId, {
      links: decoded.value.links.filter(isOpenableHintLink),
      codes: decoded.value.codes,
    });
  }
  return hints;
}
