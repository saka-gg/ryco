// Adapted from Synara v0.9.1; see docs/licenses/synara-computer-use.txt.
import { COMPUTER_APPROVAL_UNNAMED_APP } from "./computerApprovalTargets.ts";

/** The app one Computer action targets, as the approval dialog names it. */
export interface ComputerApprovalApp {
  /** Normalized app name (`computerAppApprovalKey`). */
  readonly key: string;
  readonly name: string;
  /** False for a target that cannot be named; it can only be allowed for one chat. */
  readonly canAlwaysAllow: boolean;
}

/** The user's answer to one app dialog. Refusals (expired, unshown, pending) are thrown instead. */
export type ComputerAppAnswer = "always" | "chat" | "deny";

/** The persisted "Always allow" list; the gate only reads it and adds to it. */
export interface ComputerAlwaysAllowedApps {
  has(key: string): Promise<boolean>;
  add(app: ComputerApprovalApp): Promise<void>;
}

interface AppDialog {
  readonly threadId: string;
  readonly turnId: string;
  readonly answer: Promise<ComputerAppAnswer>;
  cancelled: boolean;
}

/** Threads whose chat approvals are remembered; the oldest are forgotten first. */
export const COMPUTER_APP_APPROVAL_THREAD_LIMIT = 256;

/** Rejection when no more consent prompts fit, global or for one chat. */
export const COMPUTER_APPROVAL_QUEUE_FULL_CODE = "approval_queue_full";

export class ComputerApprovalQueueFullError extends Error {
  readonly code = COMPUTER_APPROVAL_QUEUE_FULL_CODE;
  readonly effect = "not-dispatched";
  /** False once the desktop stopped asking for this turn. */
  readonly retryable: boolean;
  constructor(retryable = true) {
    super(
      retryable
        ? "Too many computer approvals are waiting."
        : "Other computer approvals kept the dialog from showing; no input was sent. Do not ask again in this turn; tell the user what needs approval.",
    );
    this.retryable = retryable;
    this.name = "ComputerApprovalQueueFullError";
  }
}

// Expiry semantics adapted from Synara v1.0.4 (d36a31a29). The desktop consent
// dialog owns the policy (apps/desktop/src/computerUse/taskConsent.ts); these
// are the refusals the server maps its reply to.
export const COMPUTER_APPROVAL_EXPIRED_CODE = "approval_expired";
export const COMPUTER_APPROVAL_PENDING_CODE = "approval_pending";
export const COMPUTER_APPROVAL_UNAVAILABLE_CODE = "approval_unavailable";

/** An unanswered card is not a user decision and must not become a turn-long denial. */
export class ComputerApprovalExpiredError extends Error {
  readonly code = COMPUTER_APPROVAL_EXPIRED_CODE;
  readonly effect = "not-dispatched";
  /** False once the turn's one re-request also expired. */
  readonly retryable: boolean;
  constructor(retryable = true) {
    super(
      retryable
        ? "The computer approval expired without an answer; no input was sent. Request approval again only if the action is still needed."
        : "The computer approval expired again without an answer; no input was sent. Do not ask again in this turn; tell the user what needs approval.",
    );
    this.retryable = retryable;
    this.name = "ComputerApprovalExpiredError";
  }
}

/** The dialog is still open; one tool call cannot outwait the request ceiling. */
export class ComputerApprovalPendingError extends Error {
  readonly code = COMPUTER_APPROVAL_PENDING_CODE;
  readonly effect = "not-dispatched";
  readonly retryable = true;
  constructor() {
    super(
      "The user has not answered the Computer approval yet; no input was sent. Call the same tool again to keep waiting.",
    );
    this.name = "ComputerApprovalPendingError";
  }
}

