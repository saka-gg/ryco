import type { EnvironmentId } from "@ryco/contracts";
import { SearchIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { useCommandPaletteStore } from "../../commandPaletteStore";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { PREFERS_REDUCED_MOTION_QUERY } from "../../lib/perf/motion";
import { cn, isMacPlatform } from "../../lib/utils";
import type { SidebarMode } from "../../uiStateStore";
import { useInboxFilterStore } from "../inboxSidebar/inboxFilterStore";
import type { InboxSidebarEnvironment } from "../inboxSidebar/inboxSidebarModel";
import { CommandDialogTrigger } from "../ui/command";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSidebarFoldStore } from "./sidebarFold";
import {
  buildOmnifieldSuggestions,
  INBOX_STATUS_OPTIONS,
  type OmnifieldOption,
  type OmnifieldSuggestionRow,
  omnifieldMachines,
  parseOmnifieldInput,
  removeTypedToken,
  splitLabelAtTerm,
} from "./sidebarOmnifield.logic";

/** Unfolding takes the press; the field takes focus once the morph is under way. */
const FOCUS_AFTER_UNFOLD_MS = 160;

interface OmnifieldToken {
  readonly key: string;
  readonly kind: "machine" | "status";
  readonly label: string;
  readonly online: boolean;
}

export interface SidebarOmnifieldProps {
  readonly mode: SidebarMode;
  readonly folded: boolean;
  readonly environments: ReadonlyArray<InboxSidebarEnvironment>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly paletteShortcutLabel: string | null;
}

/**
 * The sidebar header's field (see sidebarOmnifield.logic.ts). In Inbox mode it
 * narrows the list and holds the machine and status filters as tokens; in
 * Projects mode it only searches.
 */
