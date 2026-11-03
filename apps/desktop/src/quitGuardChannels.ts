import type { DesktopQuitGuardResponder, DesktopQuitRunningChatsReport } from "@ryco/contracts";

/**
 * Main asks a window, before a quit, which chats quitting would stop, and asks it to save
 * "Continue after restart". Shared by main and preload; type imports only, so the sandboxed
 * preload bundle needs nothing beyond `electron`.
 */
export const DESKTOP_QUIT_GUARD_IPC = {
  /** main → renderer: a `QuitGuardRequest`. */
  request: "desktop:quit-guard:request",
  /** renderer → main: a `QuitGuardReply`. */
  reply: "desktop:quit-guard:reply",
} as const;

export type QuitGuardRequestBody =
  | { readonly kind: "running-chats" }
  | { readonly kind: "continue-after-restart"; readonly enabled: boolean };

export type QuitGuardRequest = QuitGuardRequestBody & { readonly requestId: string };

/** `unavailable`: no responder in this window, or it failed. Main validates the rest. */
export type QuitGuardRunningChatsAnswer =
  | DesktopQuitRunningChatsReport
  | { readonly status: "unavailable" };

export type QuitGuardReply =
  | {
      readonly requestId: string;
      readonly kind: "running-chats";
      readonly report: QuitGuardRunningChatsAnswer;
    }
  | {
      readonly requestId: string;
      readonly kind: "continue-after-restart";
      readonly saved: boolean;
      /** Logged by main, never shown. */
      readonly error?: string;
    };

const MAX_REQUEST_ID_LENGTH = 128;
/** Characters of a failed write's error that a reply carries, and that main keeps. */
export const MAX_REPLY_ERROR_LENGTH = 200;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isQuitGuardRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_REQUEST_ID_LENGTH;
}

export function parseQuitGuardRequest(raw: unknown): QuitGuardRequest | null {
  if (!isRecord(raw) || !isQuitGuardRequestId(raw.requestId)) return null;
  if (raw.kind === "running-chats") return { requestId: raw.requestId, kind: "running-chats" };
  if (raw.kind === "continue-after-restart" && typeof raw.enabled === "boolean") {
    return { requestId: raw.requestId, kind: "continue-after-restart", enabled: raw.enabled };
  }
  return null;
}

function describeReplyError(error: unknown): string {
  const message =
    isRecord(error) && typeof error.message === "string" ? error.message : String(error);
  return message.length > MAX_REPLY_ERROR_LENGTH
    ? message.slice(0, MAX_REPLY_ERROR_LENGTH)
    : message;
}

/**
 * The preload's answer to one request. No responder, or a throwing one: `unavailable` /
 * `saved: false`, so main can quit at once instead of waiting out its timeout. A malformed
 * request gets no answer (`null`).
 */
export async function answerQuitGuardRequest(
  responder: DesktopQuitGuardResponder | null,
  raw: unknown,
): Promise<QuitGuardReply | null> {
  const request = parseQuitGuardRequest(raw);
  if (request === null) return null;
  const { requestId } = request;
  if (request.kind === "running-chats") {
    let report: QuitGuardRunningChatsAnswer = { status: "unavailable" };
    if (responder !== null) {
      try {
        report = responder.runningChats();
      } catch {
        report = { status: "unavailable" };
      }
    }
    return { requestId, kind: "running-chats", report };
  }
  if (responder === null) {
    return { requestId, kind: "continue-after-restart", saved: false, error: "unavailable" };
  }
  try {
    await responder.setContinueAfterRestart(request.enabled);
    return { requestId, kind: "continue-after-restart", saved: true };
  } catch (error) {
    return {
      requestId,
      kind: "continue-after-restart",
      saved: false,
      error: describeReplyError(error),
    };
  }
}