/** No dialog could be shown, or the desktop's answer was not one it gives. */
export class ComputerApprovalUnavailableError extends Error {
  readonly code = COMPUTER_APPROVAL_UNAVAILABLE_CODE;
  readonly effect = "not-dispatched";
  /** False once the desktop stopped asking for this turn. */
  readonly retryable: boolean;
  constructor(retryable = true) {
    super(
      retryable
        ? "Ryco could not show the Computer approval dialog; no input was sent. Try again when the Ryco window is open."
        : "Ryco could not show the Computer approval dialog again; no input was sent. Do not ask again in this turn; tell the user to open the Ryco window.",
    );
    this.retryable = retryable;
    this.name = "ComputerApprovalUnavailableError";
  }
}

/** A consent request that refused this call without a user decision binding the turn. */
export type ComputerApprovalRefusal =
  | ComputerApprovalExpiredError
  | ComputerApprovalPendingError
  | ComputerApprovalUnavailableError
  | ComputerApprovalQueueFullError;

export function isComputerApprovalRefusal(error: unknown): error is ComputerApprovalRefusal {
  return (
    error instanceof ComputerApprovalExpiredError ||
    error instanceof ComputerApprovalPendingError ||
    error instanceof ComputerApprovalUnavailableError ||
    error instanceof ComputerApprovalQueueFullError
  );
}

/** The tool-result body both Computer tool families return for an approval refusal. */
export function computerApprovalRefusalPayload(error: ComputerApprovalRefusal) {
  return {
    error: {
      code: error.code,
      effect: error.effect,
      retryable: error.retryable,
      message: error.message,
    },
  };
}

/**
 * Per-app Computer consent for live turns: "Always allow", "Allow for this chat", per-turn
 * declines and one shared dialog per thread, turn and app. The desktop owns the dialog and its
 * timeout. Clipboard reads use separate per-call approvals.
 */
export class ComputerApprovalGate {
  /** "Allow for this chat" answers, per thread. */
  private readonly chatApps = new Map<string, Set<string>>();
  /**
   * Approvals of the unnamed target ("your Mac": a call that names no app). They last
   * for the turn that got them only: kept for the chat, one answer would let every later
   * window-less call reach any app without that app's own prompt.
   */
  private readonly turnUnnamed = new Map<string, string>();
  /** "Don't allow" answers, which last for the turn that got them. */
  private readonly deniedApps = new Map<string, { turnId: string; keys: Set<string> }>();
  /**
   * One open app dialog per thread, turn and app; later calls join it. Stop marks it
   * cancelled, so its late answer records nothing.
   */
  private readonly appDialogs = new Map<string, AppDialog>();

  cancelThread(threadId: string, turnId?: string): void {
    const denied = this.deniedApps.get(threadId);
    if (turnId === undefined || denied?.turnId === turnId) this.deniedApps.delete(threadId);
    if (turnId === undefined || this.turnUnnamed.get(threadId) === turnId)
      this.turnUnnamed.delete(threadId);
    for (const [key, dialog] of this.appDialogs) {
      if (dialog.threadId !== threadId || (turnId !== undefined && dialog.turnId !== turnId))
        continue;
      dialog.cancelled = true;
      this.appDialogs.delete(key);
    }
  }

  /** A removed thread drops its chat approvals too. */
  forgetThread(threadId: string): void {
    this.cancelThread(threadId);
    this.chatApps.delete(threadId);
  }

  /**
   * A desktop interruption (screen lock, sleep, session switch) clears "Allow for this chat"
   * answers and this turn's unnamed-target approval, so consent given before the interruption
   * cannot authorize the desktop after it. "Always allow", declines for the turn and open app
   * dialogs stay (an answer to a dialog still open postdates the interruption).
   */
  revokeTaskGrants(): void {
    // "Allow for this chat" is consent given before the interruption too.
    // "Always allow" is the user's standing choice and stays. An app dialog still
    // open stays as well: its answer postdates the interruption.
    this.chatApps.clear();
    this.turnUnnamed.clear();
  }

