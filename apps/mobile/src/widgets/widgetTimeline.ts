/**
 * The timeline file a widget reads (`modules/ryco-widgets/extension/WidgetTimelineStore.swift`).
 *
 * The app computes every entry ahead of time, here in TypeScript, and the
 * extension only renders them: each entry shows from `at` (ms since the epoch)
 * until the next one starts. So a widget can change at a deadline the app
 * foresaw (a reset, an expiry) while the app is not running.
 */
export const WIDGET_TIMELINE_VERSION = 1;

export interface WidgetTimelineEntry<Content> {
  readonly at: number;
  readonly content: Content;
}

/** What `WidgetGroupStore.isValidKind` accepts: a kind names a file in the App Group. */
const WIDGET_KIND = /^[a-z0-9-]{1,64}$/u;

export function isWidgetKind(kind: string): boolean {
  return WIDGET_KIND.test(kind);
}

/** The file's JSON, entries in time order. */
export function encodeWidgetTimeline<Content>(
  entries: ReadonlyArray<WidgetTimelineEntry<Content>>,
): string {
  return JSON.stringify({
    v: WIDGET_TIMELINE_VERSION,
    entries: entries.toSorted((left, right) => left.at - right.at),
  });
}
