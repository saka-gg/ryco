import { definitionFromDraft, type ScheduleRow } from "@ryco/client-runtime/state/agentControl";
import type { AgentControlAutomation, ProjectId, ServerProvider } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  scheduleEditorOpening,
  scheduleEffortChoices,
  scheduleModelChoices,
  scheduleRepeatOf,
  withCalendarChoice,
  withEffort,
  withModelChoice,
  withRepeat,
} from "./scheduleEditorModel";

const NOW_MS = new Date(2026, 10, 9, 10, 40).getTime();
const PROJECT = "p-ryco" as ProjectId;

const effort = {
  id: "effort",
  label: "Effort",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
  ],
};

const providers = [
  {
    instanceId: "off",
    driver: "codex",
    enabled: false,
    installed: true,
    status: "ready",
    models: [{ slug: "gpt-5.5", name: "GPT-5.5" }],
  },
  {
    instanceId: "claude",
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    status: "ready",
    models: [
      {
        slug: "claude-sonnet-5-5",
        name: "Sonnet 5.5",
        capabilities: { optionDescriptors: [effort] },
      },
      { slug: "claude-haiku-5-5", name: "Haiku 5.5" },
    ],
  },
] as unknown as ServerProvider[];

describe("the phone's schedule editor", () => {
  it("opens a new schedule on the first ready model at its default effort, off the default branch", () => {
    const opening = scheduleEditorOpening({
      mode: "new",
      projectId: PROJECT,
      row: null,
      providers,
      nowMs: NOW_MS,
    });
    expect(opening?.isNew).toBe(true);
    expect(opening?.draft.modelSelection).toEqual({
      instanceId: "claude",
      model: "claude-sonnet-5-5",
      options: [{ id: "effort", value: "medium" }],
    });
    expect(opening?.draft.baseRef).toBe("");
    expect(scheduleRepeatOf(opening!.draft)).toBe("interval");
  });

  it("waits for the schedule a change is for", () => {
    expect(
      scheduleEditorOpening({
        mode: "edit",
        projectId: PROJECT,
        row: null,
        providers,
        nowMs: NOW_MS,
      }),
    ).toBeNull();
  });

  it("switches between an interval, chosen days and one run", () => {
    const draft = scheduleEditorOpening({
      mode: "new",
      projectId: PROJECT,
      row: null,
      providers,
      nowMs: NOW_MS,
    })!.draft;
    const days = withRepeat(draft, "days");
    expect(days.kind).toBe("calendar");
    expect(days.weekdays).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(withCalendarChoice(days, "weekdays").weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(withRepeat(draft, "once").kind).toBe("once");
    expect(withRepeat(withRepeat(draft, "once"), "interval").intervalMs).toBe(draft.intervalMs);
  });

  it("offers ready providers' models and keeps the effort where the model has it", () => {
    const draft = scheduleEditorOpening({
      mode: "new",
      projectId: PROJECT,
      row: null,
      providers,
      nowMs: NOW_MS,
    })!.draft;
    const choices = scheduleModelChoices(providers, draft.modelSelection);
    expect(choices.map((provider) => provider.instanceId)).toEqual(["claude"]);
    expect(choices[0]?.models.find((model) => model.selected)?.title).toBe("Sonnet 5.5");
    const high = withEffort(draft, "effort", "high");
    expect(
      scheduleEffortChoices(providers, high.modelSelection)?.choices.find((c) => c.selected)?.id,
    ).toBe("high");
    const haiku = withModelChoice(high, providers, "claude\u001fclaude-haiku-5-5");
    expect(haiku.modelSelection).toEqual({ instanceId: "claude", model: "claude-haiku-5-5" });
    expect(scheduleEffortChoices(providers, haiku.modelSelection)).toBeNull();
    const back = withModelChoice(haiku, providers, "claude\u001fclaude-sonnet-5-5");
    expect(back.modelSelection.options).toEqual([{ id: "effort", value: "medium" }]);
  });

  it("leaves a local schedule's branch to the node when it is switched to a worktree", () => {
    const definition = {
      execution: {
        projectId: PROJECT,
        title: "Nightly",
        prompt: "Check things.",
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5-5" },
        runtimeMode: "approval-required",
        envMode: "local",
      },
      schedule: {
        kind: "fixed-interval",
        startsAt: new Date(NOW_MS + 60 * 60_000).toISOString(),
        intervalMs: 24 * 60 * 60_000,
        endsAt: new Date(NOW_MS + 20 * 24 * 60 * 60_000).toISOString(),
      },
      enabled: true,
    };
    const automation = {
      automationId: "a-local",
      projectId: PROJECT,
      definition,
      revision: 1,
      enabled: true,
      cancelled: false,
      nextRunAt: definition.schedule.startsAt,
    } as unknown as AgentControlAutomation;
    const row = {
      id: "a-local",
      automation,
      proposal: null,
      lapsed: null,
    } as unknown as ScheduleRow;
    const opening = scheduleEditorOpening({
      mode: "edit",
      projectId: PROJECT,
      row,
      providers,
      nowMs: NOW_MS,
    });
    expect(opening?.draft.baseRef).toBe("");
    const saved = definitionFromDraft({ ...opening!.draft, envMode: "worktree" });
    expect(saved.execution).not.toHaveProperty("baseRef");
  });

  it("opens a webhook schedule as a webhook and saves it with its trigger unchanged", () => {
    const definition = {
      execution: {
        projectId: PROJECT,
        title: "Release notes",
        prompt: "Write the release notes.",
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5-5" },
        runtimeMode: "approval-required",
        envMode: "worktree",
        baseRef: "main",
      },
      schedule: { kind: "webhook" },
      enabled: true,
    };
    const automation = {
      automationId: "a-hook",
      projectId: PROJECT,
      definition,
      revision: 2,
      enabled: true,
      cancelled: false,
      nextRunAt: null,
    } as unknown as AgentControlAutomation;
    const row = {
      id: "a-hook",
      automation,
      proposal: null,
      lapsed: null,
    } as unknown as ScheduleRow;
    const opening = scheduleEditorOpening({
      mode: "edit",
      projectId: PROJECT,
      row,
      providers,
      nowMs: NOW_MS,
    });
    expect(scheduleRepeatOf(opening!.draft)).toBe("webhook");
    expect(Number.isFinite(opening!.draft.start)).toBe(true);
    const renamed = { ...opening!.draft, title: "Release notes (beta)" };
    expect(definitionFromDraft(renamed).schedule).toEqual({ kind: "webhook" });
    expect(withRepeat(renamed, "webhook").kind).toBe("webhook");
    // A switch back to times starts from the draft's kept time fields.
    expect(withRepeat(renamed, "interval").kind).toBe("fixed-interval");
  });
});
