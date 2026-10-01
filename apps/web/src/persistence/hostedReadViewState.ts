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
  hostedScrollPositions.delete(key);
  hostedScrollPositions.set(key, position);
  if (hostedScrollPositions.size > 64)
    hostedScrollPositions.delete(hostedScrollPositions.keys().next().value!);
  changed();
}
