import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@ryco/contracts";
import { AtSignIcon, BanIcon } from "lucide-react";
import { useCallback, useEffect, useState, type DragEvent as ReactDragEvent } from "react";

import { decodePaneRef, PANE_DRAG_TYPE } from "../../chatPanes.logic";
import { endPaneDrag, readPaneDragSource } from "../../chatPanesStore";
import { isThreadMentionableId } from "../../composer-editor-mentions";
import {
  endWorkspaceFileDrag,
  isWorkspaceFileDrag,
  readWorkspaceFileDragSource,
  readWorkspaceFileDrop,
  resolveWorkspaceFileDrop,
  workspaceFileDropLabel,
  type WorkspaceFileDropVerdict,
} from "../../workspaceFileDrag";
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

/** What a drop on the composer would do with a drag: mention what it carries, or nothing. */
interface MentionDropVerdict {
  readonly kind: "mention" | "refused";
  readonly reason?: string;
}

/** A drag kind the composer turns into a mention. */
interface MentionDropKind<TVerdict extends MentionDropVerdict> {
  readonly matches: (transfer: DataTransfer) => boolean;
  /** The verdict while the drag hovers; a drag's data stays hidden until the drop. */
  readonly preview: (transfer: DataTransfer) => TVerdict;
  /** Takes the drop; the browser's own drop (pasting the drag's text) is already prevented. */
  readonly drop: (transfer: DataTransfer) => void;
}

function isThreadDrag(transfer: DataTransfer): boolean {
  return transfer.types.includes(PANE_DRAG_TYPE);
}

/**
 * Drags of one kind over the composer. Each handler returns whether the event
 * was of that kind, so the caller hands every other drag (files) on.
 */
function useComposerMentionDrop<TVerdict extends MentionDropVerdict>(
  kind: MentionDropKind<TVerdict>,
) {
  const { matches, preview, drop } = kind;
  const [verdict, setVerdict] = useState<TVerdict | null>(null);
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
      if (!matches(event.dataTransfer)) return false;
      const next = preview(event.dataTransfer);
      if (next.kind === "mention") {
        event.preventDefault();
        // Pane titles only allow moves; sidebar rows and file rows allow copies.
        event.dataTransfer.dropEffect =
          event.dataTransfer.effectAllowed === "move" ? "move" : "copy";
      } else {
        event.dataTransfer.dropEffect = "none";
      }
      setVerdict((current) =>
        current?.kind === next.kind && current.reason === next.reason ? current : next,
      );
      return true;
    },
    [matches, preview],
  );

  const onDragLeave = useCallback(
    (event: ReactDragEvent<HTMLElement>): boolean => {
      if (!matches(event.dataTransfer)) return false;
      const next = event.relatedTarget;
      if (!(next instanceof Node && event.currentTarget.contains(next))) setVerdict(null);
      return true;
    },
    [matches],
  );

  const onDrop = useCallback(
    (event: ReactDragEvent<HTMLElement>): boolean => {
      if (!matches(event.dataTransfer)) return false;
      event.preventDefault();
      setVerdict(null);
      drop(event.dataTransfer);
      return true;
    },
    [drop, matches],
  );

  return { verdict, onDragOver, onDragLeave, onDrop };
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
  const preview = useCallback(
    () =>
      resolveThreadMentionDrop({ source: readPaneDragSource(), environmentId, threadId, disabled }),
    [disabled, environmentId, threadId],
  );
  const drop = useCallback(
    (transfer: DataTransfer) => {
      endPaneDrag();
      let source: ScopedThreadRef | null = null;
      try {
        source = decodePaneRef(JSON.parse(transfer.getData(PANE_DRAG_TYPE)));
      } catch {
        /* unrelated/malformed drag */
      }
      if (!source) return;
      const outcome = resolveThreadMentionDrop({ source, environmentId, threadId, disabled });
      if (outcome.kind === "refused") {
        toastManager.add({ type: "info", title: threadMentionDropLabel(outcome) });
        return;
      }
      onMention(source.threadId);
    },
    [disabled, environmentId, onMention, threadId],
  );
  return useComposerMentionDrop({ matches: isThreadDrag, preview, drop });
}

/**
 * Files dragged from the Files panel tree over the composer: a drop mentions
 * the file (`@path`), which the agent reads on its node. A path only means
 * something inside the workspace it is relative to, so a file of another
 * machine or workspace is refused.
 */
export function useComposerWorkspaceFileDrop(input: {
  readonly environmentId: EnvironmentId;
  /** The directory the composer's thread works in; null while unknown. */
  readonly workspaceRoot: string | null;
  readonly disabled: boolean;
  readonly onMention: (path: string) => void;
}) {
  const { environmentId, workspaceRoot, disabled, onMention } = input;
  const preview = useCallback(
    (transfer: DataTransfer): WorkspaceFileDropVerdict =>
      resolveWorkspaceFileDrop({
        source: readWorkspaceFileDragSource(transfer),
        environmentId,
        workspaceRoot,
        disabled,
      }),
    [disabled, environmentId, workspaceRoot],
  );
  const drop = useCallback(
    (transfer: DataTransfer) => {
      endWorkspaceFileDrag();
      const source = readWorkspaceFileDrop(transfer);
      if (!source) return;
      const outcome = resolveWorkspaceFileDrop({ source, environmentId, workspaceRoot, disabled });
      if (outcome.kind === "refused") {
        toastManager.add({ type: "info", title: workspaceFileDropLabel(outcome) });
        return;
      }
      onMention(source.path);
    },
    [disabled, environmentId, onMention, workspaceRoot],
  );
  return useComposerMentionDrop({ matches: isWorkspaceFileDrag, preview, drop });
}

/** Names what a drop on the composer does, or why it does nothing. */
export function ComposerMentionDropHint(props: {
  readonly refused: boolean;
  readonly label: string;
}) {
  const { refused, label } = props;
  return (
    <span
      aria-hidden
      data-composer-mention-drop-hint={refused ? "refused" : "mention"}
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
      <span className="truncate">{label}</span>
    </span>
  );
}

export function ThreadMentionDropHint({ verdict }: { readonly verdict: ThreadMentionDropVerdict }) {
  return (
    <ComposerMentionDropHint
      refused={verdict.kind === "refused"}
      label={threadMentionDropLabel(verdict)}
    />
  );
}