export function SidebarOmnifield(props: SidebarOmnifieldProps) {
  const { mode, folded } = props;
  const inboxDraft = useInboxFilterStore((store) => store.draft);
  const setInboxDraft = useInboxFilterStore((store) => store.setDraft);
  const environmentId = useInboxFilterStore((store) => store.environmentId);
  const setEnvironmentId = useInboxFilterStore((store) => store.setEnvironmentId);
  const status = useInboxFilterStore((store) => store.status);
  const setStatus = useInboxFilterStore((store) => store.setStatus);
  const matchCount = useInboxFilterStore((store) => store.matchCount);
  const sectionCounts = useInboxFilterStore((store) => store.sectionCounts);
  const unfold = useSidebarFoldStore((store) => store.unfold);
  const setFoldBusy = useSidebarFoldStore((store) => store.setBusy);
  const openSearch = useCommandPaletteStore((store) => store.openSearch);
  const prefersReducedMotion = useMediaQuery(PREFERS_REDUCED_MOTION_QUERY);

  // Projects mode searches only; its text is not kept when the sidebar switches back.
  const [projectsDraft, setProjectsDraft] = useState("");
  const value = mode === "inbox" ? inboxDraft : projectsDraft;
  const setValue = mode === "inbox" ? setInboxDraft : setProjectsDraft;

  const [menuOpen, setMenuOpen] = useState(false);
  const [showAllFilters, setShowAllFilters] = useState(false);
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [armed, setArmed] = useState(false);
  const fieldRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const unfoldedByPressRef = useRef(false);
  const menuId = useId();

  // A mode switch starts the field over (the Inbox text itself lives in the store).
  const [renderedMode, setRenderedMode] = useState(mode);
  if (renderedMode !== mode) {
    setRenderedMode(mode);
    setProjectsDraft("");
    setMenuOpen(false);
    setShowAllFilters(false);
    setArmed(false);
  }

  useEffect(() => {
    setFoldBusy(focused || menuOpen);
  }, [focused, menuOpen, setFoldBusy]);
  useEffect(() => () => setFoldBusy(false), [setFoldBusy]);

  const machines = useMemo(
    () => omnifieldMachines(props.environments, props.primaryEnvironmentId),
    [props.environments, props.primaryEnvironmentId],
  );
  const rows = useMemo(
    () =>
      buildOmnifieldSuggestions({
        mode,
        value,
        showAllFilters,
        machines,
        statusCounts: sectionCounts,
        matchCount,
        paletteShortcutLabel: props.paletteShortcutLabel,
      }),
    [machines, matchCount, mode, props.paletteShortcutLabel, sectionCounts, showAllFilters, value],
  );
  const options = useMemo<ReadonlyArray<OmnifieldOption>>(
    () => rows.flatMap((row) => (row.type === "option" ? [row.option] : [])),
    [rows],
  );
  const keyedRows = useMemo(() => {
    const optionRows = rows.filter((row) => row.type === "option");
    return rows.map((row) =>
      row.type === "option"
        ? { key: optionKey(row.option), row, optionIndex: optionRows.indexOf(row) }
        : { key: chromeRowKey(row), row, optionIndex: -1 },
    );
  }, [rows]);
  const activeIndex = Math.min(highlight, Math.max(0, options.length - 1));

  const tokens = useMemo<ReadonlyArray<OmnifieldToken>>(() => {
    if (mode !== "inbox") return [];
    const next: OmnifieldToken[] = [];
    if (environmentId) {
      const machine = machines.find((candidate) => candidate.environmentId === environmentId);
      const label = machine?.label ?? "Unknown machine";
      next.push({
        key: `machine:${environmentId}`,
        kind: "machine",
        label,
        online: machine?.online ?? false,
      });
    }
    if (status !== "all") {
      const label = INBOX_STATUS_OPTIONS.find((option) => option.value === status)?.label ?? status;
      next.push({ key: `status:${status}`, kind: "status", label, online: false });
    }
    return next;
  }, [environmentId, machines, mode, status]);
  const leavingTokens = useLeavingTokens(tokens, !prefersReducedMotion);
  const filterCount = tokens.length;

  const focusInput = () => inputRef.current?.focus();
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setShowAllFilters(false);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target as Node;
      if (fieldRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [closeMenu, menuOpen]);

  const escalate = (query: string) => {
    openSearch(query);
    closeMenu();
    inputRef.current?.blur();
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    const parsed = parseOmnifieldInput(value, mode);
    switch (option.kind) {
      case "insert":
        setValue(`${value}${value && !value.endsWith(" ") ? " " : ""}${option.token}`);
        setShowAllFilters(false);
        focusInput();
        return;
      case "everywhere":
        escalate(option.query);
        return;
      case "machine":
        setEnvironmentId(option.environmentId);
        break;
      case "status":
        setStatus(option.status);
        break;
    }
    if (parsed.kind === "machine" || parsed.kind === "status") {
      setValue(removeTypedToken(value, parsed.cut));
    }
    setShowAllFilters(false);
    setArmed(false);
    setHighlight(0);
    focusInput();
  };

  const removeToken = (token: OmnifieldToken) => {
    if (token.kind === "machine") setEnvironmentId(null);
    else setStatus("all");
    setArmed(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const count = Math.max(1, options.length);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setMenuOpen(true);
      setHighlight((activeIndex + 1) % count);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setMenuOpen(true);
      setHighlight((activeIndex - 1 + count) % count);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const parsed = parseOmnifieldInput(value, mode);
      const escalateKey = isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
      if (escalateKey && parsed.kind === "text") escalate(parsed.term);
      else choose(activeIndex);
    } else if (event.key === "Escape") {
      closeMenu();
      inputRef.current?.blur();
    } else if (event.key === "Backspace" && value === "" && tokens.length > 0) {
      // The first Backspace arms the last token, the second removes it.
      event.preventDefault();
      if (!armed) setArmed(true);
      else removeToken(tokens[tokens.length - 1]!);
    }
  };

  const onFieldPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (folded) {
      event.preventDefault();
      unfoldedByPressRef.current = true;
      unfold();
      window.setTimeout(focusInput, FOCUS_AFTER_UNFOLD_MS);
      return;
    }
    if (!(event.target as HTMLElement).closest("button, input")) {
      event.preventDefault();
      focusInput();
    }
  };

  const onLeadClick = () => {
    // The press that unfolded the header has done its job; it doesn't open the menu.
    if (unfoldedByPressRef.current) {
      unfoldedByPressRef.current = false;
      return;
    }
    if (mode === "projects") {
      focusInput();
      return;
    }
    const next = !(showAllFilters && menuOpen);
    setShowAllFilters(next);
    setHighlight(0);
    focusInput();
    setMenuOpen(next);
  };

  const filterMenuOpen = menuOpen && showAllFilters;
  const menuVisible = menuOpen && !folded;
  const typing = value.length > 0;
  const fieldLabel = mode === "inbox" ? "Filter inbox" : "Search";
  const placeholder =
    mode === "projects" ? "Search" : tokens.length > 0 ? "Filter…" : "Filter, or type @ or is:";
  const optionId = (index: number) => `${menuId}-option-${index}`;

  return (
    <>
      <Tooltip disabled={!folded}>
        <TooltipTrigger
          render={
            <div
              ref={fieldRef}
              data-tokens={tokens.length > 0}
              data-typing={typing}
              onPointerDown={onFieldPointerDown}
              className="sidebar-fold-item sidebar-fold-field flex cursor-text items-center gap-[3px] overflow-hidden rounded-[10px] border border-input bg-foreground/[0.035] focus-within:border-ring focus-within:bg-foreground/5 focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--ring)_18%,transparent)]"
              data-testid="sidebar-omnifield"
            />
          }
        >
          <button
            type="button"
            {...(mode === "inbox"
              ? { "aria-label": "Filter by machine and status", "aria-expanded": filterMenuOpen }
              : // Only focuses the field, which already carries the "Search" name.
                { "aria-hidden": true, tabIndex: -1 })}
            data-on={filterCount > 0}
            onClick={onLeadClick}
            className="sidebar-omnifield-lead relative grid h-[22px] w-6 shrink-0 place-items-center rounded-[6px] text-muted-foreground/75 outline-none transition-colors duration-(--app-motion-duration-chip) hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-sidebar-accent aria-expanded:text-foreground data-[on=true]:text-foreground"
          >
            <span className="sidebar-omnifield-icon" data-shown={mode === "inbox"}>
              <svg
                aria-hidden
                viewBox="0 0 24 24"
                className="sidebar-omnifield-funnel size-3.5 fill-none stroke-current"
                strokeWidth={2}
                strokeLinecap="round"
              >
                <path d="M3 6h18" />
                <path d="M7 12h10" />
                <path d="M10 18h4" />
              </svg>
            </span>
            <span className="sidebar-omnifield-icon" data-shown={mode === "projects"}>
              <SearchIcon aria-hidden className="size-3.5" />
            </span>
            <span
              aria-hidden
              data-shown={filterCount > 0}
              className="sidebar-omnifield-count grid h-3.5 min-w-3.5 place-items-center overflow-hidden rounded-full bg-foreground px-[3px] text-[9px] font-bold text-background"
            >
              {filterCount > 0 ? (
                <span key={filterCount} className="sidebar-omnifield-count-roll block leading-3.5">
                  {filterCount}
                </span>
              ) : null}
            </span>
          </button>
          <span className="sidebar-omnifield-tokens flex min-w-0 max-w-[calc(100%-40px)] shrink gap-[3px] overflow-hidden">
            {[...tokens, ...leavingTokens.list]
              .toSorted((left, right) =>
                left.kind === right.kind ? 0 : left.kind === "machine" ? -1 : 1,
              )
              .map((token) => {
                const leaving = !tokens.includes(token);
                return (
                  <button
                    key={leaving ? `${token.key}:leaving` : token.key}
                    type="button"
                    tabIndex={-1}
                    aria-label={`Remove ${token.kind} filter ${token.label}`}
                    data-kind={token.kind}
                    data-leaving={leaving || undefined}
                    data-armed={armed && token === tokens[tokens.length - 1]}
                    onClick={() => removeToken(token)}
                    onAnimationEnd={leaving ? () => leavingTokens.done(token) : undefined}
                    className={cn(
                      "sidebar-omnifield-token inline-flex h-5 min-w-0 shrink items-center gap-1 overflow-hidden whitespace-nowrap rounded-[6px] px-1.5 text-[10.5px] outline-none",
                      token.kind === "machine"
                        ? "bg-sky-500/12 text-sky-700 dark:bg-sky-400/14 dark:text-sky-300"
                        : "bg-amber-500/14 text-amber-700 dark:bg-amber-400/13 dark:text-amber-300",
                    )}
                  >
                    {token.kind === "machine" ? <MachineDot online={token.online} /> : null}
                    <span
                      className={
                        token.kind === "machine" ? "sidebar-omnifield-token-label" : undefined
                      }
                    >
                      {token.label}
                    </span>
                  </button>
                );
              })}
          </span>
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            autoComplete="off"
            spellCheck={false}
            aria-label={fieldLabel}
            aria-expanded={menuOpen}
            aria-controls={menuId}
            aria-autocomplete="list"
            aria-activedescendant={
              menuOpen && options.length > 0 ? optionId(activeIndex) : undefined
            }
            placeholder={placeholder}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setShowAllFilters(false);
              setArmed(false);
              setHighlight(0);
              setMenuOpen(true);
            }}
            onFocus={() => {
              setFocused(true);
              if (folded) unfold();
              setMenuOpen(true);
            }}
            onBlur={(event) => {
              setFocused(false);
              setArmed(false);
              // Tabbing away closes the menu; moving to the field's own buttons does not.
              const next = event.relatedTarget as Node | null;
              if (next && (fieldRef.current?.contains(next) || menuRef.current?.contains(next))) {
                return;
              }
              closeMenu();
            }}
            onKeyDown={onKeyDown}
            className="h-full min-w-4 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
          />
          <CommandDialogTrigger
            data-testid="command-palette-trigger"
            aria-label="Search everywhere"
            className="sidebar-omnifield-kbd grid shrink-0 place-items-center rounded-[4px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {props.paletteShortcutLabel ? (
              <kbd className="block rounded-[4px] bg-foreground/7 px-[5px] py-[3px] font-sans text-[10px] font-medium leading-none text-muted-foreground/75 pointer-coarse:hidden">
                {props.paletteShortcutLabel}
              </kbd>
            ) : null}
            {/* Touch has no shortcut to show; the chip still opens the palette. */}
            <SearchIcon
              aria-hidden
              className={cn(
                "size-3.5 text-muted-foreground/75",
                props.paletteShortcutLabel && "hidden pointer-coarse:block",
              )}
            />
          </CommandDialogTrigger>
        </TooltipTrigger>
        <TooltipPopup side="bottom">{mode === "inbox" ? "Filter tasks" : "Search"}</TooltipPopup>
      </Tooltip>
      <div
        ref={menuRef}
        id={menuId}
        role="listbox"
        aria-label={mode === "inbox" ? "Filters and search" : "Search"}
        data-open={menuVisible}
        // Closed, it only fades out; keep it out of reach of assistive tech too.
        inert={!menuVisible}
        // Keep focus in the field while choosing.
        onPointerDown={(event) => event.preventDefault()}
        className="sidebar-omnifield-menu rounded-xl border border-foreground/10 bg-popover p-1 text-popover-foreground shadow-[0_16px_40px_-16px_rgba(0,0,0,0.8),0_2px_8px_rgba(0,0,0,0.4)]"
      >
        {keyedRows.map(({ key, row, optionIndex }) =>
          row.type === "option" ? (
            <SuggestionOption
              key={key}
              id={optionId(optionIndex)}
              row={row}
              escalateShortcut={
                mode === "inbox" ? (isMacPlatform(navigator.platform) ? "⌘↵" : "Ctrl ↵") : "↵"
              }
              highlighted={optionIndex === activeIndex}
              onHighlight={() => setHighlight(optionIndex)}
              onChoose={() => choose(optionIndex)}
            />
          ) : (
            <SuggestionChrome key={key} row={row} />
          ),
        )}
      </div>
    </>
  );
}

