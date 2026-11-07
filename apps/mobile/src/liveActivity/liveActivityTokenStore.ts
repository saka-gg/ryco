/**
 * The update token of the agent Live Activity on screen, as iOS last gave it
 * (`onAgentActivityPushToken`), for background alerts to hand the Hub with the device's
 * registration (`docs/live-activity-push.md`). In memory: a relaunch reads the cards' tokens
 * again, and a card's end clears its token.
 */
const tokens = new Map<string, string>();
const listeners = new Set<() => void>();
let current: string | null = null;

function emit() {
  const next = [...tokens.values()].at(-1) ?? null;
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

/** A card's token; an empty one means the card ended. */
export function setLiveActivityPushToken(activityId: string, token: string): void {
  tokens.delete(activityId);
  if (/^[0-9a-f]{64,512}$/u.test(token)) tokens.set(activityId, token);
  emit();
}

/**
 * Forgets every token: push updates stop with the cards (sign-out ends them all), and the token
 * listener goes with them, so a card's end would never clear its token. The next start reads the
 * tokens of cards still on screen again.
 */
export function clearLiveActivityPushTokens(): void {
  tokens.clear();
  emit();
}

/** The newest card's token, or null while no card takes push updates. */
export function readLiveActivityPushToken(): string | null {
  return current;
}

export function subscribeLiveActivityPushToken(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam. */
export function resetLiveActivityPushTokensForTests(): void {
  tokens.clear();
  current = null;
  listeners.clear();
}
