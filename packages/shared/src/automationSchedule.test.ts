process.env.TZ = "Europe/Berlin";

import { ProviderDriverKind, ProviderInstanceId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  AUTOMATION_LIMITS,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  WEEK_MS,
  cadence,
  calendarDayDiff,
  clockChange,
  countRuns,
  countdown,
  detectUntilMode,
  dstShift,
  endFor,
  endPreset,
  endWords,
  everyWords,
  firstRun,
  fitScheduleModelOptions,
  formatDate,
  formatDateTime,
  formatDay,
  formatInterval,
  formatShortDateTime,
  formatTime,
  intervalLabel,
  isAutomationProviderReady,
  lastRun,
  nextRun,
  phrase,
  rel,
  rollForward,
  runPreviewNote,
  runPreviewWindow,
  scheduleLabel,
  scheduleModelError,
  scheduleOccurrences,
  scheduleToContract,
  scheduleToMs,
  untilLimit,
  validateScheduleDefinition,
  when,
  type AutomationProviderInfo,
  type ScheduleDefinitionInput,
  type ScheduleInput,
} from "./automationSchedule.ts";

const T = (y: number, m: number, d: number, hh: number, mm: number) =>
  new Date(y, m - 1, d, hh, mm).getTime();
/** The lab's fixed now: Wed Oct 7 2026, 10:42 in Berlin (CEST). */
const NOW = T(2026, 10, 7, 10, 42);
const CLAUDE = ProviderInstanceId.make("claude");

const every = (startsAt: number, intervalMs: number, endsAt: number): ScheduleInput => ({
  kind: "fixed-interval",
  startsAt,
  intervalMs,
  endsAt,
});

describe("time zone", () => {
  it("runs in Europe/Berlin, whose clocks go back on Oct 25 2026", () => {
    expect(new Date(T(2026, 10, 24, 12, 0)).getTimezoneOffset()).toBe(-120);
    expect(new Date(T(2026, 10, 25, 12, 0)).getTimezoneOffset()).toBe(-60);
  });
});

describe("clock change (Europe/Berlin, Oct 25 2026)", () => {
  const daily = every(T(2026, 10, 20, 3, 0), DAY_MS, T(2026, 10, 31, 3, 0));

  it("keeps elapsed time, so the wall-clock time moves an hour", () => {
    const runs = scheduleOccurrences(daily, NOW, Number.POSITIVE_INFINITY, 7).map(formatTime);
    expect(runs).toEqual(["03:00", "03:00", "03:00", "03:00", "03:00", "02:00", "02:00"]);
  });

  it("finds the shift", () => {
    expect(dstShift(daily, NOW)).toEqual({
      at: T(2026, 10, 20, 3, 0) + 5 * DAY_MS,
      from: "03:00",
      to: "02:00",
    });
    expect(dstShift(every(NOW + HOUR_MS, 2 * HOUR_MS, NOW + 30 * DAY_MS), NOW)).toBeNull();
  });

  it("says it once, in words", () => {
    expect(clockChange(daily, NOW)?.text).toBe(
      "Clocks go back Oct 25 — from then on it runs at 02:00, not 03:00 (fixed 24-hour interval).",
    );
    const weekly = every(T(2026, 10, 9, 16, 0), WEEK_MS, T(2026, 12, 11, 16, 0));
    expect(clockChange(weekly, NOW)?.text).toBe(
      "Clocks go back Oct 25 — from Fri, Oct 30 it runs at 15:00, not 16:00 (fixed 1-week interval).",
    );
    expect(clockChange({ kind: "once", runAt: NOW + DAY_MS }, NOW)).toBeNull();
  });

  it("folds the shift into a phrase only when asked", () => {
    expect(phrase(daily, NOW)).toBe("every 24 hours from Tue, Oct 20 at 03:00 until Oct 31");
    expect(phrase(daily, NOW, { dst: true })).toBe(
      "every 24 hours from Tue, Oct 20 at 03:00 (02:00 from Oct 25) until Oct 31",
    );
  });

  it("anchors the cadence on the slot that holds now", () => {
    expect(cadence(daily, NOW)).toBe("Every 24 h from 03:00");
    expect(cadence(daily, T(2026, 10, 26, 12, 0))).toBe("Every 24 h from 02:00");
  });

  it("dates the change in the run preview", () => {
    expect(runPreviewNote(daily, NOW)).toBe(
      "Clocks go back on Oct 25 — from then on runs land at 02:00, since the interval is elapsed time.",
    );
  });

  it("ends day-based presets on the start's wall-clock time", () => {
    const start = T(2026, 10, 20, 9, 0);
    expect(endFor(start, WEEK_MS)).toBe(T(2026, 10, 27, 9, 0));
    expect(endFor(start, WEEK_MS) - start).toBe(WEEK_MS + HOUR_MS);
    expect(endFor(start, 2 * HOUR_MS)).toBe(start + 2 * HOUR_MS);
    // Both readings of "a week later" say "for 1 week".
    expect(endWords(start, start + WEEK_MS)).toEqual({ conn: "for", text: "1 week", dur: true });
    expect(endWords(start, endFor(start, WEEK_MS))).toEqual({
      conn: "for",
      text: "1 week",
      dur: true,
    });
  });

  it("counts calendar days across the 25-hour day", () => {
    expect(calendarDayDiff(T(2026, 10, 24, 23, 0), T(2026, 10, 26, 0, 30))).toBe(2);
  });
});

