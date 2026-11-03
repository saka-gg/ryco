/**
 * The shared "Update everything" view model (`@ryco/client-runtime/updates`),
 * plus the one label that formats a time with this app's own formatter.
 */
import type { NodeUpdateState } from "@ryco/contracts";

import { formatRelativeTimeLabel } from "../../timestampFormat";

export * from "@ryco/client-runtime/updates/view";

const CHANNEL_LABELS: Readonly<Record<NodeUpdateState["channel"], string>> = {
  latest: "Stable",
  nightly: "Nightly",
};

/** "Stable channel · checked 5m ago" from a node's own update report. */
export function nodeUpdateMetaLabel(
  state: Pick<NodeUpdateState, "channel" | "checkedAt"> | null,
  nowMs: number,
): string | null {
  if (state === null) return null;
  const channel = `${CHANNEL_LABELS[state.channel]} channel`;
  const checked =
    state.checkedAt === null
      ? "not checked yet"
      : `checked ${formatRelativeTimeLabel(state.checkedAt, nowMs)}`;
  return `${channel} · ${checked}`;
}
