import { ChevronDownIcon, ListFilterIcon, LoaderCircleIcon, SearchIcon, XIcon } from "lucide-react";
import { useMemo, useRef, useState, type RefObject } from "react";

import { isElectron } from "../../../env";
import { cn } from "../../../lib/utils";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "../../ui/combobox";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { PULL_REQUESTS_BAR_CLASS, usePullRequestsLeadingInsetClass } from "../PullRequestBar";
import { KeyHint } from "../primitives";
import { usePullRequestsPage } from "../PullRequestsPageContext";
import { pullRequestRepositoryQualifier } from "../pullRequestRepositories.logic";
import {
  resolvePullRequestsSort,
  resolvePullRequestsStateFilter,
  type PullRequestsOnlyFilter,
  type PullRequestsSort,
  type PullRequestsStateFilter,
} from "../pullRequestsSearch";
import {
  PULL_REQUEST_FILTER_RESET,
  PULL_REQUEST_ONLY_OPTIONS,
  PULL_REQUEST_SORT_OPTIONS,
  PULL_REQUEST_STATE_OPTIONS,
  pullRequestFilterChips,
  togglePullRequestLabelFilter,
} from "./pullRequestListFilters.logic";
import type { PullRequestListSearch } from "./usePullRequestListSearch";

export type PullRequestListVariant = "docked" | "drawer" | "fill";

/** Clears the macOS traffic lights (or the WCO origin) in the drawer, which overlays the window's corner. */
const DRAWER_LEADING_INSET_CLASS = isElectron
  ? "pl-[84px] wco:pl-[calc(env(titlebar-area-x)+0.75rem)]"
  : "pl-2.5";

const ICON_BUTTON_CLASS =
  "relative inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground";

/**
 * The list's 52px bar: one search field (led by the repository when there is
 * more than one to choose from) and the filter menu. In the docked and fill
 * layouts it owns the window's top-left corner, so it carries the collapsed
 * sidebar inset and the drag region.
 */
export function ListHeader(props: {
  readonly variant: PullRequestListVariant;
  readonly search: PullRequestListSearch;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  /** Enter in the field with plain text: open the first row. */
  readonly onSubmit: () => void;
  /** ArrowDown in the field: move focus into the rows. */
  readonly onFocusRows: () => void;
}) {
  const { layout, repositories } = usePullRequestsPage();
  const leadingInset = usePullRequestsLeadingInsetClass(
    props.variant !== "drawer" && layout.leadingRegion === "list",
    "pl-2.5",
  );
  return (
    <header
      className={cn(
        PULL_REQUESTS_BAR_CLASS,
        "gap-1 pr-2",
        props.variant === "drawer" ? DRAWER_LEADING_INSET_CLASS : leadingInset,
      )}
    >
      <SearchField
        search={props.search}
        inputRef={props.inputRef}
        showHint={props.variant !== "drawer"}
        leaveOnEscape={props.variant !== "drawer"}
        leading={repositories.length > 1 ? <RepositorySwitcher /> : null}
        onSubmit={props.onSubmit}
        onFocusRows={props.onFocusRows}
      />
      <FilterMenu />
    </header>
  );
}

