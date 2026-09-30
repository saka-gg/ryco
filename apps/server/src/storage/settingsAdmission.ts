let settingsLeases = 0;
let settingsRevision = 0;
let settingsUpdates = 0;
const leases = new WeakMap<object, { assertValid: () => void }>();
declare const settingsLeaseBrand: unique symbol;
export interface StorageSettingsLease {
  readonly [settingsLeaseBrand]: true;
  readonly assertValid: () => void;
  readonly release: () => void;
}
export const hasStorageSettingsUpdateLease = () => settingsUpdates > 0;
/** Called under lifecycle admission, before any settings/secret-store effects. */
export const acquireStorageSettingsUpdateLease = () => {
  if (settingsLeases > 0) throw new Error("Cleanup owns settings admission.");
  settingsUpdates++;
  let released = false;
  return () => {
    if (!released) settingsUpdates--;
    released = true;
  };
};
export const assertStorageSettingsLease = (lease: StorageSettingsLease) => {
  const active = leases.get(lease);
  if (!active) throw new Error("A valid active settings admission lease is required.");
  active.assertValid();
};
/** Called under admission. Freeze only relevant settings while bounded removal runs,
 * not scans, preview, provider callbacks or turns. External watcher changes invalidate it. */
export const acquireStorageSettingsLease = () => {
  if (settingsUpdates > 0)
    throw new Error("Settings update is in progress; cleanup admission is refused.");
  settingsLeases++;
  const revision = settingsRevision;
  let released = false;
  const lease = Object.freeze({
    assertValid: () => {
      if (released || revision !== settingsRevision)
        throw new Error("Settings changed during cleanup; remaining data is protected.");
    },
    release: () => {
      if (!released) settingsLeases--;
      released = true;
    },
  }) as StorageSettingsLease;
  leases.set(lease, { assertValid: lease.assertValid });
  return lease;
};
export const hasStorageSettingsLease = () => settingsLeases > 0;
export const noteStorageSettingsChange = () => {
  settingsRevision++;
};
