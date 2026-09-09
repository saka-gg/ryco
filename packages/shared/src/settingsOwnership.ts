import {
  ServerSettings,
  type ServerSettingsPatch,
  type ClientSettingsPatch,
  type UnifiedSettings,
} from "@ryco/contracts/settings";

const SERVER_SETTING_KEYS = new Set(Object.keys(ServerSettings.fields));

export function isServerSettingKey(key: string): boolean {
  return SERVER_SETTING_KEYS.has(key);
}

/** Persistence ownership is shared by every client, independent of its presentation. */
export function splitUnifiedSettingsPatch(patch: Partial<UnifiedSettings>): {
  readonly serverPatch: ServerSettingsPatch;
  readonly clientPatch: ClientSettingsPatch;
} {
  const serverPatch: Record<string, unknown> = {};
  const clientPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    (isServerSettingKey(key) ? serverPatch : clientPatch)[key] = value;
  }
  return {
    serverPatch: serverPatch as ServerSettingsPatch,
    clientPatch: clientPatch as ClientSettingsPatch,
  };
}