function SearchField(props: {
  readonly search: PullRequestListSearch;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly showHint: boolean;
  /** Escape in an empty field returns focus to the rows (the drawer closes instead). */
  readonly leaveOnEscape: boolean;
  readonly leading: React.ReactNode;
  readonly onSubmit: () => void;
  readonly onFocusRows: () => void;
}) {
  const { search } = props;
  const busy = search.server.isLoading;
  return (
    <div
      className={cn(
        // The whole field is clickable, so it never drags the window (Electron bar).
        "group/search flex h-8 min-w-0 flex-1 items-center rounded-lg bg-muted/80 text-muted-foreground transition-[background-color,box-shadow] duration-(--app-motion-duration-chip) [-webkit-app-region:no-drag]",
        "focus-within:bg-background focus-within:shadow-[inset_0_0_0_1px_var(--color-border),0_0_0_3px_--theme(--color-ring/12%)]",
      )}
    >
      {props.leading}
      <label className="flex h-full min-w-0 flex-1 cursor-text items-center gap-2 pr-1.5 pl-2.5">
        {busy ? (
          <LoaderCircleIcon aria-hidden className="size-3.5 shrink-0 animate-spin opacity-70" />
        ) : (
          <SearchIcon aria-hidden className="size-3.5 shrink-0 opacity-70" />
        )}
        <input
          ref={props.inputRef}
          type="text"
          value={search.text}
          spellCheck={false}
          autoComplete="off"
          aria-label="Search pull requests"
          placeholder="Search or paste a link"
          className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70"
          onChange={(event) => search.setText(event.target.value)}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData("text");
            // A pasted link opens right away; `#123` waits for Enter.
            if (/^\s*https?:\/\//iu.test(pasted) && search.openReference(pasted)) {
              event.preventDefault();
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (!search.openReference(search.text)) {
                // Let the rows catch up with what was typed, then open the first.
                search.flush();
                requestAnimationFrame(() => props.onSubmit());
              }
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              props.onFocusRows();
            } else if (event.key === "Escape" && search.text.length > 0) {
              // First Escape clears; the next one closes the drawer / leaves the field.
              event.preventDefault();
              event.stopPropagation();
              search.clear();
            } else if (event.key === "Escape" && props.leaveOnEscape) {
              // Back to the rows, so the page's single-key shortcuts work again.
              event.preventDefault();
              const input = event.currentTarget;
              props.onFocusRows();
              if (document.activeElement === input) input.blur();
            }
          }}
        />
        {search.text.length > 0 ? (
          <button
            type="button"
            aria-label="Clear search"
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/80 outline-hidden hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              search.clear();
              props.inputRef.current?.focus();
            }}
          >
            <XIcon aria-hidden className="size-3" />
          </button>
        ) : props.showHint ? (
          <KeyHint className="transition-opacity duration-(--app-motion-duration-chip) group-focus-within/search:opacity-0">
            /
          </KeyHint>
        ) : null}
      </label>
    </div>
  );
}

