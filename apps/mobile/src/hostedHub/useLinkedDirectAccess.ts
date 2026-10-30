import type { HostedHubNode } from "@ryco/client-runtime/authorization";
import { useStore } from "zustand";

import {
  mobileLinkedDirectAccessStore,
  type MobileLinkedDirectAccessUiState,
} from "./linkedDirectAccessState";

/** Linked direct access as the Hub machine rows show it. */
export function useMobileLinkedDirectAccess(): MobileLinkedDirectAccessUiState {
  return useStore(mobileLinkedDirectAccessStore);
}

/** "Add direct access": the route code loads on first use, never with the app. */
export function addMobileDirectAccessLazily(node: HostedHubNode): Promise<void> {
  return import("./linkedDirectAccessRuntime").then(({ addMobileDirectAccess }) =>
    addMobileDirectAccess({ environmentId: node.environmentId, label: node.label }),
  );
}

/** "Remove direct access", loaded the same way. */
export function removeMobileDirectAccessLazily(node: HostedHubNode): Promise<void> {
  return import("./linkedDirectAccessRuntime").then(({ removeMobileDirectAccess }) =>
    removeMobileDirectAccess(node.environmentId),
  );
}
