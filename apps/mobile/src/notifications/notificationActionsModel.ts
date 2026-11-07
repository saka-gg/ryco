import type { ScopedThreadRef } from "@ryco/contracts";
import type { PushAlertKind } from "@ryco/contracts/push";
import type { PendingApproval } from "@ryco/client-runtime/state/session";
import type { ProviderApprovalDecision } from "@ryco/contracts";

import { threadAlertRefOf } from "./threadAlerts.logic";

/**
 * Actionable thread alerts. Every alert carries a category for its kind, so the Lock Screen and
 * Notification Center offer its actions: Approve / Deny on an approval, Reply / Open otherwise.
 *
 * An action never acts from the background. Answering an approval or sending a message needs a
 * live, authorized connection with a current shell, and a closed Ryco has none; the Hub lifecycle
 * rules (`AGENTS.md`) and the outbox decide when one exists. So every action opens Ryco: the
 * response becomes a pending action for that thread (`pendingNotificationAction.ts`), and the
 * thread's own screen carries it out once the connection is ready for mutations, with the same
 * calls and checks as its own buttons and composer. Nothing in a URL can start an action: deep
 * links stay read-only, only a notification response from iOS sets one.
 */

export const NOTIFICATION_CATEGORY_IDS = {
  approval: "ryco.approval",
  /** Input and plan-ready: something to answer. */
  answer: "ryco.answer",
  /** Completed, failed, stopped: a result to follow up. */
  result: "ryco.result",
} as const;
export type NotificationCategoryId =
  (typeof NOTIFICATION_CATEGORY_IDS)[keyof typeof NOTIFICATION_CATEGORY_IDS];

export const NOTIFICATION_ACTION_IDS = {
  approve: "ryco.approve",
  deny: "ryco.deny",
  reply: "ryco.reply",
  open: "ryco.open",
} as const;

/** What tapping the notification itself sends: iOS's default action. */
export const DEFAULT_NOTIFICATION_ACTION_ID = "expo.modules.notifications.actions.DEFAULT";

/** How long a tapped action waits for its thread to become ready before it gives up. */
export const NOTIFICATION_ACTION_TTL_MS = 2 * 60_000;
/** A reply that cannot reach a ready connection goes to the outbox after this. */
export const NOTIFICATION_REPLY_GRACE_MS = 15_000;

/** The category an alert of `kind` shows; `NotificationService.swift` maps the same way. */
export function notificationCategoryForKind(kind: PushAlertKind): NotificationCategoryId {
  switch (kind) {
    case "approval":
      return NOTIFICATION_CATEGORY_IDS.approval;
    case "input":
    case "plan-ready":
      return NOTIFICATION_CATEGORY_IDS.answer;
    case "completed":
    case "failed":
    case "stopped":
      return NOTIFICATION_CATEGORY_IDS.result;
  }
}

/** One action button, as `expo-notifications` registers it. */
export interface NotificationActionDefinition {
  readonly identifier: string;
  readonly buttonTitle: string;
  readonly textInput?: { readonly submitButtonTitle: string; readonly placeholder: string };
  readonly options: {
    readonly opensAppToForeground: true;
    readonly isAuthenticationRequired?: boolean;
    readonly isDestructive?: boolean;
  };
}

const REPLY: NotificationActionDefinition = {
  identifier: NOTIFICATION_ACTION_IDS.reply,
  buttonTitle: "Reply",
  textInput: { submitButtonTitle: "Send", placeholder: "Message" },
  // A reply is a message sent as the person: only from an unlocked phone.
  options: { opensAppToForeground: true, isAuthenticationRequired: true },
};

const OPEN: NotificationActionDefinition = {
  identifier: NOTIFICATION_ACTION_IDS.open,
  buttonTitle: "Open",
  options: { opensAppToForeground: true },
};

/** Every category with its actions, registered once the app may post alerts. */
export const NOTIFICATION_CATEGORIES: ReadonlyArray<{
  readonly identifier: NotificationCategoryId;
  readonly actions: ReadonlyArray<NotificationActionDefinition>;
}> = [
  {
    identifier: NOTIFICATION_CATEGORY_IDS.approval,
    actions: [
      {
        identifier: NOTIFICATION_ACTION_IDS.approve,
        buttonTitle: "Approve",
        // Approving runs a command or changes files: the phone must be unlocked.
        options: { opensAppToForeground: true, isAuthenticationRequired: true },
      },
      {
        identifier: NOTIFICATION_ACTION_IDS.deny,
        buttonTitle: "Deny",
        options: {
          opensAppToForeground: true,
          isAuthenticationRequired: true,
          isDestructive: true,
        },
      },
    ],
  },
  { identifier: NOTIFICATION_CATEGORY_IDS.answer, actions: [REPLY, OPEN] },
  { identifier: NOTIFICATION_CATEGORY_IDS.result, actions: [REPLY, OPEN] },
];

/** What a response asks the thread to do. */
export type NotificationThreadAction =
  | { readonly kind: "approve" | "deny"; readonly turnId: string | null }
  | { readonly kind: "reply"; readonly text: string };

/** A notification response, decoded: the thread it names and what to do there. */
export interface NotificationRoute {
  readonly ref: ScopedThreadRef;
  /** Null just opens the thread. */
  readonly action: NotificationThreadAction | null;
  /** Each response is routed once, also when the one that launched the app arrives again. */
  readonly responseKey: string;
}

