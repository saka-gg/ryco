import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@ryco/contracts";
import { AtSignIcon, BanIcon } from "lucide-react";
import { useCallback, useEffect, useState, type DragEvent as ReactDragEvent } from "react";

import { decodePaneRef, PANE_DRAG_TYPE } from "../../chatPanes.logic";
import { endPaneDrag, readPaneDragSource } from "../../chatPanesStore";
import { isThreadMentionableId } from "../../composer-editor-mentions";
import { cn } from "~/lib/utils";
import { toastManager } from "../ui/toast";

/**
 * Marks a composer as the receiver of thread drags dropped on it. The split
 * panes around it skip their own preview there, so a drop on the composer
 * mentions the thread instead of opening it beside this one.
 */
export const THREAD_MENTION_DROP_ZONE_PROPS = { "data-thread-mention-drop": "" } as const;

export function isInThreadMentionDropZone(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-thread-mention-drop]") !== null;
}

export type ThreadMentionDropVerdict =
  | { readonly kind: "mention" }
  | {
      readonly kind: "refused";
      readonly reason: "environment" | "self" | "unsupported" | "unavailable";
    };

/** What dropping `source` on the composer of `target` would do. */
export function resolveThreadMentionDrop(input: {
  readonly source: ScopedThreadRef | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly disabled: boolean;
}): ThreadMentionDropVerdict {
  if (input.disabled) return { kind: "refused", reason: "unavailable" };
  // Drags from another window carry an unknown thread; the drop decides.
  if (!input.source) return { kind: "mention" };
  if (input.source.environmentId !== input.environmentId)
    return { kind: "refused", reason: "environment" };
  if (input.source.threadId === input.threadId) return { kind: "refused", reason: "self" };
  if (!isThreadMentionableId(input.source.threadId))
    return { kind: "refused", reason: "unsupported" };
  return { kind: "mention" };
}

export function threadMentionDropLabel(verdict: ThreadMentionDropVerdict): string {
  if (verdict.kind === "mention") return "Mention thread";
  switch (verdict.reason) {
    case "environment":
      return "Only threads from the same machine can be mentioned";
    case "self":
      return "This is the thread you are writing in";
    case "unsupported":
      return "This thread can't be mentioned";
    case "unavailable":
      return "The composer can't take a mention right now";
  }
}

function isThreadDrag(event: ReactDragEvent<HTMLElement>): boolean {
  return event.dataTransfer.types.includes(PANE_DRAG_TYPE);
}

/**
 * Thread drags over the composer. Each handler returns whether the event was a
 * thread drag, so the caller hands every other drag (files) to its own handler.
 */
export function useComposerThreadMentionDrop(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly disabled: boolean;
  readonly onMention: (threadId: ThreadId) => void;
}) {
  const { environmentId, threadId, disabled, onMention } = input;
  const [verdict, setVerdict] = useState<ThreadMentionDropVerdict | null>(null);
  const active = verdict !== null;
  useEffect(() => {
    if (!active) return;
    // A drag cancelled or dropped elsewhere must not leave the hint behind.
    const clear = () => setVerdict(null);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, [active]);

  const onDragOver = useCallback(
    (event: ReactDragEvent<HTMLElement>): boolean => {
      if (!isThreadDrag(event)) return false;
      const next = resolveThreadMentionDrop({
        source: readPaneDragSource(),
        environmentId,
        threadId,
        disabled,
      });
      if (next.kind === "mention") {
        event.preventDefault();
        // Pane titles only allow moves; sidebar rows allow copies.
        event.dataTransfer.dropEffect =
          event.dataTransfer.effectAllowed === "move" ? "move" : "copy";
      } else {
        event.dataTransfer.dropEffect = "none";
      }
      setVerdict((current) =>
        current?.kind === next.kind &&
        (current.kind === "mention" || (next.kind === "refused" && current.reason === next.reason))
          ? current
          : next,
      );
      return true;
    },
    [disabled, environmentId, threadId],
  );

  const onDragLeave = useCallback((event: ReactDragEvent<HTMLElement>): boolean => {
    if (!isThreadDrag(event)) return false;
    const next = event.relatedTarget;
    if (!(next instanceof Node && event.currentTarget.contains(next))) setVerdict(null);
    return true;
  }, []);

  const onDrop = useCallback(
    (event: ReactDragEvent<HTMLElement>): boolean => {
      if (!isThreadDrag(event)) return false;
      event.preventDefault();
      setVerdict(null);
      endPaneDrag();
      let source: ScopedThreadRef | null = null;
      try {
        source = decodePaneRef(JSON.parse(event.dataTransfer.getData(PANE_DRAG_TYPE)));
      } catch {
        /* unrelated/malformed drag */
      }
      if (!source) return true;
      const outcome = resolveThreadMentionDrop({ source, environmentId, threadId, disabled });
      if (outcome.kind === "refused") {
        toastManager.add({ type: "info", title: threadMentionDropLabel(outcome) });
        return true;
      }
      onMention(source.threadId);
      return true;
    },
    [disabled, environmentId, onMention, threadId],
  );

  return { verdict, onDragOver, onDragLeave, onDrop };
}

/** Names what a drop on the composer does, or why it does nothing. */
export function ThreadMentionDropHint({ verdict }: { readonly verdict: ThreadMentionDropVerdict }) {
  const refused = verdict.kind === "refused";
  return (
    <span
      aria-hidden
      data-thread-mention-drop-hint={verdict.kind}
      className={cn(
        "chat-pane-drop-in pointer-events-none absolute top-0 left-1/2 z-20 inline-flex max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-full border bg-popover px-2.5 py-1 text-xs font-medium shadow-sm",
        refused ? "border-dashed text-muted-foreground" : "text-foreground",
      )}
    >
      {refused ? (
        <BanIcon aria-hidden className="size-3.5 shrink-0" />
      ) : (
        <AtSignIcon aria-hidden className="size-3.5 shrink-0" />
      )}
      <span className="truncate">{threadMentionDropLabel(verdict)}</span>
    </span>
  );
}
