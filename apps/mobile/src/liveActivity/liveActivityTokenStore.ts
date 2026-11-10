/**
 * The update token of the agent Live Activity on screen, as iOS last gave it
 * (`onAgentActivityPushToken`), for background alerts to hand the Hub with the device's
 * registration (`docs/live-activity-push.md`). In memory: a relaunch reads the cards' tokens
 * again, and a card's end clears its token.
 */
const tokens = new Map<string, string>();
const listeners = new Set<() => void>();
let current: string | null = null;
/** The app's push-to-start token (iOS 17.2+), for a card the Hub starts when a task begins. */
let startToken: string | null = null;
/** iOS can start a card by push and the Hub does so: the setting for it is offered. */
let startOffered = false;

const HEX_TOKEN = /^[0-9a-f]{64,512}$/u;

function notify() {
  for (const listener of listeners) listener();
}

function emit() {
  const next = [...tokens.values()].at(-1) ?? null;
  if (next === current) return;
  current = next;
  notify();
}

/** A card's token; an empty one means the card ended. */
export function setLiveActivityPushToken(activityId: string, token: string): void {
  tokens.delete(activityId);
  if (HEX_TOKEN.test(token)) tokens.set(activityId, token);
  emit();
}

/** The push-to-start token iOS gave the app; anything but a hex token clears it. */
export function setLiveActivityPushToStartToken(token: string): void {
  const next = HEX_TOKEN.test(token) ? token : null;
  if (next === startToken) return;
  startToken = next;
  notify();
}

export function readLiveActivityPushToStartToken(): string | null {
  return startToken;
}

/** Whether the "start when a task begins" setting can do anything here. */
export function setLiveActivityStartOffered(offered: boolean): void {
  if (offered === startOffered) return;
  startOffered = offered;
  notify();
}

export function readLiveActivityStartOffered(): boolean {
  return startOffered;
}

/**
 * Forgets every token: push updates stop with the cards (sign-out ends them all), and the token
 * listener goes with them, so a card's end would never clear its token. The next start reads the
 * tokens of cards still on screen again.
 */
export function clearLiveActivityPushTokens(): void {
  tokens.clear();
  emit();
  setLiveActivityPushToStartToken("");
  setLiveActivityStartOffered(false);
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
  startToken = null;
  startOffered = false;
  listeners.clear();
}
