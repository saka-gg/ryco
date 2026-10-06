import {
  AUTOMATION_LIMITS,
  DAY_MS,
  dayStart,
  formatDate,
  formatDateTime,
  formatDay,
  formatTime,
  localTimeZone,
  minutesOf,
  rel,
  sameDay,
  withMinutes,
} from "@ryco/shared/automationSchedule";
import { explainWhen, whenQuickPicks } from "@ryco/shared/automationWhenParser";
import { CheckIcon } from "lucide-react";
import { type ReactNode, type Ref, useState } from "react";

import { CalendarGrid } from "./CalendarGrid";
import { TimeColumn } from "./TimeColumn";

/** How a calendar pick arrived: a day, a time, a quick pick or a one-click fix. */
export type CalendarVia = "grid" | "time" | "quick" | "fix";

interface PanelMessage {
  readonly text: string;
  readonly tone: "info" | "warn";
  readonly fix: { readonly ms: number; readonly label: string } | null;
}

export interface CalendarPanelProps {
  readonly value: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly nowMs: number;
  /** Date only: the smaller grid, no time column or quick picks (the end picker). */
  readonly compact?: boolean | undefined;
  /** Draws a band from this day to the chosen day (the end picker's start). */
  readonly rangeStart?: number | null | undefined;
  readonly maxNote?: string | undefined;
  /** The footer's left side while nothing else is said ("From Oct 8"). */
  readonly legend?: ReactNode;
  /** The moment a picked day means (default: that day at the current time, else 09:00). */
  readonly pickDay?: ((dayMs: number) => number | null) | undefined;
  /** Name the time zone in the footer (off where the host already says it). */
  readonly tz?: boolean | undefined;
  /** Accepts a moment; false when it can't be used (the panel then explains why). */
  readonly commit: (ms: number, via: CalendarVia) => boolean;
  /** The pick is complete: a time, a quick pick, a fix — or any day when compact. */
  readonly onDone: () => void;
  readonly ref?: Ref<HTMLDivElement> | undefined;
}

/**
 * The calendar: the month grid, a column of times and four quick picks, with
 * one footer line that states the limit or explains a refusal with a
 * one-click fix. A day whose current time has already gone (today, 09:00) is
 * shown as chosen and the time column lists that day; nothing is set until a
 * time or the fix is accepted. Compact, it is a date grid only.
 */