describe("schedule math", () => {
  const s = every(T(2026, 10, 7, 12, 0), 2 * HOUR_MS, T(2026, 10, 8, 12, 0));

  it("lists, counts and bounds occurrences (the end is inclusive)", () => {
    expect(scheduleOccurrences(s, NOW, Number.POSITIVE_INFINITY, 3)).toEqual([
      T(2026, 10, 7, 12, 0),
      T(2026, 10, 7, 14, 0),
      T(2026, 10, 7, 16, 0),
    ]);
    expect(countRuns(s)).toBe(13);
    expect(countRuns(s, T(2026, 10, 8, 11, 0))).toBe(1);
    expect(firstRun(s)).toBe(T(2026, 10, 7, 12, 0));
    expect(lastRun(s)).toBe(T(2026, 10, 8, 12, 0));
    expect(nextRun(s, T(2026, 10, 7, 12, 0))).toBe(T(2026, 10, 7, 14, 0));
    expect(nextRun(s, T(2026, 10, 8, 12, 0))).toBeNull();
    expect(nextRun({ kind: "once", runAt: NOW }, NOW)).toBeNull();
  });

  it("rolls a past start forward to the next occurrence", () => {
    expect(rollForward(s, T(2026, 10, 7, 15, 10))).toEqual({
      ...scheduleToMs(s),
      startsAt: T(2026, 10, 7, 16, 0),
    });
    expect(rollForward(s, NOW)).toEqual(scheduleToMs(s));
    const once = { kind: "once", runAt: NOW - HOUR_MS } as const;
    expect(rollForward(once, NOW)).toEqual(once);
  });

  it("keeps a rolled start past a lead, in the same phase", () => {
    const quarter = every(T(2026, 10, 7, 8, 39), 15 * MINUTE_MS, T(2026, 10, 30, 8, 39));
    const lead = { leadMs: 15 * MINUTE_MS };
    // The next run (10:54) falls inside the lead; the one after it does not.
    expect(rollForward(quarter, NOW)).toMatchObject({ startsAt: T(2026, 10, 7, 10, 54) });
    expect(rollForward(quarter, NOW, lead)).toMatchObject({ startsAt: T(2026, 10, 7, 11, 9) });
    // A future start inside the lead moves on too; one past it stays.
    expect(rollForward(s, T(2026, 10, 7, 11, 50), lead)).toMatchObject({
      startsAt: T(2026, 10, 7, 14, 0),
    });
    expect(rollForward(s, NOW, lead)).toEqual(scheduleToMs(s));
    // Nothing left past the lead: the plain next run, else as it was.
    const ending = every(T(2026, 10, 7, 8, 0), HOUR_MS, T(2026, 10, 7, 11, 0));
    expect(rollForward(ending, NOW, lead)).toMatchObject({ startsAt: T(2026, 10, 7, 11, 0) });
    const soon = every(NOW + 5 * MINUTE_MS, HOUR_MS, NOW + 5 * MINUTE_MS);
    expect(rollForward(soon, NOW, lead)).toEqual(scheduleToMs(soon));
  });

  it("accepts the contract's ISO shape", () => {
    const iso = scheduleToContract(s);
    expect(iso).toEqual({
      kind: "fixed-interval",
      startsAt: "2026-10-07T10:00:00.000Z",
      intervalMs: 2 * HOUR_MS,
      endsAt: "2026-10-08T10:00:00.000Z",
    });
    expect(nextRun(iso, NOW)).toBe(nextRun(s, NOW));
    expect(phrase(iso, NOW)).toBe(phrase(s, NOW));
    expect(when("2026-10-07T10:00:00.000Z", NOW)).toBe("today 12:00");
  });

  it("previews the next five runs, the count and the last one", () => {
    expect(runPreviewWindow(s, NOW)).toEqual({
      kind: "fixed-interval",
      next: [12, 14, 16, 18, 20].map((h) => T(2026, 10, 7, h, 0)),
      count: 13,
      first: T(2026, 10, 7, 12, 0),
      last: T(2026, 10, 8, 12, 0),
    });
    expect(runPreviewWindow({ kind: "once", runAt: NOW - 1 }, NOW)).toMatchObject({ count: 0 });
  });

  it("notes the approval load when runs come often", () => {
    const busy = every(NOW + HOUR_MS, 15 * MINUTE_MS, NOW + 2 * DAY_MS);
    expect(runPreviewNote(busy, NOW)).toBe(
      "About 96 runs a day — each waits up to 15 min for your approval.",
    );
    expect(runPreviewNote(s, NOW)).toBe(
      "About 12 runs a day — each waits up to 15 min for your approval.",
    );
    const sixHourly = every(NOW + HOUR_MS, 6 * HOUR_MS, NOW + 10 * DAY_MS);
    expect(runPreviewNote(sixHourly, NOW)).toBe("");
    expect(runPreviewNote(sixHourly, NOW, true)).toBe(
      "Each run waits up to 15 min for your approval.",
    );
    expect(runPreviewNote(busy, NOW, false)).toBe("");
    expect(runPreviewNote({ kind: "once", runAt: NOW + HOUR_MS }, NOW, true)).toBe(
      "It waits up to 15 min for your approval when it's due.",
    );
  });

  it("reads an end as a preset, the limit or a date", () => {
    const start = NOW + HOUR_MS;
    expect(detectUntilMode(start, endFor(start, 2 * WEEK_MS), NOW)).toEqual({
      kind: "dur",
      ms: 2 * WEEK_MS,
    });
    expect(detectUntilMode(start, untilLimit(NOW), NOW)).toEqual({ kind: "max" });
    expect(detectUntilMode(start, start + 3 * DAY_MS, NOW)).toEqual({ kind: "date" });
    expect(endPreset(start, endFor(start, 2 * WEEK_MS))?.label).toBe("2 weeks");
    expect(endPreset(start, start + 3 * DAY_MS)).toBeNull();
    expect(untilLimit(NOW + 30_000)).toBe(NOW + AUTOMATION_LIMITS.horizonMs);
  });
});

