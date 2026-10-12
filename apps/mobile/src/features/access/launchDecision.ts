/**
 * Launch-time hand-off between the native splash and the access gate.
 *
 * The splash used to hide as soon as appearance preferences hydrated, and the
 * gate, still waiting on its planes, then showed a second (JS) logo before the
 * workspace: splash → logo → content. The gate now reports the moment it
 * leaves `hydrating`, and the splash stays up until then — bounded, so a slow
 * decision still falls back to the gate's own launch surface.
 */

/** How long the splash may outlast preference hydration while the gate decides. */
export const SPLASH_ACCESS_DECISION_WAIT_MS = 800;

/**
 * How long the gate waits for the hosted plane's launch check before deciding
 * without it. A stalled Hub request otherwise holds the launch surface for its
 * whole request deadline; the shared runtime keeps checking in the background
 * and the gate unlocks the moment the session is revalidated.
 */
export const HOSTED_LAUNCH_DECISION_DEADLINE_MS = 8_000;

let decided = false;
const listeners = new Set<() => void>();

export function markAppAccessDecided(): void {
  if (decided) return;
  decided = true;
  for (const listener of Array.from(listeners)) listener();
}

export function isAppAccessDecided(): boolean {
  return decided;
}

export function subscribeAppAccessDecided(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function shouldHideLaunchSplash(input: {
  readonly preferencesReady: boolean;
  readonly accessDecided: boolean;
  readonly decisionWaitElapsed: boolean;
}): boolean {
  return input.preferencesReady && (input.accessDecided || input.decisionWaitElapsed);
}

/** Test seam. */
export function resetAppAccessDecisionForTests(): void {
  decided = false;
  listeners.clear();
}
