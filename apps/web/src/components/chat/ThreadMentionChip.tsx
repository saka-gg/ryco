import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { Link } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";
import { useMemo } from "react";

import { cn } from "~/lib/utils";
import { selectSidebarThreadSummaryByRef, useStore } from "../../store";
import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The live title of a mentioned thread; null while unknown on this client. */
function useThreadMentionTitle(environmentId: EnvironmentId, threadId: ThreadId): string | null {
  const ref = useMemo(() => ({ environmentId, threadId }), [environmentId, threadId]);
  return useStore((state) => selectSidebarThreadSummaryByRef(state, ref)?.title || null);
}

/**
 * An `@thread:<id>` mention, named by the thread's current title. In a sent
 * message it links to the thread; in the composer it is inert text.
 */
export function ThreadMentionChip(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Opens the thread on click (sent messages). */
  readonly linked?: boolean;
}) {
  const title = useThreadMentionTitle(props.environmentId, props.threadId);
  const label = title ?? "Unknown thread";
  const chipClassName = cn(
    COMPOSER_INLINE_CHIP_CLASS_NAME,
    !title && "text-muted-foreground",
    props.linked && "cursor-pointer hover:bg-accent/70",
  );
  const content = (
    <>
      <MessagesSquareIcon aria-hidden className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
      <span className={cn(COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME, "max-w-48")}>{label}</span>
    </>
  );
  const chip = props.linked ? (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId: props.environmentId, threadId: props.threadId }}
      className={chipClassName}
      data-thread-mention-chip="true"
      aria-label={`Open thread ${label}`}
    >
      {content}
    </Link>
  ) : (
    <span
      className={chipClassName}
      contentEditable={false}
      spellCheck={false}
      data-thread-mention-chip="true"
    >
      {content}
    </span>
  );
  return (
    <span className="inline-flex align-middle leading-none">
      <Tooltip>
        <TooltipTrigger render={chip} />
        <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
          {title
            ? props.linked
              ? `Open “${title}”`
              : `“${title}” · the agent gets this thread's recent conversation`
            : "This thread is not available on this machine"}
        </TooltipPopup>
      </Tooltip>
    </span>
  );
}
