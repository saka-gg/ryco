import { usePaneEffect } from "./PaneFocus";
import { useRef } from "react";
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ThreadMessageSearchBarProps {
  query: string;
  focusRequestId: number;
  matchCount: number;
  selectedIndex: number;
  onQueryChange: (query: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}

export function ThreadMessageSearchBar({
  query,
  focusRequestId,
  matchCount,
  selectedIndex,
  onQueryChange,
  onNext,
  onPrevious,
  onClose,
}: ThreadMessageSearchBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const trimmedQuery = query.trim();
  const statusLabel =
    trimmedQuery.length === 0
      ? "Thread"
      : matchCount > 0
        ? `${selectedIndex + 1} / ${matchCount}`
        : "No results";

  usePaneEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [focusRequestId]);

  return (
    <div className="pointer-events-none absolute inset-x-0 top-[calc(var(--chat-header-clearance,0px)+0.75rem)] z-30 flex justify-center px-3">
      <form
        className="pointer-events-auto flex h-9 w-full max-w-md items-center gap-1 rounded-lg border border-border/80 bg-popover/96 px-1.5 shadow-lg/12 backdrop-blur"
        data-thread-message-search="true"
        onSubmit={(event) => {
          event.preventDefault();
          onNext();
        }}
      >
        <SearchIcon className="ml-1 size-4 shrink-0 text-muted-foreground/70" aria-hidden />
        <Input
          ref={inputRef}
          type="search"
          size="sm"
          unstyled
          value={query}
          placeholder="Find in thread"
          aria-label="Find in thread"
          className="min-w-0 flex-1"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
              return;
            }
            if (event.key !== "Enter") {
              return;
            }
            event.preventDefault();
            if (event.shiftKey) {
              onPrevious();
            } else {
              onNext();
            }
          }}
        />
        <span className="min-w-14 shrink-0 text-right text-xs text-muted-foreground/75">
          {statusLabel}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label="Previous match"
                disabled={matchCount === 0}
                size="icon-xs"
                type="button"
                variant="ghost"
                onClick={onPrevious}
              >
                <ChevronUpIcon className="size-3.5" />
              </Button>
            }
          />
          <TooltipPopup>Previous match</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label="Next match"
                disabled={matchCount === 0}
                size="icon-xs"
                type="button"
                variant="ghost"
                onClick={onNext}
              >
                <ChevronDownIcon className="size-3.5" />
              </Button>
            }
          />
          <TooltipPopup>Next match</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label="Close find"
                size="icon-xs"
                type="button"
                variant="ghost"
                onClick={onClose}
              >
                <XIcon className="size-3.5" />
              </Button>
            }
          />
          <TooltipPopup>Close find</TooltipPopup>
        </Tooltip>
      </form>
    </div>
  );
}
