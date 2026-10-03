import type {
  SourceControlCommentReaction,
  SourceControlCommentReactionContent,
} from "@ryco/contracts";
import { SmilePlusIcon } from "lucide-react";
import { memo, useState } from "react";

import { cn } from "../../../lib/utils";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { stackedThreadToast, toastManager } from "../../ui/toast";

export const REACTION_EMOJI: Record<SourceControlCommentReactionContent, string> = {
  "thumbs-up": "👍",
  "thumbs-down": "👎",
  laugh: "😄",
  hooray: "🎉",
  confused: "😕",
  heart: "❤️",
  rocket: "🚀",
  eyes: "👀",
};

const REACTION_LABEL: Record<SourceControlCommentReactionContent, string> = {
  "thumbs-up": "Thumbs up",
  "thumbs-down": "Thumbs down",
  laugh: "Laugh",
  hooray: "Hooray",
  confused: "Confused",
  heart: "Heart",
  rocket: "Rocket",
  eyes: "Eyes",
};

const REACTION_ORDER = Object.keys(REACTION_EMOJI) as SourceControlCommentReactionContent[];

/**
 * A comment's reactions as quiet count pills. Pressing one toggles the
 * viewer's reaction; the add button lives in the comment header (see
 * `ReactionPicker`) so a comment without reactions adds no row.
 */
export const CommentReactions = memo(function CommentReactions(props: {
  readonly reactions: ReadonlyArray<SourceControlCommentReaction> | undefined;
  readonly onToggle?:
    | ((content: SourceControlCommentReactionContent) => Promise<unknown>)
    | undefined;
  readonly className?: string | undefined;
}) {
  const [pending, setPending] = useState<SourceControlCommentReactionContent | null>(null);
  const visible = (props.reactions ?? []).filter((reaction) => reaction.count > 0);
  if (visible.length === 0) return null;
  const toggle = async (content: SourceControlCommentReactionContent) => {
    if (!props.onToggle || pending !== null) return;
    setPending(content);
    try {
      await props.onToggle(content);
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not update the reaction",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setPending(null);
    }
  };
  return (
    <div className={cn("flex flex-wrap items-center gap-1", props.className)}>
      {visible.map((reaction) => {
        const reacted = reaction.viewerHasReacted === true;
        const label = `${REACTION_LABEL[reaction.content]}: ${reaction.count}`;
        return (
          <button
            key={reaction.content}
            type="button"
            aria-pressed={reacted}
            aria-label={label}
            title={label}
            disabled={!props.onToggle || pending !== null}
            onClick={() => void toggle(reaction.content)}
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs tabular-nums outline-hidden transition-colors duration-(--app-motion-duration-chip) focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
              reacted
                ? "border-foreground/20 bg-accent text-foreground"
                : "border-border/70 text-muted-foreground enabled:hover:border-foreground/20 enabled:hover:text-foreground",
            )}
          >
            <span aria-hidden className="text-[12px] leading-none">
              {REACTION_EMOJI[reaction.content]}
            </span>
            {reaction.count}
          </button>
        );
      })}
    </div>
  );
});

/** Ghost "add reaction" button with the eight host reactions. */
export function ReactionPicker(props: {
  readonly onPick: (content: SourceControlCommentReactionContent) => void;
  readonly className?: string | undefined;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label="Add reaction"
            className={cn(
              "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-hidden transition-[color,background-color,opacity] duration-(--app-motion-duration-chip) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              props.className,
            )}
          >
            <SmilePlusIcon className="size-3.5" />
          </button>
        }
      />
      <MenuPopup align="start" className="min-w-0">
        <div className="flex gap-0.5">
          {REACTION_ORDER.map((content) => (
            <MenuItem
              key={content}
              aria-label={REACTION_LABEL[content]}
              className="size-8 justify-center p-0 text-base"
              onClick={() => props.onPick(content)}
            >
              {REACTION_EMOJI[content]}
            </MenuItem>
          ))}
        </div>
      </MenuPopup>
    </Menu>
  );
}
