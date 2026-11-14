/**
 * The desktop lease's pure parts: lanes, lease scopes and their conflicts, the wait helpers, and
 * the refusal raised when a claim waited too long. `ComputerManager` owns the lease state itself.
 */
import type { ComputerLaneClaim } from "@ryco/shared/computerLanes";
import { ComputerBackendError } from "./ComputerBackend.ts";
import { ComputerTargetError } from "./uiTreeTargeting.ts";

/**
 * Crash backstop for the desktop lease, not the normal release path.
 *
 * Foreground input, clipboard and complete gestures share one exclusive
 * desktop lease. A backend proving exact background delivery instead owns
 * its application's keyboard/modal state, or one window for pure semantic
 * writes. Unrelated applications can progress between atomic native actions.
 * Ownership is released the moment the owner's turn ends
 * (`releaseDesktopControl`, driven by the provider
 * runtime's terminal turn and session events), because a takeover mid-turn
 * corrupts the owner: its drag is teleported, its typing is retargeted. Idle
 * expiry only covers the case where that signal never arrives — a provider
 * process that died without a terminal event — and so is deliberately long: a
 * model can think for minutes between two tool calls, and expiring under a live
 * turn is the failure this whole mechanism exists to prevent. Five minutes
 * leaves a long-running model's legitimate thinking time undisturbed.
 */
export const COMPUTER_LEASE_IDLE_MS = 300_000;

/**
 * How long a conflicting claim waits for another conversation's lease (an app,
 * a window, or the whole desktop) before it gives up. Waiters queue FIFO per
 * target and hold no operation lane while they wait, so the owner keeps
 * working. Stop, a revoked turn or shutdown end the wait at once.
 */
export const COMPUTER_LEASE_WAIT_MS = 45_000;

/**
 * Which lane one agent tool call runs in (see `@ryco/shared/computerLanes`):
 * observation runs beside everything except whole-desktop work, background
 * input to one app runs beside other apps, and everything else holds the
 * whole desktop. A string is a scoped key (`runScoped`).
 */
export type ComputerAgentLane =
  | { readonly kind: "read" }
  | { readonly kind: "exclusive" }
  | { readonly kind: "app"; readonly pid: number }
  | { readonly kind: "scoped"; readonly key: string };

/** Pure observation tools: they read the desktop and send no input. */
export const COMPUTER_READ_LANE_TOOLS: ReadonlySet<string> = new Set([
  "computer_get_state",
  "computer_screenshot",
  "computer_get_accessibility_tree",
  "computer_list_windows",
  "computer_list_apps",
  "computer_get_screen_size",
  "computer_verify_state",
  "computer_zoom",
  "computer_get_cursor_position",
  "computer_wait",
  "computer_help",
]);

/**
 * Plain single-target input that, delivered in the background to an exact
 * window, touches only that window's application. Drag, paste and clipboard,
 * launch, window frame/visibility, kill, menus, batches and Space tools stay
 * whole-desktop.
 */
export const COMPUTER_APP_LANE_TOOLS: ReadonlySet<string> = new Set([
  "computer_click",
  "computer_move_cursor",
  "computer_scroll",
  "computer_type_text",
  "computer_press_key",
  "computer_set_value",
  "computer_select_text",
  "computer_perform_action",
]);

/** The pid a Cua window id (`cua:<pid>:<window>`) names, if it names one. */
export function pidFromWindowId(windowId: string): number | undefined {
  const match = /^cua:(\d+):/.exec(windowId);
  const pid = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** The application an operation's held lanes reserve exclusively, if any. */
export function heldAppLanePid(
  claims: readonly ComputerLaneClaim[] | undefined,
): number | undefined {
  if (!claims) return undefined;
  for (const claim of claims) {
    if (claim.mode !== "exclusive") continue;
    const match = /^app:(\d+)$/.exec(claim.resource);
    if (match) return Number(match[1]);
  }
  return undefined;
}

/**
 * Inside an application's lane the resolved target must be that application:
 * a window that now belongs to another process is refused before dispatch.
 */
export function assertScheduledApp(
  scheduledPid: number | undefined,
  pid: number | undefined,
): void {
  if (scheduledPid === undefined || pid === scheduledPid) return;
  throw new ComputerTargetError({
    code: "computer_target_invalid",
    message:
      "The target changed: the window no longer belongs to the application this call was " +
      "scheduled for; nothing was sent. Observe again with computer_get_state.",
  });
}

/** A one-shot deadline for a lease wait; `expired` flips when it fires. */
export function leaseDeadline(ms: number): {
  expired: boolean;
  readonly promise: Promise<void>;
  cancel(): void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = {
    expired: false,
    promise: undefined as unknown as Promise<void>,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
  deadline.promise = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      deadline.expired = true;
      resolve();
    }, ms);
  });
  return deadline;
}

