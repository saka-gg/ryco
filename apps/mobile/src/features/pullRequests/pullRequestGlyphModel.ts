import type { ChangeRequestState } from "@ryco/contracts";

import type { PullRequestRowReview } from "./pullRequestListModel";

/**
 * The SF Symbols and colour roles the pull request screens draw state with,
 * one table for the list, the detail header and the stack navigator.
 */

export type PullRequestGlyphTone = "open" | "draft" | "merged" | "closed";

export interface PullRequestStateGlyph {
  readonly symbol: string;
  readonly tone: PullRequestGlyphTone;
  readonly label: string;
}

const STATE_GLYPHS: Readonly<Record<PullRequestGlyphTone, PullRequestStateGlyph>> = {
  open: { symbol: "arrow.triangle.pull", tone: "open", label: "Open" },
  draft: { symbol: "circle.dashed", tone: "draft", label: "Draft" },
  merged: { symbol: "arrow.triangle.merge", tone: "merged", label: "Merged" },
  closed: { symbol: "xmark.circle", tone: "closed", label: "Closed" },
};

export function pullRequestStateGlyph(input: {
  readonly state: ChangeRequestState;
  readonly isDraft: boolean;
}): PullRequestStateGlyph {
  if (input.state === "open") return STATE_GLYPHS[input.isDraft ? "draft" : "open"];
  return STATE_GLYPHS[input.state];
}

export const PULL_REQUEST_STACK_SYMBOL = "square.3.layers.3d";

export interface PullRequestReviewGlyph {
  readonly symbol: string;
  readonly tone: "success" | "warning" | "muted";
  readonly label: string;
}

const REVIEW_GLYPHS: Readonly<Record<PullRequestRowReview, PullRequestReviewGlyph>> = {
  approved: { symbol: "checkmark.seal.fill", tone: "success", label: "Approved" },
  "changes-requested": {
    symbol: "exclamationmark.bubble.fill",
    tone: "warning",
    label: "Changes requested",
  },
  "review-required": { symbol: "eye", tone: "muted", label: "Review required" },
};

export function pullRequestReviewGlyph(review: PullRequestRowReview): PullRequestReviewGlyph {
  return REVIEW_GLYPHS[review];
}

/** A host label colour (`d73a4a`, `#d73a4a`) as `#rrggbb`; null when it is not one. */
export function pullRequestLabelColor(color: string | undefined): string | null {
  if (color === undefined) return null;
  const hex = color.startsWith("#") ? color.slice(1) : color;
  return /^[0-9a-f]{6}$/iu.test(hex) ? `#${hex.toLowerCase()}` : null;
}
