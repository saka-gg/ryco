process.env.TZ = "Europe/Berlin";

import { blankScheduleDraft, scheduleDraftKey, type ScheduleDraft } from "../agentControl/index.ts";
import type { ProjectId, ProviderInstanceId, ServerProvider, ThreadId } from "@ryco/contracts";
import { DAY_MS, HOUR_MS, MINUTE_MS, WEEK_MS } from "@ryco/shared/automationSchedule";
import { describe, expect, it } from "vite-plus/test";

import {
  applyDraftFix,
  calendarChoiceOf,
  calendarChoiceWeekdays,
  defaultScheduleModel,
  firstInvalidField,
  promptCount,
  saveFailureField,
  sentenceWords,
  withStart,
} from "./editor.ts";

// Wed, Oct 7 2026 10:40 in Berlin.
const NOW = new Date(2026, 9, 7, 10, 40).getTime();
const PROJECT = "project-ryco" as ProjectId;
const MODEL = { instanceId: "claude" as ProviderInstanceId, model: "claude-sonnet-5-5" };

const blank = (overrides: Partial<ScheduleDraft> = {}): ScheduleDraft => ({
  ...blankScheduleDraft({ projectId: PROJECT, nowMs: NOW, modelSelection: MODEL }),
  ...overrides,
});

describe("the sentence", () => {
  it("says the lab's words for a repeating schedule", () => {
    const words = sentenceWords(blank(), NOW);
    expect(words.interval).toBe("day");
    expect(words.startWord).toBe("from");
    expect(words.start).toBe("tomorrow 09:00");
    expect(words.startLabel).toBe("First run: tomorrow 09:00, Thu, Oct 8");
    expect([words.endWord, words.end]).toEqual(["for", "30 days"]);
    expect(words.env).toBe("a new worktree");
  });

  it("says once, and an end on a date", () => {
    const draft = blank({ kind: "once", start: NOW + 3 * DAY_MS, endsAt: NOW + 12 * DAY_MS });
    const words = sentenceWords(draft, NOW);
    expect(words.startWord).toBe("Once,");
    expect(words.start).toBe("Sat, Oct 10 · 10:40");
    expect(words.startLabel).toBe("Runs at: Sat, Oct 10 · 10:40");
    expect(words.endWord).toBe("until");
  });

  it("says a heartbeat runs in an existing chat called its title, or asks for one", () => {
    const heartbeat = blank({ target: { kind: "thread", threadId: "thread-ci" as ThreadId } });
    const words = sentenceWords(heartbeat, NOW, { words: "Fix CI flakes", choosingChat: false });
    expect([words.env, words.envLabel]).toEqual(["an existing chat", "Runs in: an existing chat"]);
    expect([words.chat, words.chatLabel]).toEqual(["Fix CI flakes", "Chat: Fix CI flakes"]);
    // Picking a chat for a draft that has none yet.
    const choosing = sentenceWords(blank(), NOW, { words: null, choosingChat: true });
    expect([choosing.env, choosing.chat, choosing.chatLabel]).toEqual([
      "an existing chat",
      "pick a chat",
      "Chat: none picked yet",
    ]);
    // A draft without a chat reads its checkout, whatever chat words come along.
    expect(sentenceWords(blank(), NOW, { words: "Fix CI flakes", choosingChat: false }).env).toBe(
      "a new worktree",
    );
  });
});

