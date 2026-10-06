import { AUTOMATION_LIMITS, formatDateTime, minutesOf, rel } from "@ryco/shared/automationSchedule";
import {
  type ParsedWhen,
  type WhenExplanation,
  explainWhen,
  normalizeWhenText,
  parseWhen,
  suggestWhen,
} from "@ryco/shared/automationWhenParser";
import { ArrowRightIcon, CalendarIcon, CheckIcon, CircleAlertIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { cn } from "~/lib/utils";

import { CalendarPanel, type CalendarVia } from "./CalendarPanel";
import { Crossfade } from "./Crossfade";

/** How a value arrived: typed, a suggestion, leaving the field, or the calendar. */
export type WhenVia = "type" | "suggestion" | "blur" | CalendarVia;

export interface WhenFieldProps {
  readonly value: number | null;
  readonly nowMs: number;
  /** Earliest usable time (exclusive while it is now). Default: now. */
  readonly min?: number | null | undefined;
  /** Latest usable time. Default: now + 90 days. */
  readonly max?: number | null | undefined;
  /** The field's accessible name ("First run", "Runs at"). */
  readonly label?: string | undefined;
  /** The value changed. */
  readonly onChange?: ((ms: number, info: { readonly via: WhenVia }) => void) | undefined;
  /**
   * Every accept — Enter, a suggestion, a calendar pick, a fix — even of the
   * unchanged value. Hosts close their popover on this, not on `onChange`.
   */
  readonly onCommit?:
    | ((ms: number, info: { readonly changed: boolean; readonly via: WhenVia }) => void)
    | undefined;
  /** Start with this typed into the field (a key pressed on the host's token). */
  readonly initialText?: string | undefined;
  readonly autoFocus?: boolean | undefined;
  /** The input, for a host that manages initial focus itself. */
  readonly inputRef?: RefObject<HTMLInputElement | null> | undefined;
  readonly className?: string | undefined;
}

interface Chip {
  readonly key: string;
  readonly tone: "idle" | "set" | "ok" | "warn";
  readonly content: ReactNode;
  /** What a screen reader hears once the reading settles (null: say nothing new). */
  readonly announce: string | null;
}

const ERROR_DELAY_MS = 650;
const ANNOUNCE_DELAY_MS = 600;

/**
 * One field that reads plain phrases — "tomorrow 9", "fri 17:30", "in 2h" —
 * the lab's "type" date picker as it sits inside a popover: a live reading
 * under the field (crossfading), 3–5 suggestions (↑/↓ choose, ↵ set), plain
 * reasons with a one-click fix when a time is past or out of range, and a
 * calendar button that opens the month grid, time column and quick picks in
 * the same surface. Accepting rewrites the phrase as the value it became.
 * While an edit is pending, Escape reverts it (and goes no further); with the
 * calendar open, Escape closes it; otherwise Escape reaches the host.
 */
export function WhenField(props: WhenFieldProps) {
  const { value, nowMs } = props;
  const min = props.min === undefined ? nowMs : props.min;
  const max = props.max === undefined ? nowMs + AUTOMATION_LIMITS.horizonMs : props.max;
  const label = props.label ?? "Date and time";
  const defaultTime = value != null ? minutesOf(value) : 540;

  const listId = useId();
  const chipId = useId();
  const calId = useId();
  const ownInputRef = useRef<HTMLInputElement | null>(null);
  const inputRef = props.inputRef ?? ownInputRef;
  const calButtonRef = useRef<HTMLButtonElement | null>(null);
  const focusOnMountRef = useRef(props.autoFocus === true || props.initialText != null);
  const caretAtEndRef = useRef(props.initialText != null);

  const [draft, setDraft] = useState<string | null>(props.initialText ?? null);
  const [focused, setFocused] = useState(false);
  const [justSet, setJustSet] = useState(false);
  const [active, setActive] = useState(-1);
  const [calOpen, setCalOpen] = useState(false);
  const [errorShownFor, setErrorShownFor] = useState<string | null>(props.initialText ?? null);
  const [announced, setAnnounced] = useState("");

  const reason = (ms: number) => explainWhen(ms, { nowMs, min, max });
  const canonical = value != null ? formatDateTime(value, nowMs) : "";
  const text = draft ?? canonical;
  const editing = normalizeWhenText(text) !== normalizeWhenText(canonical);
  const typed = text.trim() !== "";
  const parsed = editing && typed ? parseWhen(text, nowMs, { defaultTime }) : null;

  const commit = (ms: number, via: WhenVia) => {
    if (reason(ms)) return false;
    const changed = ms !== value;
    if (changed) props.onChange?.(ms, { via });
    props.onCommit?.(ms, { changed, via });
    return true;
  };

  /* Accepting rewrites the phrase as the value it became. */
  const accept = (ms: number, via: WhenVia) => {
    if (!commit(ms, via)) {
      setErrorShownFor(text);
      return;
    }
    setDraft(null);
    setJustSet(true);
    setActive(-1);
  };

  const revert = () => {
    setDraft(null);
    setActive(-1);
  };

  const warnChip = (why: WhenExplanation, reading: ParsedWhen | null): Chip => {
    const fix = why.fix;
    return {
      key: `warn|${why.text}|${reading?.ms ?? ""}|${why.fixLabel ?? ""}`,
      tone: "warn",
      content: (
        <>
          <CircleAlertIcon className="pk-ic" aria-hidden />
          <span className="pk-chip-why">
            {reading ? (
              <>
                <b>{reading.label}</b> <span className="pk-sep">·</span>{" "}
              </>
            ) : null}
            {fix != null ? why.short : why.text}
          </span>
          {fix != null ? (
            <button type="button" className="pk-fix" onClick={() => accept(fix, "fix")}>
              Use {why.fixLabel}
            </button>
          ) : null}
        </>
      ),
      announce: reading
        ? `${reading.label}: ${why.text}${why.fixLabel ? `. Use ${why.fixLabel}?` : ""}`
        : null,
    };
  };

  const chip = ((): Chip => {
    if (!parsed) {
      if (!typed && focused)
        return {
          key: "hint",
          tone: "idle",
          content: <span>Type a day and a time — “fri 17:30”, “in 2h”</span>,
          announce: null,
        };
      const why = value != null ? reason(value) : null;
      if (why) return warnChip(why, null);
      if (value == null)
        return { key: "none", tone: "idle", content: <span>No time set</span>, announce: null };
      const words = rel(value, nowMs);
      if (justSet)
        return {
          key: `set|${value}`,
          tone: "set",
          content: (
            <>
              <CheckIcon className="pk-ic" aria-hidden />
              <span className="pk-rel">{words}</span>
            </>
          ),
          announce: null,
        };
      return {
        key: `idle|${words}`,
        tone: "idle",
        content: <span className="pk-rel">{words}</span>,
        announce: null,
      };
    }
    if (!parsed.ok) {
      if (errorShownFor !== text)
        return { key: "wait", tone: "idle", content: <span>Keep typing…</span>, announce: null };
      return {
        key: `err|${parsed.error}`,
        tone: "warn",
        content: (
          <>
            <CircleAlertIcon className="pk-ic" aria-hidden />
            <span>{parsed.error}</span>
          </>
        ),
        announce: parsed.error,
      };
    }
    const why = reason(parsed.ms);
    if (why) return warnChip(why, parsed);
    return {
      key: `ok|${parsed.ms}|${parsed.rel}`,
      tone: "ok",
      content: (
        <>
          <ArrowRightIcon className="pk-ic" aria-hidden />
          <b>{parsed.label}</b> <span className="pk-sep">·</span>{" "}
          <span className="pk-rel">{parsed.rel}</span>
          <kbd>↵</kbd>
        </>
      ),
      announce: `${parsed.label}, ${parsed.rel}. Enter to set.`,
    };
  })();

  // A phrase that can't be read says so once typing pauses.
  const pendingError = parsed && !parsed.ok && errorShownFor !== text ? text : null;
  useEffect(() => {
    if (pendingError == null) return;
    const timer = setTimeout(() => setErrorShownFor(pendingError), ERROR_DELAY_MS);
    return () => clearTimeout(timer);
  }, [pendingError]);

  // Screen readers hear the settled reading, not every keystroke.
  const announcement = chip.announce;
  useEffect(() => {
    if (announcement == null) return;
    const timer = setTimeout(() => setAnnounced(announcement), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [announcement]);

  useLayoutEffect(() => {
    if (!focusOnMountRef.current) return;
    focusOnMountRef.current = false;
    inputRef.current?.focus();
  }, [inputRef]);

  const items = suggestWhen(editing ? text : "", nowMs, { min, max, defaultTime });
  const listShown = !calOpen && items.length > 0;
  const activeIndex = Math.min(active, items.length - 1);
  const typedHead = editing ? normalizeWhenText(text) : "";

  const moveActive = (step: 1 | -1) => {
    if (!listShown) return;
    const count = items.length;
    setActive(activeIndex < 0 ? (step > 0 ? 0 : count - 1) : (activeIndex + step + count) % count);
  };

  const closeCalendar = (focusButton: boolean) => {
    setCalOpen(false);
    if (focusButton) calButtonRef.current?.focus({ preventScroll: true });
  };

  const commitFromCalendar = (ms: number, via: CalendarVia) => {
    if (!commit(ms, via)) return false;
    setDraft(null);
    setJustSet(true);
    return true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = listShown && activeIndex >= 0 ? items[activeIndex] : undefined;
      if (chosen) {
        accept(chosen.ms, "suggestion");
        return;
      }
      if (!editing) {
        // Enter on the value as it stands is still an accept (hosts close on it).
        if (value != null && !reason(value)) commit(value, "type");
        setActive(-1);
        return;
      }
      const reading = parseWhen(text, nowMs, { defaultTime });
      if (!reading.ok) {
        setErrorShownFor(text);
        return;
      }
      accept(reading.ms, "type");
    } else if (event.key === "Escape" && editing) {
      event.preventDefault();
      event.stopPropagation();
      revert();
    }
  };

  const onBlur = () => {
    setFocused(false);
    if (editing && typed) {
      const reading = parseWhen(text, nowMs, { defaultTime });
      if (reading.ok && !reason(reading.ms)) {
        commit(reading.ms, "blur");
        setDraft(null);
      }
    } else if (!typed) setDraft(null);
    setJustSet(false);
    setErrorShownFor(text);
  };

  return (
    <div className={cn("pk pk-dt min-w-0", props.className)}>
      <div className="pk-field">
        <input
          ref={inputRef}
          className="pk-input"
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={listShown}
          aria-controls={listId}
          aria-describedby={chipId}
          aria-activedescendant={
            listShown && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined
          }
          aria-label={label}
          spellCheck={false}
          autoComplete="off"
          placeholder="tomorrow 9, fri 17:30, in 2h"
          value={text}
          onChange={(event) => {
            setDraft(event.target.value);
            setJustSet(false);
            setActive(-1);
          }}
          onFocus={(event) => {
            const input = event.currentTarget;
            if (caretAtEndRef.current) {
              caretAtEndRef.current = false;
              input.setSelectionRange(input.value.length, input.value.length);
            } else input.select();
            setFocused(true);
            setJustSet(false);
            if (calOpen) closeCalendar(false);
          }}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
        />
        <button
          ref={calButtonRef}
          type="button"
          className="pk-icon-btn"
          aria-label="Open calendar"
          aria-haspopup="dialog"
          aria-expanded={calOpen}
          aria-controls={calOpen ? calId : undefined}
          onClick={() => {
            setActive(-1);
            if (calOpen) closeCalendar(true);
            else setCalOpen(true);
          }}
        >
          <CalendarIcon className="pk-ic" aria-hidden />
        </button>
      </div>
      <div className="flex min-h-[30px] min-w-0 items-center" id={chipId}>
        <Crossfade layerKey={chip.key} tone={chip.tone} className="pk-chip">
          {chip.content}
        </Crossfade>
      </div>
      <div
        className="pk-inl-list"
        role="listbox"
        id={listId}
        aria-label="Suggestions"
        hidden={!listShown}
      >
        {items.map((item, index) => {
          const head =
            !item.nearest && typedHead && item.phrase.startsWith(typedHead) ? typedHead.length : 0;
          return (
            <div
              // The phrase, not its time: "in 1 hour" keeps its row as the clock ticks.
              key={item.nearest ? `nearest|${item.phrase}` : item.phrase}
              className="pk-opt"
              role="option"
              id={`${listId}-${index}`}
              aria-selected={index === activeIndex}
              onPointerDown={(event) => {
                event.preventDefault();
                accept(item.ms, "suggestion");
              }}
            >
              <span>
                {item.nearest ? (
                  <span className="pk-opt-near">{item.nearest} allowed</span>
                ) : (
                  <>
                    <span className="pk-opt-typed">{item.phrase.slice(0, head)}</span>
                    {item.phrase.slice(head)}
                  </>
                )}
              </span>
              <span className="pk-opt-when">{item.label}</span>
            </div>
          );
        })}
      </div>
      {calOpen ? (
        <div
          className="pk-inl-cal"
          id={calId}
          role="group"
          aria-label={label}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            closeCalendar(true);
          }}
        >
          <CalendarPanel
            value={value}
            min={min}
            max={max}
            nowMs={nowMs}
            commit={commitFromCalendar}
            onDone={() => closeCalendar(true)}
          />
        </div>
      ) : null}
      <span className="sr-only" role="status">
        {announced}
      </span>
    </div>
  );
}
