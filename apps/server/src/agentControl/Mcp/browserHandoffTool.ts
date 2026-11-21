/**
 * `ryco_browser` action `handoff`: an agent hands a Ryco browser tab to the user for what it must
 * not or cannot do itself (a sign-in with a real account, a one-time code, a captcha, a consent
 * screen), and continues there once they are done.
 *
 * The request is a user action request (`userActionRequests/userActionRequests.ts`): a card in the
 * thread with Show / Done / Won't do, pending input while it waits, an expiry. The desktop's
 * bridge (`POST /handoff`, `apps/desktop/src/computerUse/browserHandoffs.ts`) gives the tab to the
 * user, probes `done_when`, and gives the tab back once password and code fields are emptied and
 * what the page logged and sent meanwhile is withheld. This call waits at most 45 s and answers
 * pending; the agent calls again with the same requestId.
 *
 * Loaded with the first hand-off (`computerTools.ts`): never at boot.
 *
 * @module agentControl/Mcp/browserHandoffTool
 */
import {
  USER_ACTION_REQUEST_MAX_PENDING_PER_THREAD,
  USER_ACTION_REQUEST_MESSAGE_MAX_CHARS,
  USER_ACTION_REQUEST_TTL_MS_DEFAULT,
  USER_ACTION_REQUEST_WAIT_MS_DEFAULT,
  USER_ACTION_REQUEST_WAIT_MS_MAX,
  UserActionNeed,
  type ThreadId,
  type TurnId,
  type UserActionOutcome,
  type UserActionRequestId,
} from "@ryco/contracts";
import {
  BrowserHandoffBridgeResponse,
  BrowserHandoffDoneWhen,
  type BrowserHandoffBridgeRequest,
} from "@ryco/contracts/browser-handoff";
import {
  describeBrowserHandoffOutcome,
  describeBrowserHandoffPrivacy,
  browserTabLabel,
  describeBrowserPage,
  validateBrowserDoneWhen,
} from "@ryco/shared/browserHandoff";
import {
  UserActionRequestMessage,
  UserActionRequestTarget,
} from "@ryco/contracts/user-action-request-details";
import type { UserActionRequestView } from "@ryco/shared/userActionRequestState";
import { Effect, Schema } from "effect";

import {
  findUserActionRequest,
  openUserActionRequest,
  resolveUserActionRequest,
  UserActionRequestOpenError,
  waitForUserActionRequest,
  watchUserActionRequest,
  type UserActionWaitDeps,
} from "../../userActionRequests/userActionRequests.ts";
import type { AgentControlMcpToolResult } from "./tools.ts";

const isRequestMessage = Schema.is(UserActionRequestMessage);
const isRequestTarget = Schema.is(UserActionRequestTarget);

/** How often the node probes a pending hand-off's tab (done_when, closed). */
const PROBE_EVERY_MS = 1_000;
const TIMEOUT_S_MIN = 30;
const TIMEOUT_S_MAX = 3_600;

/** One request to the desktop's hand-off bridge. Fails when the bridge cannot be reached. */
export type BrowserHandoffBridge = (
  request: BrowserHandoffBridgeRequest,
) => Effect.Effect<BrowserHandoffBridgeResponse, BrowserHandoffBridgeError>;

export class BrowserHandoffBridgeError {
  readonly _tag = "BrowserHandoffBridgeError";
}

const HandoffArgs = Schema.Struct({
  action: Schema.Literal("handoff"),
  browser: Schema.Literal("ryco"),
  tab: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  message: Schema.optionalKey(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(USER_ACTION_REQUEST_MESSAGE_MAX_CHARS),
    ),
  ),
  need: Schema.optionalKey(UserActionNeed),
  done_when: Schema.optionalKey(BrowserHandoffDoneWhen),
  waitMs: Schema.optionalKey(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(USER_ACTION_REQUEST_WAIT_MS_MAX),
    ),
  ),
  timeout_seconds: Schema.optionalKey(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(TIMEOUT_S_MIN),
      Schema.isLessThanOrEqualTo(TIMEOUT_S_MAX),
    ),
  ),
  cancel: Schema.optionalKey(Schema.Boolean),
});

