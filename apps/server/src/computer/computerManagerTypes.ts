/**
 * Types `ComputerManager` exposes or keeps per thread.
 */
import {
  ComputerPoint,
  ComputerScreenSize,
  type ComputerAvailability,
  type ComputerEvent,
  type ComputerScreenshot,
  type ComputerWindow,
  type ThreadComputerState,
} from "@ryco/contracts";
import type { FrameTransport } from "@ryco/shared/frameTransport";
import type { ComputerBackend, ComputerStreamFrame } from "./ComputerBackend.ts";

export type ComputerEventListener = (event: ComputerEvent) => void;

export interface ThreadComputerRuntimeState {
  version: number;
  lastError: string | null;
  /**
   * An error reported by a caller (stream attach, device surface), not by
   * the physical read — `publishNow` owns `lastError` and would erase it.
   * The next publish carries it in the snapshot's `lastError` slot, then it
   * is consumed and cleared.
   */
  reportedError: string | null;
  inputPause?: NonNullable<ThreadComputerState["inputPause"]>;
  windows: readonly ComputerWindow[];
  screenSize: ComputerScreenSize;
  availability: ComputerAvailability;
  cursor?: ComputerPoint;
  /**
   * Whether this thread's agent activity has already asked the UI to open the
   * computer pane. Actions arrive every few seconds, so surfacing is once per
   * thread: repeating the request would emit an event per click and could yank
   * a user who deliberately closed the pane back to it.
   */
  paneSurfaced: boolean;
}

export interface ComputerManagerOptions {
  readonly backend: ComputerBackend;
  readonly controlStatePath?: string;
  /**
   * Where the mutating-call audit log appends — beside the control state in
   * the server state dir. Absent means no audit file: tests and in-memory
   * embeddings get the same behavior the feature had before it existed.
   */
  readonly auditLogPath?: string;
  readonly transport?: FrameTransport<string, ComputerStreamFrame>;
  /** Injected for tests; the lease is the only clock-dependent state here. */
  readonly now?: () => number;
  readonly leaseIdleMs?: number;
  /** How long a conflicting lease claim waits; defaults to `COMPUTER_LEASE_WAIT_MS`. */
  readonly leaseWaitMs?: number;
  /** Injected for tests, so action-screenshot tests do not sleep for real. */
  readonly actionSettleMs?: number;
  /** Injected for tests, so window-churn tests do not wait out the real window. */
  readonly windowsPublishDebounceMs?: number;
  /** Injected for tests; decodes and correlates two PNG captures. */
  readonly measureScrollTravel?: (
    before: Uint8Array,
    after: Uint8Array,
  ) => number | undefined | Promise<number | undefined>;
}

/**
 * The click variants `computer_click` folds into one call: which button, and
 * how many presses. The driver exposes left x1-3 and a single right click;
 * every other combination is refused before a target is even resolved.
 */
export interface ComputerClickGesture {
  readonly count?: 1 | 2 | 3;
  readonly button?: "left" | "right" | "middle";
}

/** A capture plus which window it covers, when it covers one at all. */
export interface ComputerCapturedWindow {
  readonly screenshot: ComputerScreenshot;
  readonly windowId?: string;
}

/** The action's captured window, or confirmation that it closed. */
export type ComputerActionObservation =
  | ComputerCapturedWindow
  | { readonly targetWindowClosed: true };

/** Whether the window found frontmost before an activation was put back. */
export type ForegroundRestoreStatus =
  | "restored"
  | "restore-missed"
  | "already-frontmost"
  | "frontmost-unobservable";

/** Which window a foreground excursion restored, and whether that succeeded. */
export interface ForegroundRestoreInfo {
  readonly restoredWindowId: string | null;
  readonly restoreStatus: ForegroundRestoreStatus;
}