function optionKey(option: OmnifieldOption): string {
  switch (option.kind) {
    case "insert":
      return `insert:${option.token}`;
    case "machine":
      return `machine:${option.environmentId}`;
    case "status":
      return `status:${option.status}`;
    case "everywhere":
      return "everywhere";
  }
}

/** Menus hold at most one separator, and groups and hints never repeat. */
function chromeRowKey(row: Exclude<OmnifieldSuggestionRow, { type: "option" }>): string {
  switch (row.type) {
    case "group":
      return `group:${row.label}`;
    case "separator":
      return "separator";
    case "hint":
      return `hint:${row.parts.join("|")}`;
  }
}

function MachineDot({ online }: { readonly online: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        online ? "bg-emerald-400" : "border-[1.5px] border-muted-foreground/50",
      )}
    />
  );
}

function SuggestionChrome({
  row,
}: {
  readonly row: Exclude<OmnifieldSuggestionRow, { type: "option" }>;
}) {
  switch (row.type) {
    case "group":
      return (
        <div
          role="presentation"
          className="px-2 pt-1.5 pb-[3px] text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60"
        >
          {row.label}
        </div>
      );
    case "separator":
      return <div role="separator" className="mx-1.5 my-1 h-px bg-foreground/7" />;
    case "hint":
      return (
        <div
          role="presentation"
          className="flex gap-2.5 px-2 pt-1 pb-1.5 text-[10.5px] text-muted-foreground/55"
        >
          {row.parts.map((part) => (
            <span key={part}>{part}</span>
          ))}
        </div>
      );
  }
}

