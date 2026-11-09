// FILE: copyDestinationMemory.ts
// Purpose: The web's copy destination memory: the shared one
//          (`@ryco/client-runtime/projectCopy/destinationMemory`) kept through
//          `getLocalStorageItem`, so hosted builds keep it in this window's
//          memory only (the app's rule for anything with paths). The copy
//          dialog preselects it; the copy prefetch warms that node first.
// Layer: Web UI state, loaded with the copy dialog and the copy prefetch.

import {
  COPY_DESTINATIONS_STORAGE_KEY,
  createCopyDestinationMemory,
  RememberedCopyDestinations,
} from "@ryco/client-runtime/projectCopy/destinationMemory";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

export {
  COPY_DESTINATIONS_STORAGE_KEY,
  type RememberedCopyDestination,
} from "@ryco/client-runtime/projectCopy/destinationMemory";

const memory = createCopyDestinationMemory({
  read: () => getLocalStorageItem(COPY_DESTINATIONS_STORAGE_KEY, RememberedCopyDestinations),
  write: (entries) =>
    setLocalStorageItem(COPY_DESTINATIONS_STORAGE_KEY, entries, RememberedCopyDestinations),
});

export const readRememberedCopyDestination = memory.read;
export const rememberCopyDestination = memory.remember;
