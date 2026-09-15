import { usePaneEffect, usePaneFocus } from "./PaneFocus";
import type { PromptStashEntry } from "@ryco/client-runtime/state/composer";
import { BookmarkIcon, Trash2Icon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { cn } from "~/lib/utils";
import { Command, CommandGroup, CommandGroupLabel, CommandItem, CommandList } from "../ui/command";
import { Button } from "../ui/button";

const STASH_PREVIEW_MAX_CHARS = 100;

function entryPreview(entry: PromptStashEntry): string {
  const compact = entry.prompt.trim().replace(/\s+/g, " ");
  if (compact.length > 0) {
    return compact.length > STASH_PREVIEW_MAX_CHARS
      ? `${compact.slice(0, STASH_PREVIEW_MAX_CHARS)}…`
      : compact;
  }
  const imageCount =
    entry.attachments.length +
    entry.pendingImageCount +
    entry.droppedImageNames.length +
    entry.unreadableImageNames.length;
  return imageCount === 1 ? "(1 image)" : `(${imageCount} images)`;
}

function missingImageCount(entry: PromptStashEntry): number {
  return entry.droppedImageNames.length + entry.unreadableImageNames.length;
}

function isNestedInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("button, a, input, select, textarea, [contenteditable], [role=button]") !== null
  );
}

export const ComposerStashPicker = memo(function ComposerStashPicker(props: {
  entries: ReadonlyArray<PromptStashEntry>;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const paneFocused = usePaneFocus();
  const { entries, onRestore, onDelete, onClose } = props;
  const [selectedId, setSelectedId] = useState<string | null>(entries[0]?.id ?? null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedEntry = entries.find((entry) => entry.id === selectedId) ?? entries[0] ?? null;

  usePaneEffect(() => {
    pickerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!selectedEntry) {
      setSelectedId(null);
      return;
    }
    if (selectedEntry.id !== selectedId) {
      setSelectedId(selectedEntry.id);
    }
  }, [selectedEntry, selectedId]);

  useEffect(() => {
    if (!selectedId || !listRef.current) return;
    listRef.current
      .querySelector<HTMLElement>(`[data-prompt-stash-row="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  usePaneEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (!pickerRef.current?.contains(document.activeElement)) {
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (entries.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        const currentIndex = entries.findIndex((entry) => entry.id === selectedId);
        const offset = event.key === "ArrowDown" ? 1 : -1;
        const baseIndex = currentIndex >= 0 ? currentIndex : offset > 0 ? -1 : 0;
        const nextIndex = (baseIndex + offset + entries.length) % entries.length;
        setSelectedId(entries[nextIndex]?.id ?? null);
        return;
      }
      if (event.key === "Enter") {
        if (isNestedInteractiveTarget(event.target) || !selectedEntry) return;
        event.preventDefault();
        event.stopPropagation();
        onRestore(selectedEntry.id);
        return;
      }
      if (
        event.key === "Backspace" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        selectedEntry
      ) {
        event.preventDefault();
        event.stopPropagation();
        onDelete(selectedEntry.id);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [entries, onClose, onDelete, onRestore, selectedEntry, selectedId]);

  if (!paneFocused) return null;

  return (
    <div
      ref={pickerRef}
      role="region"
      aria-label="Stashed prompts"
      tabIndex={-1}
      data-prompt-stash-picker="true"
      className="absolute right-0 bottom-[calc(100%+0.75rem)] z-30 w-[min(28rem,calc(100vw-2rem))]"
    >
      <Command autoHighlight={false} mode="none">
        <div className="app-surface relative overflow-hidden rounded-xl border border-border/80 bg-popover/96 shadow-lg/8 backdrop-blur-xs">
          <CommandList ref={listRef} className="max-h-72">
            <CommandGroup>
              <CommandGroupLabel className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/55">
                <BookmarkIcon className="size-3" aria-hidden="true" />
                Stashed prompts
              </CommandGroupLabel>
              {entries.length === 0 ? (
                <p className="px-3 pt-1 pb-3 text-xs text-muted-foreground/70">
                  Nothing stashed yet. Use the stash shortcut with a prompt or image to save it.
                </p>
              ) : (
                entries.map((entry) => {
                  const missingCount = missingImageCount(entry);
                  return (
                    <CommandItem
                      key={entry.id}
                      value={entry.id}
                      data-prompt-stash-row={entry.id}
                      className={cn(
                        "group/stash cursor-pointer select-none gap-2 hover:bg-transparent hover:text-inherit data-highlighted:bg-transparent data-highlighted:text-inherit",
                        selectedId === entry.id && "bg-accent! text-accent-foreground!",
                      )}
                      onMouseMove={() => setSelectedId(entry.id)}
                      onMouseDown={(event) => {
                        if (!isNestedInteractiveTarget(event.target)) {
                          event.preventDefault();
                        }
                      }}
                      onClick={(event) => {
                        if (!isNestedInteractiveTarget(event.target)) {
                          onRestore(entry.id);
                        }
                      }}
                    >
                      {entry.attachments.length > 0 ? (
                        <span className="-space-x-1.5 flex shrink-0 items-center">
                          {entry.attachments.slice(0, 3).map((attachment) => (
                            <img
                              key={attachment.id}
                              src={attachment.dataUrl}
                              alt=""
                              aria-hidden="true"
                              className="size-6 rounded border border-border/70 object-cover"
                            />
                          ))}
                        </span>
                      ) : (
                        <BookmarkIcon className="size-4 shrink-0 text-muted-foreground/60" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-sm">{entryPreview(entry)}</span>
                      {entry.pendingImageCount > 0 ? (
                        <span
                          data-prompt-stash-pending="true"
                          className="shrink-0 text-[10px] text-muted-foreground/65"
                        >
                          saving {entry.pendingImageCount} image
                          {entry.pendingImageCount === 1 ? "" : "s"}…
                        </span>
                      ) : missingCount > 0 ? (
                        <span className="shrink-0 text-[10px] text-amber-600">
                          {missingCount} image{missingCount === 1 ? "" : "s"} not saved
                        </span>
                      ) : entry.attachments.length > 0 ? (
                        <span className="shrink-0 text-[10px] text-muted-foreground/65">
                          {entry.attachments.length} image
                          {entry.attachments.length === 1 ? "" : "s"}
                        </span>
                      ) : null}
                      <span className="shrink-0 text-xs text-muted-foreground/60">
                        {formatRelativeTimeLabel(entry.createdAt)}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        data-prompt-stash-delete={entry.id}
                        className="shrink-0 opacity-55 transition-opacity motion-reduce:transition-none group-hover/stash:opacity-100 focus:opacity-100"
                        aria-label={`Delete stashed prompt: ${entryPreview(entry)}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onDelete(entry.id);
                        }}
                      >
                        <Trash2Icon />
                      </Button>
                    </CommandItem>
                  );
                })
              )}
            </CommandGroup>
          </CommandList>
        </div>
      </Command>
    </div>
  );
});
