import type {
  ClientSettingsPatch,
  ServerSettingsPatch,
  UnifiedSettings,
} from "@ryco/contracts/settings";
import { splitUnifiedSettingsPatch } from "@ryco/shared/settingsOwnership";
export { isServerSettingKey, splitUnifiedSettingsPatch } from "@ryco/shared/settingsOwnership";

export interface UpdateMobileSettingsDeps {
  /** Optimistically apply the server patch to the server-config atom. */
  readonly applyServerOptimistic: (serverPatch: ServerSettingsPatch) => void;
  /** Dispatch the server patch over RPC (client.server.updateSettings). */
  readonly updateServerSettings: (serverPatch: ServerSettingsPatch) => void | Promise<void>;
  /** Persist the client patch device-locally (mobileKV). */
  readonly persistClientSettings: (clientPatch: ClientSettingsPatch) => void;
}

export function updateMobileSettings(
  patch: Partial<UnifiedSettings>,
  deps: UpdateMobileSettingsDeps,
): void {
  const { serverPatch, clientPatch } = splitUnifiedSettingsPatch(patch);
  if (Object.keys(serverPatch).length > 0) {
    deps.applyServerOptimistic(serverPatch);
    void deps.updateServerSettings(serverPatch);
  }
  if (Object.keys(clientPatch).length > 0) {
    deps.persistClientSettings(clientPatch);
  }
}
