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

/** Copies the task's ID (`resolveThreadReferenceCopyTarget`'s fallback, as web's Copy Thread ID). */
export const COPY_TASK_ID_ACTION_ID = "copy-id";

/** The menu action that asks for a date and time or a duration (`CustomSnoozeSheet`). */
export const CUSTOM_SNOOZE_ACTION_ID = "snooze-custom";

export const PIN_TASK_ACTION_ID = "pin";
export const UNPIN_TASK_ACTION_ID = "unpin";
export const ARCHIVE_TASK_ACTION_ID = "archive";

/** The snooze presets and "Custom…", as the swipe Snooze button lists them. */
export function buildInboxSnoozeMenuActions(
  row: InboxThreadRow,
  presets: ReadonlyArray<InboxSnoozeMenuPreset>,
): InboxRowMenuAction[] {
  return [
    ...presets.map((preset) => ({
      id: preset.id,
      title: preset.label,
      attributes: { disabled: !row.canSnooze },
    })),
    { id: CUSTOM_SNOOZE_ACTION_ID, title: "Custom…", attributes: { disabled: !row.canSnooze } },
  ];
}

/**
 * The long-press menu of one inbox row: pin/unpin, settle/unsettle, then snooze
 * (the presets and "Custom…") or unsnooze, hide, archive and copy the ID.
 */
export function buildInboxRowMenuActions(
  row: InboxThreadRow,
  presets: ReadonlyArray<InboxSnoozeMenuPreset>,
): InboxRowMenuAction[] {
  const actions: InboxRowMenuAction[] = row.snoozedUntil
    ? [{ id: "unsnooze", title: "Unsnooze", attributes: { disabled: !row.canUnsnooze } }]
    : buildInboxSnoozeMenuActions(row, presets);
  actions.unshift({
    id: row.attentionState === "settled" ? "unsettle" : "settle",
    title: row.attentionState === "settled" ? "Move to Active" : "Settle task",
    attributes: { disabled: !row.mutationEnabled || !row.canSettle },
  });
  // Pins live on this device, so they work offline too.
  actions.unshift(
    row.pinned
      ? { id: UNPIN_TASK_ACTION_ID, title: "Unpin task", attributes: { disabled: false } }
      : { id: PIN_TASK_ACTION_ID, title: "Pin task", attributes: { disabled: false } },
  );
  // Hide keeps a task out of the Inbox until it needs the person.
  actions.push(
    row.hiddenByUser === true
      ? { id: "unhide", title: "Show in Inbox", attributes: { disabled: !row.hideActionEnabled } }
      : { id: "hide", title: "Hide task", attributes: { disabled: !row.hideActionEnabled } },
  );
  actions.push({
    id: ARCHIVE_TASK_ACTION_ID,
    title: "Archive task",
    attributes: { disabled: !row.canArchive },
  });
  // Reads nothing from the node, so it works offline too.
  actions.push({
    id: COPY_TASK_ID_ACTION_ID,
    title: "Copy task ID",
    attributes: { disabled: false },
  });
  return actions;
}
