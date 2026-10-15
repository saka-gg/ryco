// A small presentation seam; importing the timeline must not initialize hosted auth.
export const hostedScrollPositions = new Map<string, number>();
let changed: (() => void) | null = null;
export function configureHostedReadViewState(onChange: (() => void) | null): void {
  changed = onChange;
}
export function readHostedThreadScroll(key: string): number | undefined {
  return hostedScrollPositions.get(key);
}
export function saveHostedThreadScroll(key: string, position: number): void {
  if (!changed || !Number.isFinite(position) || position < 0) return;
  // The timeline re-reports its position on every streaming render; an
  // unchanged one has nothing new to save, but still counts as a recent visit.
  const unchanged = hostedScrollPositions.get(key) === position;
  hostedScrollPositions.delete(key);
  hostedScrollPositions.set(key, position);
  if (unchanged) return;
  if (hostedScrollPositions.size > 64)
    hostedScrollPositions.delete(hostedScrollPositions.keys().next().value!);
  changed();
}