describe("words", () => {
  it("formats times, days and dates in one style", () => {
    expect(formatTime(T(2026, 10, 7, 9, 5))).toBe("09:05");
    expect(formatDay(NOW)).toBe("Wed, Oct 7");
    expect(formatDay(T(2027, 1, 5, 9, 0), NOW)).toBe("Tue, Jan 5, 2027");
    expect(formatDate(T(2027, 1, 5, 9, 0))).toBe("Jan 5");
    expect(formatDate(T(2027, 1, 5, 9, 0), NOW)).toBe("Jan 5, 2027");
    expect(formatDateTime(NOW)).toBe("Wed, Oct 7 · 10:42");
    expect(formatShortDateTime(NOW)).toBe("Oct 7, 10:42");
  });

  it("says when: today / tomorrow / yesterday, else the absolute format", () => {
    expect(when(T(2026, 10, 7, 16, 0), NOW)).toBe("today 16:00");
    expect(when(T(2026, 10, 8, 9, 0), NOW)).toBe("tomorrow 09:00");
    expect(when(T(2026, 10, 6, 22, 40), NOW)).toBe("yesterday 22:40");
    expect(when(T(2026, 10, 9, 16, 0), NOW)).toBe("Fri, Oct 9 · 16:00");
  });

  it("says relative time one way", () => {
    expect(rel(NOW + 30_000, NOW)).toBe("now");
    expect(rel(NOW + 50_000, NOW)).toBe("in 1m");
    expect(rel(NOW + 7 * MINUTE_MS, NOW)).toBe("in 7m");
    expect(rel(NOW + 3 * HOUR_MS + 20 * MINUTE_MS, NOW)).toBe("in 3h 20m");
    expect(rel(NOW - 7 * MINUTE_MS, NOW)).toBe("7m ago");
    expect(rel(NOW + 22 * HOUR_MS, NOW)).toBe("in 22h");
    expect(rel(T(2026, 10, 8, 23, 30), NOW)).toBe("tomorrow");
    expect(rel(T(2026, 10, 9, 0, 30), NOW)).toBe("in 2 days");
    expect(rel(T(2026, 10, 11, 9, 0), NOW)).toBe("in 4 days");
  });

  it("counts down without looking like a clock time", () => {
    expect(countdown(13 * MINUTE_MS)).toBe("13m");
    expect(countdown(12 * MINUTE_MS + 1)).toBe("13m");
    expect(countdown(65 * MINUTE_MS)).toBe("1h 5m");
    expect(countdown(2 * HOUR_MS)).toBe("2h");
    expect(countdown(102_000)).toBe("1:42");
    expect(countdown(-5)).toBe("0:00");
    expect(countdown(13 * MINUTE_MS, { exact: true })).toBe("13:00");
  });

  it("names cadences as elapsed time", () => {
    expect(cadence(every(NOW + HOUR_MS, 2 * HOUR_MS, NOW + DAY_MS), NOW)).toBe("Every 2 h");
    expect(cadence(every(NOW + HOUR_MS, HOUR_MS, NOW + DAY_MS), NOW)).toBe("Hourly");
    expect(cadence(every(NOW + HOUR_MS, 90 * MINUTE_MS, NOW + DAY_MS), NOW)).toBe(
      "Every 1 h 30 min",
    );
    expect(cadence(every(T(2026, 10, 9, 16, 0), WEEK_MS, NOW + 60 * DAY_MS), NOW)).toBe(
      "Every 7 days from Fri 16:00",
    );
    expect(cadence({ kind: "once", runAt: NOW + HOUR_MS }, NOW)).toBe("Once");
    expect(scheduleLabel({ kind: "once", runAt: T(2026, 10, 7, 16, 0) }, NOW)).toBe(
      "Once · today 16:00",
    );
    expect(scheduleLabel(every(NOW + HOUR_MS, 2 * HOUR_MS, T(2026, 10, 31, 9, 0)), NOW)).toBe(
      "Every 2 h · until Oct 31",
    );
  });

  it("phrases schedules for sentences", () => {
    expect(phrase({ kind: "once", runAt: T(2026, 10, 7, 16, 0) }, NOW)).toBe(
      "once, today at 16:00",
    );
    expect(phrase({ kind: "once", runAt: T(2026, 10, 8, 9, 0) }, NOW)).toBe(
      "once, tomorrow at 09:00",
    );
    expect(phrase({ kind: "once", runAt: T(2026, 10, 9, 16, 0) }, NOW)).toBe(
      "once, on Fri, Oct 9 at 16:00",
    );
    expect(phrase(every(T(2026, 10, 1, 8, 0), 2 * HOUR_MS, T(2026, 10, 20, 8, 0)), NOW)).toBe(
      "every 2 hours until Oct 20",
    );
    expect(phrase(every(T(2026, 10, 8, 8, 0), HOUR_MS, T(2026, 10, 20, 8, 0)), NOW)).toBe(
      "every hour from tomorrow at 08:00 until Oct 20",
    );
    expect(phrase(every(T(2026, 10, 1, 3, 0), DAY_MS, T(2026, 10, 20, 3, 0)), NOW)).toBe(
      "every 24 hours from 03:00 until Oct 20",
    );
    expect(phrase(every(T(2026, 10, 9, 16, 0), WEEK_MS, T(2026, 12, 11, 16, 0)), NOW)).toBe(
      "every 7 days from Fri, Oct 9 at 16:00 until Dec 11",
    );
  });

  it("names intervals after 'every' and in the picker", () => {
    expect(everyWords(DAY_MS)).toBe("day");
    expect(everyWords(WEEK_MS)).toBe("week");
    expect(everyWords(2 * WEEK_MS)).toBe("2 weeks");
    expect(everyWords(3 * DAY_MS)).toBe("3 days");
    expect(everyWords(HOUR_MS)).toBe("hour");
    expect(everyWords(6 * HOUR_MS)).toBe("6 hours");
    expect(everyWords(45 * MINUTE_MS)).toBe("45 minutes");
    expect(everyWords(90 * MINUTE_MS)).toBe("1 h 30 min");
    expect(intervalLabel(15 * MINUTE_MS)).toBe("Every 15 minutes");
    expect(intervalLabel(DAY_MS)).toBe("Every day");
    expect(formatInterval(30 * MINUTE_MS)).toBe("30 min");
    expect(formatInterval(WEEK_MS)).toBe("1 week");
  });

  it("says an end as a duration or a date", () => {
    expect(endWords(NOW, NOW + DAY_MS)).toEqual({ conn: "for", text: "1 day", dur: true });
    expect(endWords(NOW, NOW + 30 * DAY_MS)).toEqual({ conn: "for", text: "30 days", dur: true });
    expect(endWords(NOW, T(2026, 10, 14, 9, 0))).toEqual({
      conn: "until",
      text: "Oct 14",
      dur: false,
    });
  });
});

