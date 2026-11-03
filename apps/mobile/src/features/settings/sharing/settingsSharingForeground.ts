/**
 * Runs shared device settings while the app is in the foreground and stops them in the
 * background: the phone never polls or writes from the background. As `appLifecycle`, only
 * `background` counts as leaving: iOS reports `inactive` for system sheets and the app switcher
 * while the app and its sockets keep running.
 */
export interface SettingsSharingAppState {
  /** Whether the app is in the foreground now. */
  readonly isForeground: () => boolean;
  /** Calls the listener with each foreground change. */
  readonly subscribe: (listener: (foreground: boolean) => void) => () => void;
}

/** Starts `start` while the app is in the foreground; the returned function ends it all. */
export function runSettingsSharingInForeground(
  appState: SettingsSharingAppState,
  start: () => () => void,
): () => void {
  let stop: (() => void) | null = null;
  const follow = (foreground: boolean) => {
    if (foreground && stop === null) stop = start();
    else if (!foreground && stop !== null) {
      stop();
      stop = null;
    }
  };
  follow(appState.isForeground());
  const unsubscribe = appState.subscribe(follow);
  return () => {
    unsubscribe();
    follow(false);
  };
}