/** The parts of an `expo-notifications` response this reads. */
export interface NotificationResponseLike {
  readonly actionIdentifier: string;
  readonly userText?: string | undefined;
  readonly notification: {
    readonly date: number;
    readonly request: {
      readonly identifier: string;
      readonly content: { readonly data?: unknown };
    };
  };
}

/** The turn an alert's data names: a local alert's `turnId`, an opened push's `tu`. */
function turnIdOf(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const turnId = (data as { readonly turnId?: unknown }).turnId;
  return typeof turnId === "string" && turnId.length > 0 ? turnId : null;
}

/**
 * The route a response asks for, or null when it names no thread (a push the extension could not
 * open, a dismissal) or an action this app does not know. A reply with no text just opens.
 */
export function notificationRouteOf(response: NotificationResponseLike): NotificationRoute | null {
  const ref = threadAlertRefOf(response.notification.request.content.data);
  if (ref === null) return null;
  const responseKey = `${response.notification.request.identifier}:${response.notification.date}:${response.actionIdentifier}`;
  const route = (action: NotificationThreadAction | null): NotificationRoute => ({
    ref,
    action,
    responseKey,
  });
  switch (response.actionIdentifier) {
    case DEFAULT_NOTIFICATION_ACTION_ID:
    case NOTIFICATION_ACTION_IDS.open:
      return route(null);
    case NOTIFICATION_ACTION_IDS.approve:
    case NOTIFICATION_ACTION_IDS.deny:
      return route({
        kind: response.actionIdentifier === NOTIFICATION_ACTION_IDS.approve ? "approve" : "deny",
        turnId: turnIdOf(response.notification.request.content.data),
      });
    case NOTIFICATION_ACTION_IDS.reply: {
      const text = response.userText?.trim() ?? "";
      return route(text.length > 0 ? { kind: "reply", text } : null);
    }
    default:
      return null;
  }
}

/** A pending action as the thread screen sees it. */
export interface PendingThreadAction {
  readonly action: NotificationThreadAction;
  /** When the person tapped it, epoch ms. */
  readonly at: number;
}

export type NotificationThreadActionStep =
  /** Not yet: the connection or the thread is not ready. */
  | { readonly kind: "wait" }
  | {
      readonly kind: "respond";
      readonly approval: Pick<PendingApproval, "requestId" | "approvalIdentity">;
      readonly decision: ProviderApprovalDecision;
    }
  | { readonly kind: "send"; readonly text: string }
  /** It cannot be carried out; the screen says why and the person answers there. */
  | { readonly kind: "refuse"; readonly message: string };

/** An approval this device may still answer: not on its way, not settled. */
function isOpenApproval(approval: PendingApproval): boolean {
  return (
    approval.responseState === undefined ||
    approval.responseState === "retryable" ||
    approval.responseState === "invalidated"
  );
}

/**
 * What the thread screen does with a pending action now.
 *
 * - An approval waits for a connection ready for mutations with live (not cached) prompts, then
 *   answers the one approval the alert announced: the open approval of the alert's turn, and only
 *   when there is exactly one. None (answered elsewhere meanwhile) or several (which one?) is
 *   refused, and the person chooses on screen. It never answers an approval it cannot tell apart.
 * - A reply waits for the thread and a ready connection, and after a short grace is sent anyway:
 *   the composer's own send then queues it in the outbox, as it would anything typed offline.
 * - Past {@link NOTIFICATION_ACTION_TTL_MS} from the tap an approval is refused, so a phone that
 *   reconnects much later never answers a question the person may no longer mean.
 */
export function decideNotificationThreadAction(input: {
  readonly pending: PendingThreadAction;
  readonly nowMs: number;
  /** The thread's row is loaded. */
  readonly threadLoaded: boolean;
  /** The connection is ready for mutations and the prompts on screen are live. */
  readonly ready: boolean;
  readonly pendingApprovals: ReadonlyArray<PendingApproval>;
}): NotificationThreadActionStep {
  const { pending, nowMs } = input;
  const elapsed = nowMs - pending.at;
  const action = pending.action;
  if (action.kind === "reply") {
    if (!input.threadLoaded) {
      return elapsed >= NOTIFICATION_ACTION_TTL_MS
        ? { kind: "refuse", message: "The reply was not sent: this thread did not load." }
        : { kind: "wait" };
    }
    return input.ready || elapsed >= NOTIFICATION_REPLY_GRACE_MS
      ? { kind: "send", text: action.text }
      : { kind: "wait" };
  }
  const verb = action.kind === "approve" ? "approve" : "deny";
  if (!input.threadLoaded || !input.ready) {
    return elapsed >= NOTIFICATION_ACTION_TTL_MS
      ? {
          kind: "refuse",
          message: `Ryco could not reach this machine in time to ${verb}. Answer here once it is connected.`,
        }
      : { kind: "wait" };
  }
  const open = input.pendingApprovals.filter(isOpenApproval);
  const ofTurn =
    action.turnId === null
      ? open
      : open.filter(
          (approval) => approval.turnId === undefined || approval.turnId === action.turnId,
        );
  const approval = ofTurn[0];
  if (approval === undefined) {
    return { kind: "refuse", message: "That approval was already answered." };
  }
  if (ofTurn.length > 1) {
    return { kind: "refuse", message: "Several approvals wait in this thread. Choose one here." };
  }
  return {
    kind: "respond",
    approval: { requestId: approval.requestId, approvalIdentity: approval.approvalIdentity },
    decision: action.kind === "approve" ? "accept" : "decline",
  };
}