/**
 * Sleep until a lease changes, the conflicting lease would go stale, or the
 * wait's deadline passes; rejects with the signal's reason on abort.
 */
export function sleepForLease(
  changed: Promise<void>,
  deadline: Promise<void>,
  expiryDelayMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (expiry !== undefined) clearTimeout(expiry);
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onAbort = () => finish(signal?.reason ?? new Error("The lease wait was cancelled."));
    signal?.addEventListener("abort", onAbort, { once: true });
    // A few ms past the idle limit, so the re-check sees the lease as stale.
    if (expiryDelayMs !== undefined) expiry = setTimeout(() => finish(), expiryDelayMs + 5);
    void changed.then(() => finish());
    void deadline.then(() => finish());
  });
}

/** The single desktop's exclusive owner, and when it last drove it. */
export interface DesktopLease {
  readonly threadId: string;
  readonly turnId?: string;
  lastActivityMs: number;
  releaseRequested?: boolean;
  /** The turn the deferred release was requested for — a renewed lease ignores it. */
  releaseRequestedTurnId?: string | undefined;
}

/** Semantic writes own a window; keyboard and modal state belong to its process. */
export interface BackgroundControlTarget {
  readonly key: string;
  readonly pid?: number;
  readonly windowId?: string;
}

export interface BackgroundLease extends DesktopLease {
  readonly target: BackgroundControlTarget;
}

/** What a lease claim needs: the whole desktop, or one app/window target. */
export type LeaseScope =
  | { readonly kind: "desktop" }
  | { readonly kind: "target"; readonly target: BackgroundControlTarget };

export interface LeaseWaiter {
  readonly owner: string;
  scope: LeaseScope;
}

/** The live lease a claim conflicts with. */
export interface LeaseConflict {
  readonly targetOnly: boolean;
  /** The contested app or window, for the timeout message. */
  readonly label?: string;
  /** When the conflicting lease goes stale, if nothing of its owner is in flight. */
  readonly expiresAtMs?: number;
}

export function leaseChangeSignal(): {
  readonly promise: Promise<void>;
  readonly fire: () => void;
} {
  let fire = () => {};
  const promise = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { promise, fire };
}

/** Whether two background targets touch the same app keyboard or window. */
export function backgroundTargetsConflict(
  a: BackgroundControlTarget,
  b: BackgroundControlTarget,
): boolean {
  if (a.key === b.key) return true;
  return a.pid !== undefined && a.pid === b.pid && (!a.windowId || !b.windowId);
}

export function leaseScopesConflict(a: LeaseScope, b: LeaseScope): boolean {
  if (a.kind === "desktop" || b.kind === "desktop") return true;
  return backgroundTargetsConflict(a.target, b.target);
}

/**
 * Refusal raised when another conversation kept an application, a window or
 * the whole desktop for longer than a conflicting claim may wait
 * (`COMPUTER_LEASE_WAIT_MS`). It extends `ComputerBackendError` so every
 * existing catch site keeps classifying it. Nothing was sent, and the call is
 * retryable: the other conversation keeps its lease only until its turn ends.
 * The message names the contested app or window when it is known, never the
 * other conversation (thread labels do not cross conversations).
 */
export class ComputerLeaseError extends ComputerBackendError {
  readonly code = "computer_controlled_by_other_thread";
  /** How long the refused claim waited before giving up. */
  readonly waitedMs: number;

  constructor(
    input: {
      /** An app or window lease, rather than the whole desktop. */
      readonly targetOnly?: boolean;
      /** The contested app or window, when known (e.g. "Safari"). */
      readonly target?: string;
      readonly waitedMs?: number;
    } = {},
  ) {
    const waitedMs = Math.max(0, input.waitedMs ?? 0);
    const subject = input.target
      ? `${JSON.stringify(input.target)} is`
      : input.targetOnly
        ? "This application or window is"
        : "The shared pointer and focused keyboard are";
    const waited = waitedMs > 0 ? `waited ${Math.round(waitedMs / 1000)} s and ` : "";
    super(
      `${subject} being used by another conversation; ${waited}no input was sent. ` +
        "That conversation keeps it until its turn ends. Retry later, or work on another " +
        "application meanwhile; reading the desktop still works. Do not switch tools to " +
        "bypass the lease.",
      { retryable: true },
    );
    this.name = "ComputerLeaseError";
    this.waitedMs = waitedMs;
  }
}

/**
 * The caller as an agent thread, or undefined for desktop input that belongs to
 * no thread — the human at the computer pane. Attribution and the desktop lease
 * must agree on who that is, so both read it here.
 */
export function agentThreadId(threadId: string | undefined): string | undefined {
  const trimmed = threadId?.trim();
  return trimmed ? trimmed : undefined;
}
