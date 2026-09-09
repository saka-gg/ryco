let available = false;
type UnavailableReason = "device-security" | "credential-storage";
let unavailableReason: UnavailableReason | null = null;
const listeners = new Set<() => void>();

/** Side-effect-free hosted availability projection for screens and state bindings. */
export function isMobileHostedModeAvailable(): boolean {
  return available;
}

export function getMobileHostedUnavailableReason(): UnavailableReason | null {
  return unavailableReason;
}

export function subscribeMobileHostedModeAvailability(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Runtime-owned writer; kept separate so importing screen state loads no native adapter. */
export function setMobileHostedModeAvailable(
  next: boolean,
  reason: UnavailableReason | null = null,
): void {
  const nextReason = next ? null : reason;
  if (available === next && unavailableReason === nextReason) return;
  available = next;
  unavailableReason = nextReason;
  for (const listener of listeners) listener();
}
