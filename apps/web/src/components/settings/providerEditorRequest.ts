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
 * A request waits until the editor shows its device: choosing another device in the bar can
 * take a moment (hosted mode moves the selection cursor first).
 */
export const useProviderEditorRequest = create<{
  readonly request: ProviderEditorRequest | null;
}>(() => ({ request: null }));

export function requestProviderEditor(request: ProviderEditorRequest): void {
  useProviderEditorRequest.setState({ request });
}

/** The request for this device, taken so it opens once. */
export function takeProviderEditorRequest(
  environmentId: EnvironmentId | null,
): ProviderEditorRequest | null {
  const { request } = useProviderEditorRequest.getState();
  if (request === null || environmentId === null || request.environmentId !== environmentId)
    return null;
  useProviderEditorRequest.setState({ request: null });
  return request;
}
