import * as Schema from "effect/Schema";

import {
  USER_ACTION_REQUEST_MESSAGE_MAX_CHARS,
  USER_ACTION_REQUEST_TTL_MS_MAX,
  UserActionNeed,
  UserActionOutcome,
} from "./userActionRequest.ts";

/**
 * The desktop's side of handing a Ryco browser tab to the user (`ryco_browser` action
 * `handoff`): what the node asks the desktop's computer-use bridge (`POST /handoff`, the bridge's
 * own bearer token) and what it answers. The request itself (the card, the answer, the wait) is a
 * user action request (`userActionRequest.ts`); this is only the tab's part: give it to the user,
 * watch its condition, and give it back once what the user typed is kept private.
 *
 * Not in the barrel: only the node and the desktop read it.
 */

const bounded = (max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));
const conditionText = Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512)));

export const BrowserHandoffDoneWhen = Schema.Struct({
  url: conditionText,
  text: conditionText,
  gone: conditionText,
  selector: conditionText,
});
export type BrowserHandoffDoneWhen = typeof BrowserHandoffDoneWhen.Type;

export const BrowserHandoffBridgeRequest = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("begin"),
    /** The node's request id (`UserActionRequestId`). */
    requestId: bounded(128),
    threadId: bounded(256),
    tab: bounded(128),
    message: bounded(USER_ACTION_REQUEST_MESSAGE_MAX_CHARS),
    need: UserActionNeed,
    doneWhen: Schema.optionalKey(BrowserHandoffDoneWhen),
    /** The desktop gives the tab back by itself this long after the request's own expiry. */
    ttlMs: Schema.Int.check(
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(USER_ACTION_REQUEST_TTL_MS_MAX),
    ),
  }),
  Schema.Struct({ op: Schema.Literal("probe"), requestId: bounded(128) }),
  Schema.Struct({ op: Schema.Literal("end"), requestId: bounded(128), outcome: UserActionOutcome }),
]);
export type BrowserHandoffBridgeRequest = typeof BrowserHandoffBridgeRequest.Type;

/** The page as the probe saw it (no field values). */
export const BrowserHandoffPage = Schema.Struct({
  href: Schema.String,
  title: Schema.String,
  ready: Schema.String,
  heading: Schema.optionalKey(Schema.String),
  secretFields: Schema.optionalKey(Schema.Number),
});
export type BrowserHandoffPage = typeof BrowserHandoffPage.Type;

export const BrowserHandoffBridgeResponse = Schema.Union([
  /** begin: the tab is the user's now. */
  Schema.Struct({ status: Schema.Literal("handed-off") }),
  /** begin: done_when already holds, so nothing was handed over. */
  Schema.Struct({ status: Schema.Literal("already-met"), page: BrowserHandoffPage }),
  /** begin: refused, in words for the agent. */
  Schema.Struct({ status: Schema.Literal("refused"), text: Schema.String }),
  /** probe: still the user's; `met` once done_when held and the page settled. */
  Schema.Struct({ status: Schema.Literal("active"), met: Schema.Boolean }),
  /** probe: the tab closed. */
  Schema.Struct({ status: Schema.Literal("closed") }),
  /** probe: the desktop has no such hand-off (it restarted). */
  Schema.Struct({ status: Schema.Literal("missing") }),
  /** end: the tab is the agent's again, unless `stillPaused`. */
  Schema.Struct({
    status: Schema.Literal("ended"),
    outcome: UserActionOutcome,
    tab: Schema.String,
    url: Schema.String,
    page: Schema.optionalKey(BrowserHandoffPage),
    withheld: Schema.Struct({ requests: Schema.Number, messages: Schema.Number }),
    scrubbed: Schema.Number,
    stillPaused: Schema.Boolean,
    waitedMs: Schema.Number,
  }),
]);
export type BrowserHandoffBridgeResponse = typeof BrowserHandoffBridgeResponse.Type;
