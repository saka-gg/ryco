import { ClientSettingsSchema, type ClientSettings } from "@ryco/contracts";
import * as Schema from "effect/Schema";

// Only finite, user-selected inbox and alert preferences may cross the hosted memory boundary.
// Do not persist the full client settings object: it can contain node-owned identifiers.
// The auto-settle interval here is this browser's own: nodes that keep their own rule ignore it,
// so it applies only to older nodes, and is what a first connection hands to a node with none set.
export const HOSTED_INBOX_PREFERENCES_KEY = "ryco:hosted-inbox-preferences:v1";
const PREFERENCE_KEYS = [
  "sidebarAutoSettleAfterDays",
  "aiFocusEnabled",
  "aiFocusRefreshIntervalMs",
  "notifyOnTurnCompleteWhenUnfocused",
  "threadNotificationSound",
  "threadNotificationToasts",
] as const;
type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

function pickPreferences<T extends Record<PreferenceKey, unknown>>(
  source: T,
): Pick<T, PreferenceKey> {
  return Object.fromEntries(PREFERENCE_KEYS.map((key) => [key, source[key]])) as Pick<
    T,
    PreferenceKey
  >;
}

const JsonPreferences = Schema.fromJsonString(
  Schema.Struct(pickPreferences(ClientSettingsSchema.fields)),
);

export function readHostedInboxPreferences(): Partial<ClientSettings> {
  try {
    const value = window.localStorage.getItem(HOSTED_INBOX_PREFERENCES_KEY);
    return value && value.length <= 512 ? Schema.decodeSync(JsonPreferences)(value) : {};
  } catch {
    return {};
  }
}

export function writeHostedInboxPreferences(settings: ClientSettings): void {
  const value = Schema.encodeSync(JsonPreferences)(pickPreferences(settings));
  window.localStorage.setItem(HOSTED_INBOX_PREFERENCES_KEY, value);
}
