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

export interface UserActionHintLink {
  readonly url: string;
  /** The real host, as the node parsed it (ASCII; an international name as punycode). */
  readonly host: string;
  /** The host has an international (punycode) label: a look-alike of a known name is possible. */
  readonly international: boolean;
}

/** Shown beside a host with an international label, on every card. */
export const USER_ACTION_HINT_INTERNATIONAL_NOTE =
  "International address: check it is the site you expect before you sign in.";

export interface UserActionHint {
  readonly links: ReadonlyArray<UserActionHintLink>;
  readonly codes: ReadonlyArray<string>;
}

const decodeHint = Schema.decodeUnknownOption(UserActionHintActivityPayload);

/**
 * The host a card shows beside a link, computed on the node when it records the hint (Node's
 * WHATWG parser), or `null` for a link it must not open: http or https only,
 * and no user name or password before the host (`https://github.com@evil.example/` reads as
 * GitHub but goes to evil.example). The WHATWG parser gives an international host as punycode,
 * so a look-alike (`gíthub.com`) shows as `xn--gthub-zsa.com`.
 */
export function hintLinkHost(link: string): string | null {
  try {
    const url = new URL(link);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username !== "" || url.password !== "") return null;
    return url.hostname === "" ? null : url.hostname;
  } catch {
    return null;
  }
}

/** A link a card may open (see {@link hintLinkHost}). */
export function isOpenableHintLink(link: string): boolean {
  return hintLinkHost(link) !== null;
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
      // The stored host, never one parsed here: React Native's URL knows no punycode.
      links: decoded.value.links
        .filter((link) => /^https?:\/\//.test(link.url))
        .map((link) => ({
          url: link.url,
          host: link.host,
          international: link.host.split(".").some((label) => label.startsWith("xn--")),
        })),
      codes: decoded.value.codes,
    });
  }
  return hints;
}
