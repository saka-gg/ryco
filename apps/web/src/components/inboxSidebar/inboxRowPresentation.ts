import { formatUsageLimitReset } from "@ryco/client-runtime/state/threads";

import { formatRelativeTime, formatRelativeTimeLabel } from "../../timestampFormat";
import type { InboxSidebarRow } from "./inboxSidebarModel";

/**
 * One glyph per row state. Color means the thread is on you (needs input,
 * unseen completion, error); motion means it is running; grey means nothing
 * to do.
 */
export type InboxGlyphKind =
  | "needs-input"
  | "working"
  | "connecting"
  | "completed"
  | "limited"
  | "error"
  | "offline"
  | "idle";

type GlyphRow = Pick<InboxSidebarRow, "state" | "attention" | "statusLabel">;

export function resolveInboxGlyph(
  row: Pick<InboxSidebarRow, "state">,
  unseen: boolean,
): InboxGlyphKind {
  switch (row.state) {
    case "needs-input":
      return "needs-input";
    case "working":
      return "working";
    case "connecting":
    case "reconnecting":
      return "connecting";
    case "limited":
      return "limited";
    case "error":
    case "delivery-unknown":
      return "error";
    case "offline":
      return "offline";
    case "idle":
      return unseen ? "completed" : "idle";
  }
}

// Short enough to survive a 256px sidebar next to a project name and PR.
const ATTENTION_LABEL = {
  approval: "Needs approval",
  input: "Needs your answer",
  plan: "Plan ready",
} as const;

export function inboxGlyphLabel(row: GlyphRow, unseen: boolean): string {
  if (row.state === "needs-input") return ATTENTION_LABEL[row.attention ?? "input"];
  if (row.state === "idle") return unseen ? "Completed" : "Idle";
  return row.statusLabel;
}

/**
 * The second line says the one thing that matters for the state. Running and
 * resting rows show where the work lives; the glyph and clock already say
 * whether it runs. Tool calls and reasoning never surface here.
 */
export type InboxStateLine =
  | { readonly kind: "attention"; readonly text: string }
  | { readonly kind: "error"; readonly text: string }
  | { readonly kind: "status"; readonly text: string }
  | { readonly kind: "workspace" };

const ATTENTION_DETAIL = {
  approval: "Waiting for your approval to continue.",
  input: "Waiting for your answer to continue.",
  plan: "A plan is ready for your review.",
} as const;

/** The card's sentence for a needs-input thread; its header already names the state. */
export function inboxAttentionDetail(row: Pick<InboxSidebarRow, "attention">): string {
  return ATTENTION_DETAIL[row.attention ?? "input"];
}

const ERROR_FALLBACK = "The last turn failed";

type UsageLimitRow = Pick<InboxSidebarRow, "state"> & {
  readonly usageLimit?: InboxSidebarRow["usageLimit"];
};

/** "Resets Thu 15:40", "Reset time unknown" or "Limit reset · resume to continue". */
export function inboxUsageLimitDetail(row: UsageLimitRow): string {
  const limit = row.usageLimit ?? null;
  if (limit?.phase === "reset") return "Limit reset · resume to continue";
  if (limit?.resetAt) return `Resets ${formatUsageLimitReset(limit.resetAt)}`;
  return "Reset time unknown";
}

export function resolveInboxStateLine(
  row: Pick<InboxSidebarRow, "state" | "attention" | "errorDetail" | "statusLabel"> & {
    readonly usageLimit?: InboxSidebarRow["usageLimit"];
  },
): InboxStateLine {
  switch (row.state) {
    case "needs-input":
      return { kind: "attention", text: ATTENTION_LABEL[row.attention ?? "input"] };
    case "limited":
      return { kind: "status", text: inboxUsageLimitDetail(row) };
    case "error":
      return { kind: "error", text: row.errorDetail ?? ERROR_FALLBACK };
    case "delivery-unknown":
      return { kind: "error", text: "Check message delivery" };
    case "connecting":
    case "reconnecting":
    case "offline":
      return { kind: "status", text: row.statusLabel };
    case "working":
    case "idle":
      return { kind: "workspace" };
  }
}

/** Compact recency for the row: `now`, `6m`, `3h`, `2d`. */
export function formatInboxAge(isoDate: string): string {
  const { value } = formatRelativeTime(isoDate);
  return value === "just now" ? "now" : value;
}

/** Weekday and time, the way the inbox names moments: `Thu 14:26`. */
export function formatInboxDayTime(isoDate: string): string {
  return new Date(isoDate).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** What hovering the status glyph says: the state, plus the fact behind it. */
export function inboxGlyphHint(
  row: Pick<
    InboxSidebarRow,
    "state" | "attention" | "statusLabel" | "errorDetail" | "runningSince" | "latestTurnCompletedAt"
  > & { readonly usageLimit?: InboxSidebarRow["usageLimit"] },
  unseen: boolean,
): string {
  const label = inboxGlyphLabel(row, unseen);
  switch (row.state) {
    case "limited":
      return `${label} · ${inboxUsageLimitDetail(row)}`;
    case "needs-input":
      return `${label} · open the thread to respond`;
    case "working":
      return row.runningSince
        ? `${label} · started ${formatInboxDayTime(row.runningSince)}`
        : label;
    case "error":
      return `${label} · ${row.errorDetail ?? ERROR_FALLBACK}`;
    case "idle":
      return unseen && row.latestTurnCompletedAt
        ? `${label} ${formatRelativeTimeLabel(row.latestTurnCompletedAt)} · not opened yet`
        : `${label} · nothing running`;
    default:
      return label;
  }
}

/** What hovering the time says: the exact moment behind the compact age. */
export function inboxTimeHint(
  row: Pick<InboxSidebarRow, "runningSince" | "settled" | "snoozedUntil">,
  timestamp: string,
): string {
  if (row.runningSince) return `Running since ${formatInboxDayTime(row.runningSince)}`;
  if (row.snoozedUntil) return `Snoozed until ${formatInboxDayTime(row.snoozedUntil)}`;
  if (row.settled) return `Settled ${formatInboxDayTime(timestamp)}`;
  return `Last activity ${formatInboxDayTime(timestamp)}`;
}