describe("calendar schedules", () => {
  const weekdays = blank({
    kind: "calendar",
    weekdays: [1, 2, 3, 4, 5],
    timeZone: "Europe/Berlin",
  });

  it("says the days and the first run's time after Every", () => {
    const words = sentenceWords(weekdays, NOW);
    expect(words.interval).toBe("weekday at 09:00");
    expect(words.intervalLabel).toBe("Repeats: every weekday at 09:00");
    expect(sentenceWords({ ...weekdays, weekdays: [4] }, NOW).interval).toBe("Thursday at 09:00");
  });

  it("names the choice and runs a weekly schedule on its first run's weekday", () => {
    expect(calendarChoiceOf(weekdays)).toBe("weekdays");
    expect(calendarChoiceOf({ ...weekdays, weekdays: [0, 1, 2, 3, 4, 5, 6] })).toBe("daily");
    expect(calendarChoiceOf(blank())).toBeNull();
    // Tomorrow is Thursday Oct 8.
    expect(calendarChoiceWeekdays("weekly", weekdays)).toEqual([4]);
    const weekly = { ...weekdays, weekdays: [4] };
    expect(withStart(weekly, new Date(2026, 9, 12, 9, 0).getTime()).weekdays).toEqual([1]);
    // Weekdays stay weekdays when the first run moves.
    expect(withStart(weekdays, new Date(2026, 9, 12, 9, 0).getTime()).weekdays).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("turns an interval fix into an interval schedule", () => {
    expect(applyDraftFix(weekdays, "interval", 15 * MINUTE_MS)).toMatchObject({
      kind: "fixed-interval",
      intervalMs: 15 * MINUTE_MS,
    });
  });

  it("saves the first run's time of day in the schedule's zone", () => {
    expect(JSON.parse(scheduleDraftKey(weekdays)).schedule).toEqual({
      kind: "calendar",
      timeZone: "Europe/Berlin",
      localTime: "09:00",
      weekdays: [1, 2, 3, 4, 5],
      startsAt: new Date(weekdays.start).toISOString(),
      endsAt: new Date(weekdays.endsAt).toISOString(),
    });
  });
});

describe("changes", () => {
  it("keeps an end said as a duration with the start, and an end on a date where it is", () => {
    const draft = blank({ start: NOW + DAY_MS, endsAt: NOW + DAY_MS + WEEK_MS });
    expect(withStart(draft, NOW + 2 * DAY_MS).endsAt).toBe(NOW + 2 * DAY_MS + WEEK_MS);
    const dated = blank({ start: NOW + DAY_MS, endsAt: NOW + 12 * DAY_MS + 5 * HOUR_MS });
    expect(withStart(dated, NOW + 2 * DAY_MS).endsAt).toBe(NOW + 12 * DAY_MS + 5 * HOUR_MS);
  });

  it("applies a message's fix to its field", () => {
    const draft = blank();
    expect(applyDraftFix(draft, "interval", 15 * MINUTE_MS).intervalMs).toBe(15 * MINUTE_MS);
    expect(applyDraftFix(draft, "end", NOW + 9 * DAY_MS).endsAt).toBe(NOW + 9 * DAY_MS);
    expect(applyDraftFix(draft, "start", NOW + HOUR_MS).start).toBe(NOW + HOUR_MS);
  });

  it("focuses the first wrong field in reading order", () => {
    expect(firstInvalidField({ prompt: "x", title: "y", end: "z" })).toBe("title");
    expect(firstInvalidField({ model: "x", interval: "y" })).toBe("interval");
    expect(firstInvalidField({})).toBeNull();
  });
});

describe("a new schedule's model", () => {
  it("takes the first ready provider's first model", () => {
    const providers = [
      {
        instanceId: "off",
        enabled: false,
        installed: true,
        status: "ready",
        models: [{ slug: "x" }],
      },
      {
        instanceId: "codex",
        enabled: true,
        installed: true,
        status: "ready",
        models: [{ slug: "gpt-5.5" }],
      },
    ] as unknown as ServerProvider[];
    expect(defaultScheduleModel(providers)).toEqual({ instanceId: "codex", model: "gpt-5.5" });
    expect(defaultScheduleModel([])).toBeNull();
  });

  it("starts at the model's default effort, so the pick says it like the dial", () => {
    const providers = [
      {
        instanceId: "claude",
        enabled: true,
        installed: true,
        status: "ready",
        models: [
          {
            slug: "claude-sonnet-5-5",
            capabilities: {
              optionDescriptors: [
                { id: "fastMode", type: "boolean", label: "Fast" },
                {
                  id: "effort",
                  type: "select",
                  label: "Effort",
                  options: [
                    { id: "low", label: "Low" },
                    { id: "medium", label: "Medium", isDefault: true },
                    { id: "high", label: "High" },
                  ],
                },
              ],
            },
          },
        ],
      },
    ] as unknown as ServerProvider[];
    expect(defaultScheduleModel(providers)).toEqual({
      instanceId: "claude",
      model: "claude-sonnet-5-5",
      options: [{ id: "effort", value: "medium" }],
    });
  });
});

describe("save failures and the counter", () => {
  it("reads which token a refused save is about", () => {
    const reason = "Requested worktree base ref is unavailable.";
    expect(saveFailureField(reason)).toBe("ref");
    expect(saveFailureField("Provider instance 'claude' is unavailable.")).toBe("model");
    expect(saveFailureField("Model option 'effort' is unavailable.")).toBe("model");
    expect(saveFailureField("Schedule changed. Refresh before saving.")).toBeNull();
    expect(saveFailureField(null)).toBeNull();
  });

  it("counts the prompt once there is one", () => {
    expect(promptCount(0, 12_000)).toBe("");
    expect(promptCount(257, 12_000)).toBe("257 / 12,000");
  });
});