describe("validateScheduleDefinition", () => {
  const definition = (
    schedule: ScheduleInput | null,
    patch: Partial<ScheduleDefinitionInput["execution"]> = {},
    enabled = true,
  ): ScheduleDefinitionInput => ({
    execution: {
      title: "Nightly check",
      prompt: "Check the dependencies.",
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5-5" },
      ...patch,
    },
    schedule,
    enabled,
  });
  const errorsOf = (
    schedule: ScheduleInput | null,
    options?: Parameters<typeof validateScheduleDefinition>[2],
  ) => validateScheduleDefinition(definition(schedule), NOW, options).errors;
  const HORIZON = NOW + 90 * DAY_MS;

  it("needs a start strictly after now (start == now is refused)", () => {
    expect(errorsOf({ kind: "once", runAt: NOW })).toEqual({
      start: "That time has passed. Pick a time after today 10:42.",
    });
    expect(errorsOf({ kind: "once", runAt: NOW + 1 })).toEqual({});
    expect(errorsOf(every(NOW, 15 * MINUTE_MS, NOW + DAY_MS))).toEqual({
      start: "The first run has to be in the future — after today 10:42.",
    });
    expect(errorsOf(every(NOW + 1, 15 * MINUTE_MS, NOW + DAY_MS))).toEqual({});
  });

  it("allows exactly now + 90 days and nothing later", () => {
    expect(errorsOf({ kind: "once", runAt: HORIZON })).toEqual({});
    expect(errorsOf({ kind: "once", runAt: HORIZON + 1 })).toEqual({
      start: "Schedules reach at most 90 days ahead — Jan 5, 2027 at the latest.",
    });
    expect(errorsOf(every(NOW + HOUR_MS, DAY_MS, HORIZON))).toEqual({});
    expect(errorsOf(every(NOW + HOUR_MS, DAY_MS, HORIZON + 1))).toEqual({
      end: "Recurring schedules end within 90 days — Jan 5, 2027 at the latest.",
    });
  });

  it("allows an interval of exactly 15 minutes", () => {
    expect(errorsOf(every(NOW + HOUR_MS, 15 * MINUTE_MS, NOW + DAY_MS))).toEqual({});
    expect(errorsOf(every(NOW + HOUR_MS, 15 * MINUTE_MS - 1, NOW + DAY_MS))).toEqual({
      interval: "Runs can be at most every 15 minutes.",
    });
    expect(errorsOf(every(NOW + HOUR_MS, 0, NOW + DAY_MS))).toEqual({
      interval: "Pick how often it runs.",
    });
  });

  it("allows an end on the first run, not before it", () => {
    expect(errorsOf(every(NOW + HOUR_MS, HOUR_MS, NOW + HOUR_MS))).toEqual({});
    expect(errorsOf(every(NOW + HOUR_MS, HOUR_MS, NOW + HOUR_MS - 1))).toEqual({
      end: "It ends before the first run.",
    });
  });

  it("asks for the missing parts", () => {
    expect(errorsOf(null)).toEqual({ start: "Pick when it runs." });
    expect(errorsOf({ kind: "once", runAt: Number.NaN })).toEqual({
      start: "Pick a date and time.",
    });
    expect(errorsOf(every(Number.NaN, HOUR_MS, Number.NaN))).toEqual({
      start: "Pick when the first run happens.",
      end: "Recurring schedules need an end.",
    });
  });

  it("checks the title and the prompt like the execution template", () => {
    const check = (patch: Partial<ScheduleDefinitionInput["execution"]>) =>
      validateScheduleDefinition(definition({ kind: "once", runAt: NOW + HOUR_MS }, patch), NOW)
        .errors;
    expect(check({ title: "  " })).toEqual({ title: "Give it a short title." });
    expect(check({ title: "x".repeat(200) })).toEqual({});
    expect(check({ title: "x".repeat(201) })).toEqual({
      title: "Keep the title under 200 characters.",
    });
    expect(check({ prompt: "\n" })).toEqual({ prompt: "Tell the agent what to do on each run." });
    expect(check({ prompt: "x".repeat(12_000) })).toEqual({});
    expect(check({ prompt: "x".repeat(12_001) })).toEqual({
      prompt: "The prompt is 12,001 characters; the limit is 12,000.",
    });
    expect(check({ modelSelection: null })).toEqual({ model: "Pick a model." });
  });

  it("checks the model against the device's providers", () => {
    const providers: ReadonlyArray<AutomationProviderInfo> = [
      {
        instanceId: "claude",
        driver: ProviderDriverKind.make("claudeAgent"),
        models: [{ slug: "claude-opus-5-5", name: "Opus 5.5" }],
      },
    ];
    const once = { kind: "once", runAt: NOW + HOUR_MS } as const;
    expect(errorsOf(once, { providers })).toEqual({
      model: "claude-sonnet-5-5 isn't available on Claude any more. Pick another model.",
    });
    expect(
      validateScheduleDefinition(
        definition(once, { modelSelection: { instanceId: "codex", model: "gpt" } }),
        NOW,
        { providers },
      ).errors,
    ).toEqual({ model: "codex isn't set up on this device." });
    expect(
      validateScheduleDefinition(
        definition(once, { modelSelection: { instanceId: "claude", model: "claude-opus-5-5" } }),
        NOW,
        { providers },
      ).errors,
    ).toEqual({});
  });

  describe("the model, like the server's providerForSelection", () => {
    const sonnet = {
      slug: "claude-sonnet-5-5",
      name: "Sonnet 5.5",
      aliases: ["sonnet"],
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select" as const,
            options: [
              { id: "medium", label: "Medium" },
              { id: "high", label: "High" },
            ],
          },
          { id: "fastMode", label: "Fast mode", type: "boolean" as const },
        ],
      },
    };
    const claude: AutomationProviderInfo = {
      instanceId: "claude",
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      installed: true,
      status: "ready",
      availability: "available",
      models: [sonnet, { slug: "claude-haiku-5", name: "Haiku 5" }],
    };
    const check = (
      selection: Parameters<typeof scheduleModelError>[0],
      provider: AutomationProviderInfo = claude,
    ) => scheduleModelError(selection, [provider]);

    it("takes the exact slug only, not an alias", () => {
      expect(check({ instanceId: "claude", model: "claude-sonnet-5-5" })).toBeNull();
      expect(check({ instanceId: "claude", model: "sonnet" })).toBe(
        "sonnet isn't available on Claude any more. Pick another model.",
      );
    });

    it("needs the provider enabled, installed, ready and available", () => {
      const sel = { instanceId: "claude", model: "claude-sonnet-5-5" };
      expect(isAutomationProviderReady(claude)).toBe(true);
      expect(check(sel, { ...claude, enabled: false })).toBe(
        "Claude is turned off on this device. Pick another model.",
      );
      expect(check(sel, { ...claude, installed: false })).toBe(
        "Claude isn't installed on this device. Pick another model.",
      );
      expect(check(sel, { ...claude, status: "error" })).toBe(
        "Claude isn't ready on this device. Pick another model.",
      );
      expect(check(sel, { ...claude, availability: "unavailable" })).toBe(
        "Claude isn't ready on this device. Pick another model.",
      );
    });

    it("checks every option id and value against the model's descriptors", () => {
      const sel = (options: ReadonlyArray<{ id: string; value: string | boolean }>) => ({
        instanceId: "claude",
        model: "claude-sonnet-5-5",
        options,
      });
      expect(
        check(
          sel([
            { id: "effort", value: "high" },
            { id: "fastMode", value: true },
          ]),
        ),
      ).toBeNull();
      expect(check(sel([{ id: "effort", value: "max" }]))).toBe(
        "Sonnet 5.5 doesn't offer Effort “max” any more. Pick the model again.",
      );
      expect(check(sel([{ id: "fastMode", value: "on" }]))).toBe(
        "Sonnet 5.5 doesn't offer Fast mode “on” any more. Pick the model again.",
      );
      expect(check(sel([{ id: "thinking", value: true }]))).toBe(
        "Sonnet 5.5 has no thinking setting any more. Pick the model again.",
      );
      expect(
        check(
          sel([
            { id: "effort", value: "high" },
            { id: "effort", value: "medium" },
          ]),
        ),
      ).toBe("Sonnet 5.5 has effort set twice. Pick the model again.");
      expect(
        check({
          instanceId: "claude",
          model: "claude-haiku-5",
          options: [{ id: "effort", value: "high" }],
        }),
      ).toBe("Haiku 5 has no effort setting any more. Pick the model again.");
    });

    it("drops the options a newly picked model does not offer", () => {
      const providers = [claude];
      const onHaiku = fitScheduleModelOptions(
        { instanceId: CLAUDE, model: "claude-haiku-5", options: [{ id: "effort", value: "high" }] },
        providers,
      );
      expect(onHaiku).toEqual({ instanceId: "claude", model: "claude-haiku-5" });
      const kept = {
        instanceId: CLAUDE,
        model: "claude-sonnet-5-5",
        options: [{ id: "effort", value: "high" }],
      };
      expect(fitScheduleModelOptions(kept, providers)).toBe(kept);
      expect(
        fitScheduleModelOptions(
          {
            instanceId: CLAUDE,
            model: "claude-sonnet-5-5",
            options: [
              { id: "effort", value: "max" },
              { id: "fastMode", value: true },
            ],
          },
          providers,
        ),
      ).toEqual({
        instanceId: "claude",
        model: "claude-sonnet-5-5",
        options: [{ id: "fastMode", value: true }],
      });
    });
  });

  it("holds the 25-per-project limit for new or re-enabled schedules only", () => {
    const once = { kind: "once", runAt: NOW + HOUR_MS } as const;
    expect(errorsOf(once, { activeCount: 24 })).toEqual({});
    expect(errorsOf(once, { activeCount: 25, projectName: "ryco" })).toEqual({
      limit:
        "ryco already has 25 active schedules, the most a project can have. Pause or cancel one first.",
    });
    expect(errorsOf(once, { activeCount: 25, editingActive: true })).toEqual({});
    expect(
      validateScheduleDefinition(definition(once, {}, false), NOW, { activeCount: 25 }).errors,
    ).toEqual({});
  });
});
