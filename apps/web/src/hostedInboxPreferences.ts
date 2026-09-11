import { ClientSettingsSchema, type ClientSettings } from "@ryco/contracts";
import * as Schema from "effect/Schema";

// Only finite, user-selected inbox preferences may cross the hosted memory boundary.
// Do not persist the full client settings object: it can contain node-owned identifiers.
export const HOSTED_INBOX_PREFERENCES_KEY = "ryco:hosted-inbox-preferences:v1";
const Preferences = Schema.Struct({
  sidebarAutoSettleAfterDays: ClientSettingsSchema.fields.sidebarAutoSettleAfterDays,
  aiFocusEnabled: ClientSettingsSchema.fields.aiFocusEnabled,
  aiFocusRefreshIntervalMs: ClientSettingsSchema.fields.aiFocusRefreshIntervalMs,
});
const JsonPreferences = Schema.fromJsonString(Preferences);

export function readHostedInboxPreferences(): Partial<ClientSettings> {
  try {
    const value = window.localStorage.getItem(HOSTED_INBOX_PREFERENCES_KEY);
    return value && value.length <= 512 ? Schema.decodeSync(JsonPreferences)(value) : {};
  } catch {
    return {};
  }
}

export function writeHostedInboxPreferences(settings: ClientSettings): void {
  const value = Schema.encodeSync(JsonPreferences)({
    sidebarAutoSettleAfterDays: settings.sidebarAutoSettleAfterDays,
    aiFocusEnabled: settings.aiFocusEnabled,
    aiFocusRefreshIntervalMs: settings.aiFocusRefreshIntervalMs,
  });
  window.localStorage.setItem(HOSTED_INBOX_PREFERENCES_KEY, value);
}
