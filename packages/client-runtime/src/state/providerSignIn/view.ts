import type { ProviderSignInState } from "@ryco/contracts";

import {
  isProviderSignInRunning,
  PROVIDER_SIGN_IN_FORBIDDEN,
  type ProviderSignInSnapshot,
} from "./controller.ts";

export interface ProviderSignInViewInput {
  /** What the instance's controller holds; `null` without one. */
  readonly snapshot: ProviderSignInSnapshot | null;
  /** The node's state as this surface follows it; `null` while it does not follow. */
  readonly state: ProviderSignInState | null;
  readonly nodeLabel: string;
  /** Why this session may not sign in on the node, from its connection's capability. */
  readonly blockedReason: string | null;
  /** Whether the app holds a connection to the node, with its sign-in methods. */
  readonly connected: boolean;
  /** Whether this session may change the node's providers. */
  readonly canManage: boolean;
  /** The instance's own enabled flag, which a toggle changes before the node re-probes. */
  readonly instanceEnabled: boolean;
}

/** What a sign-in surface offers, the same on every client. */
export interface ProviderSignInView {
  readonly running: boolean;
  readonly pending: ProviderSignInSnapshot["pending"];
  /** Why nothing can be started or followed here now. */
  readonly unavailable: string | null;
  /** Following failed before the node reported anything: trying again follows it anew. */
  readonly followFailed: boolean;
  readonly canRetryFollow: boolean;
  readonly canStart: boolean;
  readonly canCancel: boolean;
  readonly startLabel: "Sign in" | "Try again";
  /** Why the last thing this client did failed, unless nothing can be done anyway. */
  readonly error: string | null;
}

/**
 * Decides what a sign-in surface offers from the controller's snapshot and the session's access.
 * The first reason nothing can be done wins: the connection's capability, the connection itself,
 * the session's role, a node without sign-in, then a disabled instance.
 */
export function describeProviderSignIn(input: ProviderSignInViewInput): ProviderSignInView {
  const { snapshot, state, nodeLabel } = input;
  const running = isProviderSignInRunning(state);
  const pending = snapshot?.pending ?? null;
  const unavailable =
    input.blockedReason ??
    (!input.connected
      ? `Available when ${nodeLabel} is connected`
      : !input.canManage || snapshot?.forbidden
        ? PROVIDER_SIGN_IN_FORBIDDEN
        : snapshot?.unsupported
          ? `Update Ryco on ${nodeLabel} to sign in from here.`
          : !input.instanceEnabled
            ? "Enable this provider instance to sign in."
            : null);
  const followFailed = state === null && (snapshot?.error ?? null) !== null;
  return {
    running,
    pending,
    unavailable,
    followFailed,
    canRetryFollow: unavailable === null && followFailed && pending === null,
    canStart:
      unavailable === null &&
      state !== null &&
      !running &&
      pending === null &&
      (state.phase !== "idle" || state.method !== null),
    canCancel: running && unavailable === null && pending === null && state?.phase !== "verifying",
    startLabel:
      followFailed ||
      state?.phase === "failed" ||
      state?.phase === "expired" ||
      state?.phase === "cancelled"
        ? "Try again"
        : "Sign in",
    error: unavailable === null ? (snapshot?.error ?? null) : null,
  };
}

/** What to say about a flow that failed, expired or was cancelled. */
export function providerSignInOutcome(state: ProviderSignInState): string {
  return (
    state.message ??
    (state.phase === "expired"
      ? "The sign-in expired. Start again."
      : state.phase === "cancelled"
        ? "Sign-in cancelled."
        : "The sign-in failed. Try again.")
  );
}

/** `m:ss` until `expiresAt`, or `null` once it passed or when it does not parse. */
export function formatProviderSignInCountdown(
  expiresAt: string | null,
  nowMs: number,
): string | null {
  const remainingMs = expiresAt === null ? Number.NaN : Date.parse(expiresAt) - nowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  const totalSeconds = Math.ceil(remainingMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Whether a page a sign-in names may open on this device: `https:` only. */
export function isProviderSignInPageUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
