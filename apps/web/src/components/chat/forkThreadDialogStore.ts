// FILE: forkThreadDialogStore.ts
// Purpose: Opens the app's one "Fork from here" dialog from a reply's action
//          and decides whether a thread's machine offers forking at all.
// Layer: Web UI state. The dialog itself (`ForkThreadDialog.tsx`) loads lazily
//        on first open; entry points import only this module.

import {
  type EnvironmentId,
  type MessageId,
  type ScopedThreadRef,
  type ServerConfig,
  type TurnId,
  WS_METHODS,
} from "@ryco/contracts";
import { create } from "zustand";

import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { useEnvironmentServerConfig } from "../../hooks/useChatsAvailability";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import type { PresentationTier } from "../../lib/presentationTier";

export interface ForkThreadDialogRequest {
  readonly sourceThreadRef: ScopedThreadRef;
  /** The terminal reply the fork's history ends at (inclusive). */
  readonly sourceMessageId: MessageId;
  readonly sourceTurnId: TurnId;
  /** The reply's text as shown, so the dialog says where the fork ends. */
  readonly boundaryText: string;
  /** The reply's turn has a checkpoint a new worktree can start from (shared rule). */
  readonly checkpointAvailable: boolean;
}

export interface ForkThreadDialogState {
  readonly open: boolean;
  /**
   * Bumps on every open so the dialog's form starts fresh. The fork attempt is per reply, not
   * per open: a reply whose fork may still exist on the node reopens that same attempt (its key
   * and locked request; `openThreadForkAttempt`).
   */
  readonly token: number;
  /** The latest request; kept after closing so the content stays while it folds. */
  readonly request: ForkThreadDialogRequest | null;
  /** The control the dialog grows out of. Held only while open. */
  readonly origin: HTMLElement | null;
}

/** App-wide state of the one fork dialog; `ForkThreadDialog` is its only host. */
export const useForkThreadDialogStore = create<ForkThreadDialogState>()(() => ({
  open: false,
  token: 0,
  request: null,
  origin: null,
}));

/** Starts loading the dialog's code ahead of a likely open. */
export function preloadForkThreadDialog(): void {
  void import("./ForkThreadDialog");
}

export function openForkThreadDialog(
  request: ForkThreadDialogRequest & { readonly origin?: HTMLElement | null },
): void {
  const { origin = null, ...rest } = request;
  useForkThreadDialogStore.setState((state) => ({
    open: true,
    token: state.token + 1,
    request: rest,
    origin,
  }));
}

/** Closes the dialog; the popup already captured its origin for the fold. */
export function closeForkThreadDialog(): void {
  if (!useForkThreadDialogStore.getState().open) return;
  useForkThreadDialogStore.setState({ open: false, origin: null });
}

/**
 * A machine offers forking when its server advertises `threadFork` and the
 * session may run the operator-level `threads.fork`. The frozen web phone tier
 * never offers it (the native app is the phone surface).
 */
export function threadForkSupported(
  config: Pick<ServerConfig, "environment"> | null | undefined,
  allowed: boolean,
  tier: PresentationTier,
): boolean {
  return allowed && tier !== "phone" && config?.environment.capabilities.threadFork === true;
}

/** Whether "Fork from here" is offered for threads on `environmentId`. */
export function useCanForkThread(environmentId: EnvironmentId | null | undefined): boolean {
  const config = useEnvironmentServerConfig(environmentId);
  const capability = useHostedRpcCapability(WS_METHODS.threadsFork);
  const tier = usePresentationTier();
  return threadForkSupported(config, capability.allowed, tier);
}
