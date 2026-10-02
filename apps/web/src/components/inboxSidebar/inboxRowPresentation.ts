import { formatRelativeTime } from "../../timestampFormat";
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

export function resolveInboxStateLine(
  row: Pick<InboxSidebarRow, "state" | "attention" | "errorDetail" | "statusLabel">,
): InboxStateLine {
  switch (row.state) {
    case "needs-input":
      return { kind: "attention", text: ATTENTION_LABEL[row.attention ?? "input"] };
    case "error":
      return { kind: "error", text: row.errorDetail ?? "The last turn failed" };
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