/**
 * A result whose structured part repeats the sentences (`message`): some clients (Claude) show the
 * model only `structuredContent` when it is there, and the sentences are what steers the agent.
 */
const text = (
  value: string,
  structured: Record<string, unknown> | undefined,
  isError = false,
): AgentControlMcpToolResult => ({
  content: [{ type: "text", text: value }],
  ...(structured === undefined ? {} : { structuredContent: { ...structured, message: value } }),
  ...(isError ? { isError: true } : {}),
});
const refusal = (value: string) => text(value, undefined, true);

const PENDING_NOTE = (tab: string, requestId: string) =>
  `The user has ${browserTabLabel(tab)} now and has not finished. Call ryco_browser action "handoff" again with requestId "${requestId}" (the same tab) to keep waiting, or end your turn and tell the user the card is waiting. Do not use ${browserTabLabel(tab)} meanwhile; your other tabs still work. Never ask for the password or code in chat.`;

/** Watches a pending hand-off's tab from the node: its condition and whether it closed. */
const watchTab = (
  deps: UserActionWaitDeps,
  bridge: BrowserHandoffBridge,
  threadId: ThreadId,
  requestId: UserActionRequestId,
) =>
  watchUserActionRequest(deps, {
    threadId,
    requestId,
    everyMs: PROBE_EVERY_MS,
    check: bridge({ op: "probe", requestId }).pipe(
      Effect.map((response): UserActionOutcome | null => {
        if (response.status === "closed") return "closed";
        // The desktop no longer knows it (it restarted): nothing is handed over any more.
        if (response.status === "missing") return "cancelled";
        if (response.status === "active" && response.met) return "condition-met";
        return null;
      }),
      // An unreachable bridge is tried again on the next tick.
      Effect.orElseSucceed(() => null),
    ),
  });

/** The agent's result once the request ended: how, where the page is, and what stayed private. */
const endedResult = (
  bridge: BrowserHandoffBridge,
  request: UserActionRequestView,
  callerRequestId: string,
) =>
  Effect.gen(function* () {
    const outcome = request.status as UserActionOutcome;
    const tab = request.target ?? "the tab";
    // The surface hook already gave the tab back; this answers what it did (or does it now).
    const ended = yield* bridge({ op: "end", requestId: request.requestId, outcome }).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const waitedMs =
      ended?.status === "ended"
        ? ended.waitedMs
        : Math.max(0, Date.now() - Date.parse(request.requestedAt));
    const lines = [describeBrowserHandoffOutcome(outcome, tab, waitedMs)];
    if (ended?.status === "ended") {
      if (ended.outcome !== "closed")
        lines.push(describeBrowserPage(ended.page, ended.url, outcome));
      const privacy = describeBrowserHandoffPrivacy(ended.withheld, ended.scrubbed);
      if (privacy) lines.push(privacy);
      if (ended.stillPaused) {
        lines.push(
          `${browserTabLabel(tab)} stays with the user: its password fields could not be emptied, so it is not handed back. Ask the user in chat to close the tab or sign in again, then open a new tab.`,
        );
      }
    }
    return text(lines.join("\n"), {
      requestId: callerRequestId,
      tab,
      status: outcome,
      ...(ended?.status === "ended" ? { url: ended.page?.href ?? ended.url } : {}),
    });
  });

const decodeResponse = Schema.decodeUnknownEffect(BrowserHandoffBridgeResponse);