function SuggestionOption(props: {
  readonly id: string;
  readonly row: Extract<OmnifieldSuggestionRow, { type: "option" }>;
  readonly escalateShortcut: string;
  readonly highlighted: boolean;
  readonly onHighlight: () => void;
  readonly onChoose: () => void;
}) {
  const { row } = props;
  const everywhere = row.option.kind === "everywhere";
  const parts = splitLabelAtTerm(row.label, row.term);
  return (
    <div
      id={props.id}
      role="option"
      aria-selected={props.highlighted}
      data-highlighted={props.highlighted}
      onPointerMove={props.onHighlight}
      onClick={props.onChoose}
      className={cn(
        "flex h-[26px] cursor-pointer items-center gap-2 rounded-[7px] px-2 text-xs data-[highlighted=true]:bg-sidebar-accent",
        everywhere ? "text-foreground" : "text-foreground/86",
      )}
    >
      {everywhere ? (
        <SearchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      ) : null}
      {row.online !== null ? <MachineDot online={row.online} /> : null}
      {row.symbol ? (
        <span className="w-4 shrink-0 text-center text-[11px] font-semibold text-muted-foreground">
          {row.symbol}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">
        {parts ? (
          <>
            {parts.before}
            <mark className="bg-transparent font-semibold text-foreground">{parts.match}</mark>
            {parts.after}
          </>
        ) : (
          row.label
        )}
      </span>
      {row.meta ? (
        <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/55">
          {row.meta}
        </span>
      ) : null}
      {everywhere ? (
        <kbd className="shrink-0 rounded-[4px] bg-foreground/7 px-1 py-0.5 font-sans text-[10px] font-medium leading-none text-muted-foreground/75">
          {props.escalateShortcut}
        </kbd>
      ) : null}
    </div>
  );
}

/** Tokens that just left, kept until their exit animation ends. */
function useLeavingTokens(tokens: ReadonlyArray<OmnifieldToken>, animate: boolean) {
  const [list, setList] = useState<ReadonlyArray<OmnifieldToken>>([]);
  const previousRef = useRef(tokens);
  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = tokens;
    if (!animate) return;
    const gone = previous.filter((token) => !tokens.some((next) => next.key === token.key));
    if (gone.length === 0) return;
    setList((current) => [
      ...current.filter((token) => !gone.some((left) => left.key === token.key)),
      ...gone,
    ]);
  }, [animate, tokens]);
  const done = useCallback((token: OmnifieldToken) => {
    setList((current) => current.filter((candidate) => candidate !== token));
  }, []);
  return { list, done };
}
