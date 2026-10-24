/**
 * Thread alerts the desktop renderer hands to the main process: the OS
 * notification for a thread and the count badge on the dock or taskbar. Main
 * decodes both, since they cross the IPC boundary (subpath
 * `@ryco/contracts/desktop-notifications`).
 *
 * @module desktopNotifications
 */
import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Longest notification body main shows; the renderer shortens longer thread titles. */
export const DESKTOP_THREAD_NOTIFICATION_BODY_MAX_LENGTH = 240;

/** Largest Windows taskbar overlay image, as a PNG data URL. */
const BADGE_IMAGE_MAX_LENGTH = 16_384;

export const DesktopThreadNotification = Schema.Struct({
  threadId: ThreadId,
  environmentId: EnvironmentId,
  /** One notification per thread: a newer one with the same tag replaces it. */
  tag: Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/)),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  body: Schema.String.check(Schema.isMaxLength(DESKTOP_THREAD_NOTIFICATION_BODY_MAX_LENGTH)),
});
export type DesktopThreadNotification = typeof DesktopThreadNotification.Type;

/**
 * `window-focused`: the window is in front (an embedded page can hold the
 * document's focus), so the renderer alerts in the app instead.
 */
export const DesktopThreadNotificationResult = Schema.Literals([
  "shown",
  "window-focused",
  "unsupported",
]);
export type DesktopThreadNotificationResult = typeof DesktopThreadNotificationResult.Type;

/** The threads that alerted while Ryco was in the background; 0 clears the badge. */
export const DesktopNotificationBadge = Schema.Struct({
  count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9_999 })),
  /** The Windows taskbar overlay; other platforms show the count themselves. */
  image: Schema.NullOr(
    Schema.String.check(
      Schema.isMaxLength(BADGE_IMAGE_MAX_LENGTH),
      Schema.isPattern(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/),
    ),
  ),
});
export type DesktopNotificationBadge = typeof DesktopNotificationBadge.Type;