export const handOffRycoBrowserTab = (input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly args: unknown;
  readonly deps: UserActionWaitDeps;
  /** Posts one request to the desktop's bridge and answers its JSON body. */
  readonly post: (
    request: BrowserHandoffBridgeRequest,
  ) => Effect.Effect<unknown, { readonly _tag: string }>;
}): Effect.Effect<AgentControlMcpToolResult> =>
  Effect.gen(function* () {
    const bridge: BrowserHandoffBridge = (request) =>
      input.post(request).pipe(
        Effect.flatMap(decodeResponse),
        Effect.mapError(() => new BrowserHandoffBridgeError()),
      );
    const decoded = Schema.decodeUnknownExit(HandoffArgs)(input.args);
    if (decoded._tag === "Failure") {
      return refusal(
        'handoff needs browser "ryco", tab, requestId and (the first time) message; optional need, done_when {url, text, gone, selector}, waitMs (at most 45000), timeout_seconds (30 to 3600) and cancel.',
      );
    }
    const args = decoded.value;
    const problem = validateBrowserDoneWhen(args.done_when);
    if (problem) return refusal(problem);
    const { deps, threadId } = input;
    const found = yield* findUserActionRequest(deps, {
      threadId,
      callerRequestId: args.requestId,
      surface: "browser",
      target: args.tab,
    });
    let request = found.existing;

    if (args.cancel === true) {
      if (request === undefined) return refusal("No hand-off with this requestId.");
      const cancelled = yield* resolveUserActionRequest(
        deps,
        threadId,
        found.requestId,
        "cancelled",
      ).pipe(Effect.orElseSucceed(() => request));
      return yield* endedResult(bridge, cancelled ?? request, args.requestId);
    }

    if (request === undefined) {
      // Checked as the record will be read back, before the tab is handed over: a message or tab
      // the card could not show must never leave the tab locked with no card.
      const message = args.message?.trim();
      if (message === undefined || !isRequestMessage(message)) {
        return refusal(
          `The first handoff call needs a message for the user: 1 to ${USER_ACTION_REQUEST_MESSAGE_MAX_CHARS} characters.`,
        );
      }
      if (!isRequestTarget(args.tab)) {
        return refusal("tab must be a tab id from tabs, without spaces around it.");
      }
      const ttlMs =
        args.timeout_seconds === undefined
          ? USER_ACTION_REQUEST_TTL_MS_DEFAULT
          : args.timeout_seconds * 1_000;
      const need = args.need ?? "sign-in";
      const begun = yield* bridge({
        op: "begin",
        requestId: found.requestId,
        threadId,
        tab: args.tab,
        message,
        need,
        ...(args.done_when === undefined ? {} : { doneWhen: args.done_when }),
        ttlMs,
      }).pipe(Effect.orElseSucceed(() => undefined));
      if (begun === undefined) {
        return refusal("The Ryco browser is unavailable. Check desktop settings and try again.");
      }
      if (begun.status === "refused") return refusal(begun.text);
      if (begun.status === "already-met") {
        return text(
          `done_when already holds in ${browserTabLabel(args.tab)}, so nothing was handed to the user. ${describeBrowserPage(begun.page, begun.page.href, "condition-met")}`,
          { requestId: args.requestId, tab: args.tab, status: "already-met", url: begun.page.href },
        );
      }
      if (begun.status !== "handed-off") {
        return refusal("The Ryco browser could not hand the tab over.");
      }
      const opened = yield* openUserActionRequest(deps, {
        threadId,
        turnId: input.turnId,
        callerRequestId: args.requestId,
        surface: "browser",
        need,
        message,
        target: args.tab,
        ttlMs,
        maxPending: USER_ACTION_REQUEST_MAX_PENDING_PER_THREAD,
      }).pipe(
        Effect.tapError(() =>
          // No card means no hand-off: the tab goes back at once.
          bridge({ op: "end", requestId: found.requestId, outcome: "cancelled" }).pipe(
            Effect.ignore,
          ),
        ),
      );
      request = opened.request;
    }

    if (request.status === "pending") {
      // Started on every call, once per request in this process: also after a node restart.
      yield* watchTab(deps, bridge, threadId, request.requestId);
      const waited = yield* waitForUserActionRequest(deps, {
        threadId,
        requestId: request.requestId,
        waitMs: args.waitMs ?? USER_ACTION_REQUEST_WAIT_MS_DEFAULT,
      });
      if (waited === undefined) return refusal("The hand-off no longer exists.");
      request = waited;
    }
    if (request.status === "pending") {
      return text(PENDING_NOTE(args.tab, args.requestId), {
        requestId: args.requestId,
        tab: args.tab,
        status: "pending",
        expiresAt: request.expiresAt,
      });
    }
    return yield* endedResult(bridge, request, args.requestId);
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        refusal(error instanceof UserActionRequestOpenError ? error.text : "The hand-off failed."),
      ),
    ),
  );
