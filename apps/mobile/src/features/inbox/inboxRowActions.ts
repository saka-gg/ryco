import { resolveSnoozePresets } from "@ryco/shared/threadSnooze";

import type { InboxThreadRow } from "./inboxModel";

/** What a row menu lists for snoozing; the instant itself is resolved at press time. */
export interface InboxSnoozeMenuPreset {
  readonly id: string;
  readonly label: string;
}

export interface InboxRowMenuAction {
  id: string;
  title: string;
  attributes: { disabled: boolean };
}

export function resolveSnoozeMenuPresets(now: Date): ReadonlyArray<InboxSnoozeMenuPreset> {
  return resolveSnoozePresets(now).map(({ id, label }) => ({ id, label }));
}

const PRESET_FIELD_SEPARATOR = "\u0000";
const PRESET_SEPARATOR = "\u0001";

/**
 * A preset list as a value. The list only changes when a preset appears or
 * drops out (e.g. "This evening" after 18:00), so a list rebuilt from this key
 * keeps its identity — and every row its menu — until it does.
 */
export function snoozeMenuPresetsKey(presets: ReadonlyArray<InboxSnoozeMenuPreset>): string {
  return presets
    .map((preset) => `${preset.id}${PRESET_FIELD_SEPARATOR}${preset.label}`)
    .join(PRESET_SEPARATOR);
}

export function snoozeMenuPresetsFromKey(key: string): ReadonlyArray<InboxSnoozeMenuPreset> {
  if (key.length === 0) return [];
  return key.split(PRESET_SEPARATOR).map((entry) => {
    const [id = "", label = ""] = entry.split(PRESET_FIELD_SEPARATOR);
    return { id, label };
  });
}

/** The long-press menu of one inbox row: settle/unsettle, then snooze or unsnooze. */
export function buildInboxRowMenuActions(
  row: InboxThreadRow,
  presets: ReadonlyArray<InboxSnoozeMenuPreset>,
): InboxRowMenuAction[] {
  const actions: InboxRowMenuAction[] = row.snoozedUntil
    ? [{ id: "unsnooze", title: "Unsnooze", attributes: { disabled: !row.canUnsnooze } }]
    : presets.map((preset) => ({
        id: preset.id,
        title: preset.label,
        attributes: { disabled: !row.canSnooze },
      }));
  actions.unshift({
    id: row.attentionState === "settled" ? "unsettle" : "settle",
    title: row.attentionState === "settled" ? "Move to Active" : "Settle task",
    attributes: { disabled: !row.mutationEnabled || !row.canSettle },
  });
  return actions;
}