  /**
   * Per-app approval for one mutating Computer action, like Codex: an app the user always
   * allows, or allowed for this chat, runs without asking; one they refused in this turn is
   * refused again; anything else asks once, and concurrent calls for the same app share that
   * dialog. Refusals that are not the user's answer (expired, still open, not shown) propagate
   * from `present` and record nothing.
   */
  async requestApp(input: {
    threadId: string;
    turnId: string;
    app: ComputerApprovalApp;
    signal: AbortSignal;
    alwaysAllowed: ComputerAlwaysAllowedApps;
    /** Shows the dialog; it bounds its own wait, since the dialog outlives any one call. */
    present: () => Promise<ComputerAppAnswer>;
  }): Promise<boolean> {
    const { threadId, turnId, app, signal } = input;
    signal.throwIfAborted();
    if (app.canAlwaysAllow && (await input.alwaysAllowed.has(app.key))) return true;
    signal.throwIfAborted();
    const unnamed = app.key === COMPUTER_APPROVAL_UNNAMED_APP.key;
    if (
      unnamed
        ? this.turnUnnamed.get(threadId) === turnId
        : this.chatApps.get(threadId)?.has(app.key)
    )
      return true;
    const denied = this.deniedApps.get(threadId);
    if (denied?.turnId === turnId && denied.keys.has(app.key)) return false;
    const dialogKey = JSON.stringify([threadId, turnId, app.key]);
    let dialog = this.appDialogs.get(dialogKey)?.answer;
    if (!dialog) {
      let current!: AppDialog;
      const answer = (async () => {
        // The dialog outlives the call that opened it, so it is not tied to that call's signal.
        const answer = await input.present();
        if (current.cancelled) return "deny" as const;
        if (answer === "always" && app.canAlwaysAllow) await input.alwaysAllowed.add(app);
        if (answer === "always" || answer === "chat") {
          if (unnamed) this.allowUnnamedForTurn(threadId, turnId);
          else this.allowForChat(threadId, app.key);
        } else this.denyForTurn(threadId, turnId, app.key);
        return answer;
      })();
      current = { threadId, turnId, answer, cancelled: false };
      dialog = answer;
      this.appDialogs.set(dialogKey, current);
      const clear = () => {
        if (this.appDialogs.get(dialogKey) === current) this.appDialogs.delete(dialogKey);
      };
      void answer.then(clear, clear);
    }
    let cancel: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
    });
    try {
      const answer = await Promise.race([dialog, aborted]);
      signal.throwIfAborted();
      return answer !== "deny";
    } finally {
      if (cancel) signal.removeEventListener("abort", cancel);
    }
  }

  private allowForChat(threadId: string, key: string): void {
    const apps = this.chatApps.get(threadId) ?? new Set<string>();
    this.chatApps.delete(threadId);
    this.chatApps.set(threadId, apps.add(key));
    while (this.chatApps.size > COMPUTER_APP_APPROVAL_THREAD_LIMIT)
      this.chatApps.delete(this.chatApps.keys().next().value!);
  }

  private allowUnnamedForTurn(threadId: string, turnId: string): void {
    this.turnUnnamed.delete(threadId);
    this.turnUnnamed.set(threadId, turnId);
    while (this.turnUnnamed.size > COMPUTER_APP_APPROVAL_THREAD_LIMIT)
      this.turnUnnamed.delete(this.turnUnnamed.keys().next().value!);
  }

  private denyForTurn(threadId: string, turnId: string, key: string): void {
    const denied = this.deniedApps.get(threadId);
    if (denied?.turnId === turnId) denied.keys.add(key);
    else this.deniedApps.set(threadId, { turnId, keys: new Set([key]) });
    while (this.deniedApps.size > COMPUTER_APP_APPROVAL_THREAD_LIMIT)
      this.deniedApps.delete(this.deniedApps.keys().next().value!);
  }
}

export const computerApprovalGate = new ComputerApprovalGate();
