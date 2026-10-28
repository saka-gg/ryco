import type { DesktopQuitRunningChat, DesktopQuitRunningChatStatus } from "@ryco/contracts";
import { RESTART_CONTINUATION_MAX_AGE_MS } from "@ryco/shared/restartContinuation";

import {
  isQuitGuardRequestId,
  isRecord,
  MAX_REPLY_ERROR_LENGTH,
  type QuitGuardRequest,
  type QuitGuardRequestBody,
} from "./quitGuardChannels.ts";

/** How long a quit waits for the window to say which chats it would stop. */
export const QUIT_RUNNING_CHATS_TIMEOUT_MS = 1_500;
/** How long a confirmed quit waits for "Continue after restart" to be saved. */
export const QUIT_CONTINUE_SETTING_TIMEOUT_MS = 3_000;
/** Chats the dialog names, whatever a window sends (the web app sends as many). */
export const QUIT_DIALOG_MAX_CHATS = 8;
export const QUIT_DIALOG_TITLE_MAX_CHARS = 80;
/** The node's continuation window, as the dialog names it. */
const CONTINUE_WINDOW_MINUTES = Math.round(RESTART_CONTINUATION_MAX_AGE_MS / 60_000);
/**
 * How long a system shutdown or logout notice makes quits urgent. Bounded: no notice says a
 * logout was cancelled, and a cancelled one must not silence every later quit.
 */
export const SYSTEM_SHUTDOWN_URGENT_MS = 30_000;
/** Most chat entries a report may carry that main looks at; the rest are ignored. */
const MAX_REPORTED_CHAT_ENTRIES = 64;