export function CalendarPanel({ ref, ...props }: CalendarPanelProps) {
  const { value, min, max, nowMs } = props;
  const compact = props.compact === true;
  const [pending, setPending] = useState<number | null>(null);
  const [message, setMessage] = useState<PanelMessage | null>(null);
  const [gridDay, setGridDay] = useState(() => {
    const start = value != null ? dayStart(value) : dayStart(nowMs);
    const lo = min != null ? dayStart(min) : Number.NEGATIVE_INFINITY;
    const hi = max != null ? dayStart(max) : Number.POSITIVE_INFINITY;
    return Math.min(Math.max(start, lo), hi);
  });
  const day = pending ?? (value != null ? dayStart(value) : gridDay);

  const explain = (ms: number) => explainWhen(ms, { nowMs, min, max });

  const say = (
    text: string | null,
    tone: "info" | "warn" = "info",
    fix: PanelMessage["fix"] = null,
  ) => setMessage(text ? { text, tone, fix } : null);

  /* One plain sentence + a one-click fix; the value only changes on accept. */
  const reject = (ms: number) => {
    const reason = explain(ms);
    if (!reason) {
      say(null);
      return;
    }
    const at = sameDay(ms, nowMs) ? formatTime(ms) : formatDateTime(ms, nowMs);
    const text = reason.kind === "past" ? `${at} has passed` : reason.short;
    const fix =
      reason.fix != null
        ? {
            ms: reason.fix,
            label: `Use ${sameDay(reason.fix, ms) ? formatTime(reason.fix) : reason.fixLabel}`,
          }
        : null;
    say(text, "warn", fix);
  };

  const accept = (ms: number, via: CalendarVia) => {
    if (!props.commit(ms, via)) return false;
    setPending(null);
    return true;
  };

  const onDay = (picked: number) => {
    const ms = props.pickDay
      ? props.pickDay(picked)
      : withMinutes(picked, value != null ? minutesOf(value) : 540);
    if (ms == null) {
      say(`No times left on ${formatDay(picked, nowMs)}`, "warn");
      return;
    }
    const reason = explain(ms);
    if (reason) {
      if (!compact && reason.fix != null && sameDay(reason.fix, picked)) setPending(picked);
      reject(ms);
      return;
    }
    setPending(null);
    if (!props.commit(ms, "grid")) {
      reject(ms);
      return;
    }
    say(null);
    if (compact) props.onDone();
  };

  const limitText = () => {
    const tz = props.tz ? `${localTimeZone()} · ` : "";
    if (max == null) return tz.replace(/ · $/, "");
    const horizon = Math.abs(max - nowMs - AUTOMATION_LIMITS.horizonMs) < DAY_MS;
    return `${tz}${horizon ? `90-day limit · ${formatDate(max, nowMs)}` : `Latest ${formatDate(max, nowMs)}`}`;
  };

  const quickPicks = compact
    ? []
    : whenQuickPicks(nowMs).map((pick) => {
        const why = explain(pick.ms)?.text ?? null;
        return {
          label: pick.label,
          ms: pick.ms,
          why,
          when: `${formatDateTime(pick.ms, nowMs)} · ${rel(pick.ms, nowMs)}`,
          pressed: value === pick.ms && pending == null,
        };
      });
  const fixShowing = message?.tone === "warn" && message.fix != null;

  const announcement =
    message?.tone === "warn"
      ? `${message.text}${message.fix ? `. ${message.fix.label}?` : ""}`
      : "";

  return (
    <div ref={ref} className="pk-panel" data-compact={compact ? "" : undefined}>
      <div className="flex items-stretch">
        <CalendarGrid
          value={pending ?? value}
          min={min}
          max={max}
          nowMs={nowMs}
          rangeStart={props.rangeStart}
          compact={compact}
          maxNote={props.maxNote}
          autoFocus
          onPick={onDay}
          onFocusDayChange={setGridDay}
        />
        {compact ? null : (
          <>
            <div className="pk-vr" />
            <TimeColumn
              day={day}
              value={value}
              min={min}
              max={max}
              nowMs={nowMs}
              scrollKey={`${day}|${value ?? ""}`}
              scrollForce={pending != null}
              onPick={(minutes) => {
                if (accept(withMinutes(day, minutes), "time")) props.onDone();
              }}
              onReject={reject}
              say={(text, tone) => say(text, tone)}
            />
          </>
        )}
      </div>
      {compact ? null : (
        <div
          role="group"
          aria-label="Quick picks"
          className="flex flex-wrap gap-0.5 border-t border-(--pk-hair) px-2 py-1.5"
          onPointerLeave={() => {
            if (message && (message.tone !== "warn" || !message.fix)) say(null);
          }}
          onBlur={() => {
            if (message && (message.tone !== "warn" || !message.fix)) say(null);
          }}
        >
          {quickPicks.map((pick) => {
            const explainPick = () => {
              if (fixShowing) return;
              say(pick.why ?? pick.when, pick.why ? "warn" : "info");
            };
            return (
              <button
                key={pick.label}
                type="button"
                className="pk-qp"
                aria-disabled={pick.why != null}
                aria-pressed={pick.pressed}
                aria-label={`${pick.label}, ${pick.why ?? formatDateTime(pick.ms, nowMs)}`}
                onPointerOver={explainPick}
                onFocus={explainPick}
                onClick={() => {
                  if (pick.why != null) return;
                  if (accept(pick.ms, "quick")) props.onDone();
                }}
              >
                <CheckIcon className="pk-ic" aria-hidden />
                <span>{pick.label}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="pk-panel-meta" data-tone={message?.tone}>
        <span className="pk-meta-l">{message ? message.text : props.legend}</span>
        <span className="pk-meta-r">
          {message?.fix ? (
            <button
              type="button"
              className="pk-fix"
              onClick={() => {
                const fix = message.fix;
                if (fix && accept(fix.ms, "fix")) {
                  say(null);
                  props.onDone();
                }
              }}
            >
              {message.fix.label}
            </button>
          ) : !message || message.tone === "info" ? (
            limitText()
          ) : null}
        </span>
      </div>
      <span className="sr-only" role="status">
        {announcement}
      </span>
    </div>
  );
}
