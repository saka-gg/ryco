import type { ChangeRequestReviewThread } from "@ryco/contracts";
import { memo } from "react";

import { SectionLabel } from "../primitives";
import { ReviewThread } from "../threads/ReviewThread";

/**
 * Conversations that no longer map onto this file's diff (the lines moved or
 * went away), grouped after the file's last hunk. Each one shows the code it
 * was written against, so it still reads without the original diff.
 */
export const OutdatedThreads = memo(function OutdatedThreads(props: {
  readonly threads: ReadonlyArray<ChangeRequestReviewThread>;
}) {
  if (props.threads.length === 0) return null;
  const count = props.threads.length;
  return (
    <div data-outdated-threads className="space-y-2 border-t border-border/60 px-3 pt-3 pb-4">
      <SectionLabel>
        {count} outdated {count === 1 ? "conversation" : "conversations"}
      </SectionLabel>
      {props.threads.map((thread) => (
        <ReviewThread key={thread.id} variant="inline" thread={thread} />
      ))}
    </div>
  );
});
