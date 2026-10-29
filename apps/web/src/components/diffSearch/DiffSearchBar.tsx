import {
  CaseSensitiveIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  RegexIcon,
  SearchIcon,
  WholeWordIcon,
  XIcon,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";

import { cn } from "~/lib/utils";
import type { DiffSearchOptions } from "~/lib/diffSearch";

import type { DiffSearchController } from "./useDiffSearch";

export interface DiffSearchBarProps {
  readonly search: DiffSearchController;
  /** Accessible name of the field. */
  readonly label: string;
  readonly placeholder: string;
  /**
   * `phone`: the frozen phone tier's bar, unchanged (44 px targets, no option
   * toggles, Escape is left to bubble).
   */
  readonly presentation: "desktop" | "phone";
  /** Escape in the field. */
  readonly onEscape: () => void;
}

const ICON_BUTTON_CLASS_NAME =
  "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground";

const OPTION_TOGGLES: ReadonlyArray<{
  readonly option: keyof DiffSearchOptions;
  readonly label: string;
  readonly Icon: ComponentType<SVGProps<SVGSVGElement>>;
}> = [
  { option: "caseSensitive", label: "Match case", Icon: CaseSensitiveIcon },
  { option: "wholeWord", label: "Match whole word", Icon: WholeWordIcon },
  { option: "regex", label: "Use regular expression", Icon: RegexIcon },
];

/** The find row of a diff: field, option toggles, counter, previous/next and clear. */
export function DiffSearchBar({
  search,
  label,
  placeholder,
  presentation,
  onEscape,
}: DiffSearchBarProps) {
  const phone = presentation === "phone";
  const { inputRef, result } = search;
  const count = result.matches.length;
  const partial = result.truncated || result.stopped;
  return (
    <div
      role="search"
      className="flex shrink-0 items-center gap-2 border-b border-border/50 bg-card/40 px-2.5 py-1.5 [-webkit-app-region:no-drag]"
    >
      <SearchIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
      <input
        ref={inputRef}
        type="text"
        value={search.query}
        onChange={(event) => search.setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            // A sheet hosting the diff stays open; the phone surface keeps its behaviour.
            if (!phone) event.stopPropagation();
            onEscape();
            return;
          }
          if (event.key === "Enter" && search.searching) {
            event.preventDefault();
            search.goTo(event.shiftKey ? -1 : 1);
          }
        }}
        placeholder={placeholder}
        aria-label={label}
        aria-invalid={result.invalidPattern || undefined}
        // Queries are identifiers and patterns, not prose (the phone tier keeps its behaviour).
        spellCheck={phone ? undefined : false}
        className={cn(
          "min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/55",
          phone && "min-h-[44px]",
        )}
      />
      {phone ? null : (
        <div className="flex shrink-0 items-center gap-0.5">
          {OPTION_TOGGLES.map(({ option, label: toggleLabel, Icon }) => {
            const pressed = search.options[option];
            return (
              <button
                key={option}
                type="button"
                aria-label={toggleLabel}
                title={toggleLabel}
                aria-pressed={pressed}
                // The field keeps focus, so Enter still steps through matches.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => search.toggleOption(option)}
                className={cn(
                  ICON_BUTTON_CLASS_NAME,
                  pressed && "bg-foreground/10 text-foreground",
                )}
              >
                <Icon className="size-3.5" />
              </button>
            );
          })}
        </div>
      )}
      {search.searching && (
        <>
          {result.invalidPattern ? (
            <span className="shrink-0 text-[10px] text-destructive/80" aria-live="polite">
              Invalid pattern
            </span>
          ) : (
            <span
              className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70"
              aria-live="polite"
              title={
                result.stopped
                  ? "Search stopped (pattern too slow)"
                  : result.truncated
                    ? `Showing the first ${count} matches`
                    : undefined
              }
            >
              {count === 0 ? 0 : search.currentIndex + 1} of {count}
              {partial ? "+" : ""}
            </span>
          )}
          {result.stopped ? (
            <span className="min-w-0 truncate text-[10px] text-muted-foreground/70">
              Search stopped (pattern too slow)
            </span>
          ) : null}
          <div className="flex shrink-0 items-center">
            <button
              type="button"
              onClick={() => search.goTo(-1)}
              disabled={count === 0}
              className={cn(
                ICON_BUTTON_CLASS_NAME,
                "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/70",
                phone && "size-[44px]",
              )}
              aria-label="Previous match"
              title="Previous match (Shift+Enter)"
            >
              <ChevronUpIcon className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => search.goTo(1)}
              disabled={count === 0}
              className={cn(
                ICON_BUTTON_CLASS_NAME,
                "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/70",
                phone && "size-[44px]",
              )}
              aria-label="Next match"
              title="Next match (Enter)"
            >
              <ChevronDownIcon className="size-3.5" />
            </button>
          </div>
        </>
      )}
      {search.query && (
        <button
          type="button"
          onClick={() => {
            search.clear();
            inputRef.current?.focus();
          }}
          className={cn(ICON_BUTTON_CLASS_NAME, "size-4", phone && "size-[44px]")}
          aria-label="Clear search"
          title="Clear search"
        >
          <XIcon className="size-3" />
        </button>
      )}
    </div>
  );
}
