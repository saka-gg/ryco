import type { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@ryco/contracts";
import { create } from "zustand";

/** What the providers table asks the device's provider editor to open. */
export type ProviderEditorRequest =
  | {
      readonly kind: "edit";
      readonly environmentId: EnvironmentId;
      readonly instanceId: ProviderInstanceId;
    }
  | {
      readonly kind: "add";
      readonly environmentId: EnvironmentId;
      /** The row's provider, so the new instance joins its row (same id and name). */
      readonly preset: {
        readonly driver: ProviderDriverKind;
        readonly displayName: string | null;
        readonly instanceId: ProviderInstanceId;
      };
    };

/**
 * How long a request waits for the editor to show its device. Choosing another device in the bar
 * can take a moment (hosted mode moves the selection cursor first, then its settings load); a
 * switch that fails, or a section left before it lands, must not open the editor later.
 */
export const PROVIDER_EDITOR_REQUEST_TTL_MS = 20_000;

/** The table's latest request, until the editor of its device takes it or it expires. */
export const useProviderEditorRequest = create<{
  readonly request: ProviderEditorRequest | null;
  /** When the request stops being honored (ms since the epoch). */
  readonly expiresAt: number;
}>(() => ({ request: null, expiresAt: 0 }));

export function requestProviderEditor(request: ProviderEditorRequest, nowMs = Date.now()): void {
  useProviderEditorRequest.setState({ request, expiresAt: nowMs + PROVIDER_EDITOR_REQUEST_TTL_MS });
}

/** Drops the request, so nothing opens for it later. */
export function clearProviderEditorRequest(): void {
  useProviderEditorRequest.setState({ request: null, expiresAt: 0 });
}

/**
 * The request for this device, taken so it opens once. An expired request is dropped. An Add
 * waits while this client may not change the device's settings (`canAdd` false): the dialog
 * never opens on a device it could not save to, and the request expires if that never changes.
 */
export function takeProviderEditorRequest(
  environmentId: EnvironmentId | null,
  options: { readonly canAdd: boolean; readonly nowMs?: number },
): ProviderEditorRequest | null {
  const { request, expiresAt } = useProviderEditorRequest.getState();
  if (request === null) return null;
  if ((options.nowMs ?? Date.now()) >= expiresAt) {
    clearProviderEditorRequest();
    return null;
  }
  if (environmentId === null || request.environmentId !== environmentId) return null;
  if (request.kind === "add" && !options.canAdd) return null;
  clearProviderEditorRequest();
  return request;
}
