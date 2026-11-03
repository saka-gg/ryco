/** IPC channels of thread notifications and the badge, shared by the preload bridge and main. */
export const THREAD_NOTIFICATION_IPC = {
  notify: "desktop:notify-thread",
  activated: "desktop:thread-notification-activated",
  setBadge: "desktop:set-notification-badge",
  badgeCleared: "desktop:notification-badge-cleared",
} as const;
