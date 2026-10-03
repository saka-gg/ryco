import type { SourceControlCommentReactionContent } from "@ryco/contracts";
import { memo, useMemo, type ReactNode } from "react";

import { cn } from "../../../lib/utils";
import { MarkdownView } from "../../projectExplorer/MarkdownView";
import { ActorAvatar, RelativeTime, type TimeLike } from "../primitives";
import { CommentReactions, ReactionPicker } from "./CommentReactions";
import { splitSuggestionBlocks } from "./reviewThread.logic";
import { SuggestionBlock } from "./SuggestionBlock";

/**
 * A review comment's body: prose through the shared Markdown renderer, and
 * each ` ```suggestion ` block as the change it proposes.
 */
export const ReviewCommentBody = memo(function ReviewCommentBody(props: {
  readonly body: string;
  /** Head-side lines a suggestion replaces (from the thread's hunk), if known. */
  readonly suggestionBase?: ReadonlyArray<string> | null | undefined;
  readonly onApplySuggestion?: ((lines: ReadonlyArray<string>) => void) | undefined;
  readonly applyUnavailableReason?: string | undefined;
}) {
  const segments = useMemo(() => splitSuggestionBlocks(props.body), [props.body]);
  if (segments.length === 0) {
    return <p className="text-[13px] text-muted-foreground italic">No comment.</p>;
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {segments.map((segment, index) =>
        segment.kind === "markdown" ? (
          // oxlint-disable-next-line react/no-array-index-key -- body segments are positional
          <MarkdownView key={index} text={segment.text} className="text-[13px] leading-[1.55]" />
        ) : (
          <SuggestionBlock
            // oxlint-disable-next-line react/no-array-index-key -- body segments are positional
            key={index}
            lines={segment.lines}
            baseLines={props.suggestionBase ?? null}
            onApply={
              props.onApplySuggestion ? () => props.onApplySuggestion?.(segment.lines) : undefined
            }
            applyUnavailableReason={props.applyUnavailableReason}
          />
        ),
      )}
    </div>
  );
});

/** One comment in a thread: avatar column, author · time (· Pending), body, reactions. */
export const ReviewCommentRow = memo(function ReviewCommentRow(props: {
  readonly login: string;
  readonly avatarUrl?: string | undefined;
  readonly createdAt: TimeLike;
  readonly pending?: boolean | undefined;
  readonly body: ReactNode;
  readonly reactions?: Parameters<typeof CommentReactions>[0]["reactions"];
  readonly onReact?:
    | ((content: SourceControlCommentReactionContent) => Promise<unknown>)
    | undefined;
  readonly trailing?: ReactNode;
  readonly className?: string | undefined;
}) {
  return (
    <div
      className={cn(
        "group/comment grid grid-cols-[20px_minmax(0,1fr)] gap-x-2.5 px-3 py-2.5",
        props.className,
      )}
    >
      <ActorAvatar login={props.login} avatarUrl={props.avatarUrl} size={20} className="mt-px" />
      <div className="min-w-0">
        <div className="flex h-5 min-w-0 items-center gap-1.5 text-xs">
          <span className="truncate text-[13px] font-medium text-foreground">{props.login}</span>
          <RelativeTime value={props.createdAt} className="text-muted-foreground" />
          {props.pending ? <PendingChip /> : null}
          <span className="min-w-0 flex-1" />
          {props.trailing}
          {props.onReact ? (
            <ReactionPicker
              onPick={(content) => void props.onReact?.(content)}
              className="opacity-0 group-focus-within/comment:opacity-100 group-hover/comment:opacity-100"
            />
          ) : null}
        </div>
        <div className="mt-1">{props.body}</div>
        <CommentReactions reactions={props.reactions} onToggle={props.onReact} className="mt-2" />
      </div>
    </div>
  );
});

/** "Pending": text that only exists in the viewer's unsent review. */
export function PendingChip(props: { readonly className?: string | undefined }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded-full border border-warning/40 px-1.5 text-[10.5px] font-medium text-warning-foreground",
        props.className,
      )}
    >
      Pending
    </span>
  );
}
