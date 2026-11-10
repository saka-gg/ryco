import type { EnvironmentId, TerminalRef } from "@ryco/contracts";

/**
 * Which terminals this client shows, per environment: counted holds taken by the surfaces that
 * show a terminal (the web drawer, the phone terminal screen, a script run waiting for a prompt).
 * Kept per environment rather than per connection, so a connection that replaces another (a
 * reconnect with a new client, a new hosted session) names the same terminals on its first
 * subscription without the surfaces doing anything.
 */
const holdsByEnvironment = new Map<
  string,
  Map<string, { readonly ref: TerminalRef; count: number }>
>();
const releaseListeners = new Set<(environmentId: string, ref: TerminalRef) => void>();

const refKey = (ref: TerminalRef) => JSON.stringify([ref.threadId, ref.terminalId]);

/** Holds `ref` of `environmentId` until the returned release (idempotent). */
export function holdTerminalOutput(
  environmentId: EnvironmentId | string,
  ref: TerminalRef,
): () => void {
  let holds = holdsByEnvironment.get(environmentId);
  if (!holds) {
    holds = new Map();
    holdsByEnvironment.set(environmentId, holds);
  }
  const key = refKey(ref);
  const entry = holds.get(key);
  if (entry) entry.count += 1;
  else holds.set(key, { ref: { threadId: ref.threadId, terminalId: ref.terminalId }, count: 1 });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = holdsByEnvironment.get(environmentId)?.get(key);
    if (!current) return;
    current.count -= 1;
    if (current.count > 0) return;
    const remaining = holdsByEnvironment.get(environmentId);
    remaining?.delete(key);
    if (remaining?.size === 0) holdsByEnvironment.delete(environmentId);
    for (const listener of [...releaseListeners]) listener(environmentId, current.ref);
  };
}

export function isTerminalOutputHeld(
  environmentId: EnvironmentId | string,
  ref: TerminalRef,
): boolean {
  return holdsByEnvironment.get(environmentId)?.has(refKey(ref)) ?? false;
}

export function readTerminalOutputHolds(environmentId: EnvironmentId | string): TerminalRef[] {
  return [...(holdsByEnvironment.get(environmentId)?.values() ?? [])].map((entry) => entry.ref);
}

/** Runs when the last hold of a terminal goes. */
export function subscribeTerminalOutputReleases(
  listener: (environmentId: string, ref: TerminalRef) => void,
): () => void {
  releaseListeners.add(listener);
  return () => {
    releaseListeners.delete(listener);
  };
}
