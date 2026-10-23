import type {
  DesktopAppSnapCapture,
  DesktopAppSnapPermission,
  DesktopAppSnapPermissionKind,
  DesktopAppSnapShortcut,
  DesktopAppSnapShortcutAvailability,
} from "./computerPermissions.ts";

/**
 * Composer window capture in the macOS desktop app: the attachment menu's
 * window list and an optional global shortcut, both feeding the focused
 * composer. Independent of the Computer Use beta; the two share macOS grants
 * because they run the same signed helper inside this app.
 */
export interface DesktopWindowCaptureState {
  readonly supported: boolean;
  /** The global capture shortcut, or null while it is off (the default). */
  readonly shortcut: DesktopAppSnapShortcut | null;
  readonly screenRecordingPermission: DesktopAppSnapPermission;
  readonly inputMonitoringPermission: DesktopAppSnapPermission;
  /**
   * Grants the current setup still lacks: Screen Recording for any capture,
   * plus Input Monitoring while the shortcut is both Option keys.
   */
  readonly missingPermissions: readonly DesktopAppSnapPermissionKind[];
  /** Why capture or the shortcut cannot run right now. */
  readonly message: string | null;
  /** Name macOS shows for this build in System Settings permission lists. */
  readonly appDisplayName: string;
}

export interface DesktopWindowCaptureShortcutResult {
  readonly state: DesktopWindowCaptureState;
  readonly availability: DesktopAppSnapShortcutAvailability;
}

/** A capture waiting for a composer, without its image bytes. */
export type DesktopWindowCapturePendingEntry = Omit<DesktopAppSnapCapture, "bytes">;