/** Renderer-supplied text as one log-safe line: no control, format or line-break characters. */
function toLogText(text: string): string {
  return text
    .slice(0, MAX_REPLY_ERROR_LENGTH)
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

// ── Requests to a window ───────────────────────────────────────────────

/** A reply as main receives it: the envelope is checked, a report is parsed by its reader. */
export type ReceivedQuitGuardReply =
  | { readonly requestId: string; readonly kind: "running-chats"; readonly report: unknown }
  | {
      readonly requestId: string;
      readonly kind: "continue-after-restart";
      readonly saved: boolean;
      readonly error: string | undefined;
    };

export type QuitGuardRequestOutcome =
  | { readonly kind: "reply"; readonly reply: ReceivedQuitGuardReply }
  | { readonly kind: "timeout" | "gone" | "send-failed" };

export function parseQuitGuardReply(raw: unknown): ReceivedQuitGuardReply | null {
  if (!isRecord(raw) || !isQuitGuardRequestId(raw.requestId)) return null;
  if (raw.kind === "running-chats") {
    return { requestId: raw.requestId, kind: "running-chats", report: raw.report };
  }
  if (raw.kind === "continue-after-restart" && typeof raw.saved === "boolean") {
    return {
      requestId: raw.requestId,
      kind: "continue-after-restart",
      saved: raw.saved,
      error: typeof raw.error === "string" ? toLogText(raw.error) : undefined,
    };
  }
  return null;
}

export interface QuitGuardRequester<Target> {
  /** Settles exactly once: the reply, or why none can come. */
  request(
    target: Target,
    body: QuitGuardRequestBody,
    timeoutMs: number,
  ): Promise<QuitGuardRequestOutcome>;
  /** A reply sent by `sender`. Anything that does not answer its own open request is ignored. */
  receive(sender: Target, raw: unknown): void;
}

export function createQuitGuardRequester<Target>(deps: {
  /** `false` when the target cannot receive now (destroyed, crashed): settles `send-failed`. */
  readonly send: (target: Target, request: QuitGuardRequest) => boolean;
  /**
   * Calls `onGone` once the target can no longer answer: crashed, destroyed, navigated away.
   * May call it right away when that is already so. Returns the unsubscribe.
   */
  readonly watchGone: (target: Target, onGone: () => void) => () => void;
  readonly createRequestId?: () => string;
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}): QuitGuardRequester<Target> {
  const createRequestId = deps.createRequestId ?? (() => crypto.randomUUID());
  const startTimer = deps.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const stopTimer =
    deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const pending = new Map<
    string,
    {
      readonly target: Target;
      readonly kind: QuitGuardRequestBody["kind"];
      readonly settle: (outcome: QuitGuardRequestOutcome) => void;
    }
  >();

  return {
    request: (target, body, timeoutMs) =>
      new Promise<QuitGuardRequestOutcome>((resolve) => {
        const requestId = createRequestId();
        let settled = false;
        let timer: unknown = null;
        let unsubscribe: (() => void) | null = null;
        const settle = (outcome: QuitGuardRequestOutcome) => {
          if (settled) return;
          settled = true;
          pending.delete(requestId);
          if (timer !== null) stopTimer(timer);
          unsubscribe?.();
          resolve(outcome);
        };
        pending.set(requestId, { target, kind: body.kind, settle });
        const stopWatching = deps.watchGone(target, () => settle({ kind: "gone" }));
        if (settled) {
          stopWatching();
          return;
        }
        unsubscribe = stopWatching;
        timer = startTimer(() => settle({ kind: "timeout" }), timeoutMs);
        let sent = false;
        try {
          sent = deps.send(target, { ...body, requestId });
        } catch {
          sent = false;
        }
        if (!sent) settle({ kind: "send-failed" });
      }),
    receive: (sender, raw) => {
      const reply = parseQuitGuardReply(raw);
      if (reply === null) return;
      const entry = pending.get(reply.requestId);
      if (entry === undefined || entry.target !== sender || entry.kind !== reply.kind) return;
      entry.settle({ kind: "reply", reply });
    },
  };
}

// ── The window's report ────────────────────────────────────────────────

export type QuitRunningChats =
  | {
      readonly kind: "known";
      readonly runningCount: number;
      readonly resumableCount: number;
      readonly chats: ReadonlyArray<DesktopQuitRunningChat>;
      readonly otherNodesRunningCount: number;
      readonly continueThreadsAfterRestart: boolean | null;
    }
  | { readonly kind: "unknown" | "unavailable" | "invalid" };

type KnownQuitRunningChats = Extract<QuitRunningChats, { kind: "known" }>;

const CHAT_STATUSES: ReadonlySet<string> = new Set<DesktopQuitRunningChatStatus>([
  "working",
  "approval",
  "input",
  "connecting",
]);

function isChatStatus(value: unknown): value is DesktopQuitRunningChatStatus {
  return typeof value === "string" && CHAT_STATUSES.has(value);
}

function readCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Joiners that shape emoji and scripts; every other format character is dropped. */
const KEPT_FORMAT_CHARACTER = /^(?:\u200C|\u200D|[\u{E0020}-\u{E007F}])$/u;

/**
 * A chat title as a native dialog may show it: one line, no control or bidi/format characters
 * (an agent can name a chat, and reordered text must not disguise what a person agrees to), at
 * most 80 code points.
 */
export function sanitizeChatTitle(title: string): string {
  const oneLine = title
    .replace(/\p{Cs}/gu, "\uFFFD")
    .replace(/\p{Cf}/gu, (character) => (KEPT_FORMAT_CHARACTER.test(character) ? character : ""))
    .replace(/[\p{Cc}\u2028\u2029]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (oneLine.length === 0) return "Untitled chat";
  const codePoints = Array.from(oneLine);
  if (codePoints.length <= QUIT_DIALOG_TITLE_MAX_CHARS) return oneLine;
  return `${codePoints
    .slice(0, QUIT_DIALOG_TITLE_MAX_CHARS - 1)
    .join("")
    .trimEnd()}…`;
}

/** Main's reading of the window's answer; anything malformed reads as `invalid`. */
export function parseRunningChatsReport(raw: unknown): QuitRunningChats {
  if (!isRecord(raw)) return { kind: "invalid" };
  if (raw.status === "unknown") return { kind: "unknown" };
  if (raw.status === "unavailable") return { kind: "unavailable" };
  if (raw.status !== "known" || !Array.isArray(raw.chats)) return { kind: "invalid" };
  const runningCount = readCount(raw.runningCount);
  const otherNodesRunningCount = readCount(raw.otherNodesRunningCount);
  if (runningCount === null || otherNodesRunningCount === null) return { kind: "invalid" };
  const chats: DesktopQuitRunningChat[] = [];
  for (const entry of raw.chats.slice(0, MAX_REPORTED_CHAT_ENTRIES)) {
    if (chats.length >= QUIT_DIALOG_MAX_CHATS) break;
    if (!isRecord(entry) || typeof entry.threadId !== "string" || entry.threadId.length === 0) {
      continue;
    }
    chats.push({
      threadId: entry.threadId,
      title: sanitizeChatTitle(typeof entry.title === "string" ? entry.title : ""),
      // An unknown status is listed without a note, and never as one a restart continues.
      status: isChatStatus(entry.status) ? entry.status : "connecting",
    });
  }
  const running = Math.max(runningCount, chats.length);
  // Only the window knows which of its chats a restart can continue; without its count, none.
  const resumable = readCount(raw.resumableCount) ?? 0;
  return {
    kind: "known",
    runningCount: running,
    resumableCount: Math.min(resumable, running),
    chats,
    otherNodesRunningCount,
    continueThreadsAfterRestart:
      typeof raw.continueThreadsAfterRestart === "boolean" ? raw.continueThreadsAfterRestart : null,
  };
}

// ── The dialog ─────────────────────────────────────────────────────────

/** The `dialog.showMessageBox` options this module builds (no `electron` import here). */
export interface QuitDialogOptions {
  readonly type: "warning";
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly buttons: ReadonlyArray<string>;
  readonly defaultId: number;
  readonly cancelId: number;
  readonly noLink: true;
  readonly checkboxLabel?: string;
  readonly checkboxChecked?: boolean;
}

export interface QuitDialogPlan {
  readonly options: QuitDialogOptions;
  readonly quitResponse: number;
  /** The checkbox turns on "Continue after restart"; only offered while it is off. */
  readonly offersContinue: boolean;
}

const WAITING_SUFFIX: Partial<Record<DesktopQuitRunningChatStatus, string>> = {
  approval: " (waiting for your approval)",
  input: " (waiting for your answer)",
};

export function buildRunningChatsQuitDialog(input: {
  readonly appName: string;
  readonly report: KnownQuitRunningChats;
}): QuitDialogPlan {
  const { appName, report } = input;
  const running = report.runningCount;
  const resumable = report.resumableCount;
  const lines = [running === 1 ? "Quitting stops it:" : "Quitting stops them:"];
  for (const chat of report.chats) {
    lines.push(`• ${chat.title}${WAITING_SUFFIX[chat.status] ?? ""}`);
  }
  if (running > report.chats.length) lines.push(`• and ${running - report.chats.length} more`);
  if (report.otherNodesRunningCount > 0) lines.push("", "Chats on other nodes keep running.");

  // Only working chats can be continued after a restart, and the node still skips some of them
  // (a delegated task, a turn that used computer control...) for reasons no window sees: the
  // dialog promises a try. The setting is only ever turned on here.
  const settingOn = report.continueThreadsAfterRestart === true;
  const offersContinue = resumable > 0 && !settingOn;
  let checkboxLabel: string | undefined;
  if (resumable > 0) {
    const target =
      resumable === running
        ? running === 1
          ? "this chat"
          : "these chats"
        : resumable === 1
          ? "the chat that is working"
          : `the ${resumable} chats that are working`;
    // Named as waiting only when every chat that is not continued is listed and waits.
    const notWorking = report.chats.filter((chat) => chat.status !== "working");
    const notContinued =
      resumable === running
        ? ""
        : notWorking.length === running - resumable &&
            notWorking.every((chat) => WAITING_SUFFIX[chat.status] !== undefined)
          ? " Chats waiting for your approval or answer are not continued."
          : " Other chats are not continued.";
    lines.push(
      "",
      settingOn
        ? `If ${appName} starts again within ${CONTINUE_WINDOW_MINUTES} minutes, it tries to continue ${target} (“Continue after restart” in Settings).${notContinued}`
        : `If you check the box and ${appName} starts again within ${CONTINUE_WINDOW_MINUTES} minutes, it tries to continue ${target}. This turns on “Continue after restart” in Settings.${notContinued}`,
    );
    if (offersContinue) checkboxLabel = `Try to continue ${target} when ${appName} starts again`;
  }

  return {
    options: {
      type: "warning",
      title: `Quit ${appName}`,
      message:
        running === 1
          ? `Quit ${appName} while 1 chat is still running?`
          : `Quit ${appName} while ${running} chats are still running?`,
      detail: lines.join("\n"),
      buttons: ["Quit", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      ...(checkboxLabel === undefined ? {} : { checkboxLabel, checkboxChecked: false }),
    },
    quitResponse: 0,
    offersContinue,
  };
}

// ── The confirmation ───────────────────────────────────────────────────

export interface RunningChatsQuitConfirmation {
  /** `createQuitCleanupHandler`'s `confirm`. */
  readonly confirm: (signal: AbortSignal) => Promise<boolean> | null;
  /** Brings the window showing the dialog forward again; nothing while none shows. */
  readonly revealDialog: () => void;
}

/**
 * Asks before a quit only while chats on this desktop's own backend would stop. Every other
 * outcome (nothing running, the count unknown, no answer in time, the window gone) quits
 * without a dialog. Logs carry counts and outcomes (with a failed write's error), never titles.
 */
export function createRunningChatsQuitConfirmation<Target, Window>(deps: {
  /** The app window whose renderer can answer, or `null` when quitting stops nothing it shows. */
  readonly findTarget: () => { readonly window: Window; readonly contents: Target } | null;
  readonly requester: Pick<QuitGuardRequester<Target>, "request">;
  readonly showDialog: (
    window: Window,
    options: QuitDialogOptions,
    signal: AbortSignal,
  ) => Promise<{ readonly response: number; readonly checkboxChecked: boolean }>;
  readonly reveal: (window: Window) => void;
  readonly appName: string;
  readonly log: (line: string) => void;
  readonly now?: () => number;
}): RunningChatsQuitConfirmation {
  const now = deps.now ?? (() => performance.now());
  let dialogWindow: Window | null = null;

  const ask = async (
    target: { readonly window: Window; readonly contents: Target },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const startedAt = now();
    const outcome = await deps.requester.request(
      target.contents,
      { kind: "running-chats" },
      QUIT_RUNNING_CHATS_TIMEOUT_MS,
    );
    const report: QuitRunningChats =
      outcome.kind !== "reply"
        ? { kind: "unknown" }
        : outcome.reply.kind === "running-chats"
          ? parseRunningChatsReport(outcome.reply.report)
          : { kind: "invalid" };
    const status = outcome.kind === "reply" ? report.kind : outcome.kind;
    const elapsedMs = Math.round(now() - startedAt);
    deps.log(
      report.kind === "known"
        ? `quit confirmation: query status=known running=${report.runningCount} ms=${elapsedMs}`
        : `quit confirmation: query status=${status} ms=${elapsedMs}`,
    );
    if (report.kind !== "known" || report.runningCount === 0) return true;
    if (signal.aborted) return true;

    const plan = buildRunningChatsQuitDialog({ appName: deps.appName, report });
    deps.reveal(target.window);
    dialogWindow = target.window;
    let result: { readonly response: number; readonly checkboxChecked: boolean };
    try {
      result = await deps.showDialog(target.window, plan.options, signal);
    } finally {
      dialogWindow = null;
    }
    if (signal.aborted) {
      deps.log("quit confirmation: superseded by an urgent quit");
      return true;
    }
    if (result.response !== plan.quitResponse) {
      deps.log(`quit confirmation: cancelled running=${report.runningCount}`);
      return false;
    }
    if (plan.offersContinue && result.checkboxChecked) {
      const write = await deps.requester.request(
        target.contents,
        { kind: "continue-after-restart", enabled: true },
        QUIT_CONTINUE_SETTING_TIMEOUT_MS,
      );
      const written =
        write.kind === "reply" && write.reply.kind === "continue-after-restart"
          ? write.reply
          : null;
      const saved = written?.saved === true;
      const reason = saved
        ? ""
        : write.kind !== "reply"
          ? ` reason=${write.kind}`
          : ` reason=error${written?.error ? ` message=${written.error}` : ""}`;
      deps.log(`quit confirmation: continue-after-restart=on saved=${saved}${reason}`);
    }
    deps.log(`quit confirmation: quit running=${report.runningCount}`);
    return true;
  };

  return {
    confirm: (signal) => {
      const target = deps.findTarget();
      if (target === null) return null;
      return ask(target, signal);
    },
    revealDialog: () => {
      if (dialogWindow !== null) deps.reveal(dialogWindow);
    },
  };
}

// ── System shutdown ────────────────────────────────────────────────────

export interface SystemShutdownNotice {
  readonly mark: () => void;
  /** Whether a shutdown or logout notice arrived within the last `windowMs`. */
  readonly active: () => boolean;
}

export function createSystemShutdownNotice(
  options: { readonly windowMs?: number; readonly now?: () => number } = {},
): SystemShutdownNotice {
  const windowMs = options.windowMs ?? SYSTEM_SHUTDOWN_URGENT_MS;
  const now = options.now ?? (() => Date.now());
  let markedAt: number | null = null;
  return {
    mark: () => {
      markedAt = now();
    },
    active: () => markedAt !== null && now() - markedAt <= windowMs,
  };
}