/** The repository, as the search field's leading segment. */
function RepositorySwitcher() {
  const { repository, repositories, nav } = usePullRequestsPage();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const items = useMemo(() => repositories.map((option) => option.key), [repositories]);
  const byKey = useMemo(
    () => new Map(repositories.map((option) => [option.key, option] as const)),
    [repositories],
  );
  const needle = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      needle.length === 0
        ? items
        : items.filter((key) => {
            const option = byKey.get(key);
            return (
              option !== undefined &&
              (option.name.toLowerCase().includes(needle) ||
                option.cwd.toLowerCase().includes(needle) ||
                (option.environmentLabel?.toLowerCase().includes(needle) ?? false))
            );
          }),
    [byKey, items, needle],
  );
  const choose = (key: string) => {
    const option = byKey.get(key);
    setOpen(false);
    setQuery("");
    if (option && option.key !== repository?.key) nav.selectRepository(option);
  };
  return (
    <Combobox
      items={items}
      filteredItems={filtered}
      autoHighlight
      open={open}
      value={repository?.key ?? null}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <ComboboxTrigger
        ref={triggerRef}
        aria-label={`Repository: ${repository?.name ?? "none"}`}
        render={<button type="button" />}
        className="ml-1 inline-flex h-6 max-w-[42%] shrink-0 items-center gap-1 rounded-md pr-1 pl-1.5 text-xs font-medium text-foreground/80 outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent"
      >
        <span className="truncate">{repository?.name ?? "Repository"}</span>
        <ChevronDownIcon aria-hidden className="size-3 shrink-0 opacity-60" />
      </ComboboxTrigger>
      <span aria-hidden className="ml-1 h-4 w-px shrink-0 bg-border" />
      <ComboboxPopup anchor={triggerRef} align="start" className="w-72 overflow-hidden">
        <div className="border-b p-1">
          <ComboboxInput
            className="rounded-md [&_input]:font-sans"
            inputClassName="ring-0"
            placeholder="Find a repository"
            showTrigger={false}
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <ComboboxEmpty>No repositories match.</ComboboxEmpty>
        <ComboboxList className="max-h-72">
          {filtered.map((key, index) => {
            const option = byKey.get(key);
            if (!option) return null;
            const environment = pullRequestRepositoryQualifier(option, repositories);
            return (
              <ComboboxItem key={key} index={index} value={key} onClick={() => choose(key)}>
                <span className="flex min-w-0 flex-col py-0.5">
                  <span className="truncate text-sm">
                    {option.name}
                    {environment ? (
                      <span className="text-muted-foreground"> · {environment}</span>
                    ) : null}
                  </span>
                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                    {option.cwd}
                  </span>
                </span>
              </ComboboxItem>
            );
          })}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

/** State, "only", labels, and sort; a dot on the button while any is off its default. */
function FilterMenu() {
  const { nav, model } = usePullRequestsPage();
  const search = nav.search;
  const state = resolvePullRequestsStateFilter(search);
  const sort = resolvePullRequestsSort(search);
  const labels = model.list.labels;
  const selectedLabels = new Set(search.label ?? []);
  const active = pullRequestFilterChips(search, labels).length > 0;
  const onlyOptions = PULL_REQUEST_ONLY_OPTIONS.filter(
    (option) => !option.needsInvolvement || model.list.involvementSupported,
  );
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Filter pull requests"
                  className={ICON_BUTTON_CLASS}
                >
                  <ListFilterIcon aria-hidden className="size-3.5" />
                  <span
                    aria-hidden
                    data-active={active}
                    className="pr-filter-dot absolute top-1.5 right-1.5 size-[5px] rounded-full bg-foreground/70"
                  />
                </button>
              }
            />
          }
        />
        <TooltipPopup side="bottom" sideOffset={4}>
          Filter
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" className="min-w-52">
        <MenuGroup>
          <MenuGroupLabel>Show</MenuGroupLabel>
          <MenuRadioGroup
            value={state}
            onValueChange={(value) =>
              nav.setSearch({
                state: value === "open" ? undefined : (value as PullRequestsStateFilter),
              })
            }
          >
            {PULL_REQUEST_STATE_OPTIONS.map((option) => (
              <MenuRadioItem key={option.value} value={option.value} closeOnClick>
                {option.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Only</MenuGroupLabel>
          <MenuRadioGroup
            value={search.only ?? "any"}
            onValueChange={(value) =>
              nav.setSearch({
                only: value === "any" ? undefined : (value as PullRequestsOnlyFilter),
              })
            }
          >
            <MenuRadioItem value="any" closeOnClick>
              Everything
            </MenuRadioItem>
            {onlyOptions.map((option) => (
              <MenuRadioItem key={option.value} value={option.value} closeOnClick>
                {option.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        {labels.length > 0 ? (
          <MenuSub>
            <MenuSubTrigger>
              Labels
              {selectedLabels.size > 0 ? (
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                  {selectedLabels.size}
                </span>
              ) : null}
            </MenuSubTrigger>
            <MenuSubPopup className="max-h-80 min-w-48">
              {labels.map((label) => (
                <MenuCheckboxItem
                  key={label.name}
                  checked={selectedLabels.has(label.name)}
                  onCheckedChange={() =>
                    nav.setSearch({
                      label: togglePullRequestLabelFilter(search.label, label.name),
                    })
                  }
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full bg-muted-foreground/50"
                      style={label.color ? { backgroundColor: `#${label.color}` } : undefined}
                    />
                    <span className="truncate">{label.name}</span>
                  </span>
                </MenuCheckboxItem>
              ))}
            </MenuSubPopup>
          </MenuSub>
        ) : null}
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Sort</MenuGroupLabel>
          <MenuRadioGroup
            value={sort}
            onValueChange={(value) =>
              nav.setSearch({
                sort: value === "readiness" ? undefined : (value as PullRequestsSort),
              })
            }
          >
            {PULL_REQUEST_SORT_OPTIONS.map((option) => (
              <MenuRadioItem key={option.value} value={option.value} closeOnClick>
                {option.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        {active ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => nav.setSearch(PULL_REQUEST_FILTER_RESET)}>
              Reset filters
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
