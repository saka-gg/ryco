// FILE: promoteChatDialogStore.ts
// Purpose: Opens the app's one "Turn into project…" dialog from any surface
//          (thread header, overview panel, Chats row menu, command palette) and
//          decides whether a chat's device can promote it at all.
// Layer: Web UI state. The dialog itself (`PromoteChatDialog.tsx`) loads
//        lazily on first open; entry points import only this module.

import {
  type EnvironmentId,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ServerConfig,
  WS_METHODS,
} from "@ryco/contracts";
import { create } from "zustand";

import { getPrimaryKnownEnvironment } from "../../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../../environments/runtime";
import { readHostedRpcCapability, useHostedRpcCapability } from "../../hostedHub/capabilities";
import { useEnvironmentServerConfig } from "../../hooks/useChatsAvailability";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import { getPresentationTier, type PresentationTier } from "../../lib/presentationTier";
import { getServerConfig } from "../../rpc/serverState";

/**
 * Marks a sidebar project row with the scoped keys of its member projects
 * (space separated), so a promoted chat's dialog can fold into its new row.
 */
export const SIDEBAR_PROJECT_MEMBERS_ATTRIBUTE = "data-sidebar-project-members";

export interface PromoteChatDialogRequest {
  readonly projectRef: ScopedProjectRef;
  /** The chat's thread, kept selected once it is a project; null when unknown. */
  readonly threadRef: ScopedThreadRef | null;
  /** The chat's visible title, which prefills the project name; null uses the project's. */
  readonly title: string | null;
}

export interface PromoteChatDialogState {
  readonly open: boolean;
  /** Bumps on every open, so each open starts from a fresh form. */
  readonly token: number;
  /** The latest request; kept after closing so the dialog's content stays while it folds. */
  readonly request: PromoteChatDialogRequest | null;
  /**
   * The control the dialog grows out of; null grows it out of whatever was
   * just activated. Held only while open (see `closePromoteChatDialog`).
   */
  readonly origin: HTMLElement | null;
}

/** App-wide state of the one promotion dialog; `PromoteChatDialog` is its only host. */
export const usePromoteChatDialogStore = create<PromoteChatDialogState>()(() => ({
  open: false,
  token: 0,
  request: null,
  origin: null,
}));

/**
 * Starts loading the dialog's code ahead of a likely open (an entry point is
 * hovered or focused), so its first entrance can grow out of the control.
 */
export function preloadPromoteChatDialog(): void {
  void import("./PromoteChatDialog");
}

export function openPromoteChatDialog(
  request: PromoteChatDialogRequest & { readonly origin?: HTMLElement | null },
): void {
  const { origin = null, ...rest } = request;
  usePromoteChatDialogStore.setState((state) => ({
    open: true,
    token: state.token + 1,
    request: rest,
    origin,
  }));
}

/** Closes the dialog; the popup already captured its origin for the fold. */
export function closePromoteChatDialog(): void {
  if (!usePromoteChatDialogStore.getState().open) return;
  usePromoteChatDialogStore.setState({ open: false, origin: null });
}

/**
 * A device can promote chats when it hosts chat folders at all (its config
 * carries `chats`, available or not: an existing chat can still move out) and
 * the session may run the operator-level RPC. The frozen web phone tier does
 * not offer it (the native app is the phone surface).
 */
function promotionSupported(
  config: ServerConfig | null | undefined,
  allowed: boolean,
  tier: PresentationTier,
): boolean {
  return allowed && tier !== "phone" && config?.chats !== undefined;
}

function readEnvironmentServerConfig(environmentId: EnvironmentId): ServerConfig | null {
  return environmentId === getPrimaryKnownEnvironment()?.environmentId
    ? getServerConfig()
    : (useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.serverConfig ?? null);
}

/** Non-React check, for menus that decide when they open. */
export function canPromoteChatOn(environmentId: EnvironmentId): boolean {
  return promotionSupported(
    readEnvironmentServerConfig(environmentId),
    readHostedRpcCapability(WS_METHODS.projectsPromoteChat).allowed,
    getPresentationTier(),
  );
}

/** Whether "Turn into project…" is offered for chats on `environmentId`. */
export function useCanPromoteChat(environmentId: EnvironmentId | null | undefined): boolean {
  const config = useEnvironmentServerConfig(environmentId);
  const capability = useHostedRpcCapability(WS_METHODS.projectsPromoteChat);
  const tier = usePresentationTier();
  return promotionSupported(config, capability.allowed, tier);
}
