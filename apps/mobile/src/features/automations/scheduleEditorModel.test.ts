import {
  definitionFromDraft,
  scheduleDraftKey,
  type ScheduleRow,
} from "@ryco/client-runtime/state/agentControl";
import type { AgentControlAutomation, ProjectId, ServerProvider } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { listModelPickerEntries } from "../threads/modelPickerModel";
import {
  scheduleEditorOpening,
  scheduleModelPicker,
  schedulePolicyModel,
  scheduleRepeatOf,
  scheduleTokenMode,
  withCalendarChoice,
  withRepeat,
  withScheduleModel,
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
    auth: { status: "authenticated" },
    models: [{ slug: "gpt-5.5", name: "GPT-5.5", capabilities: null }],
  },
  {
    instanceId: "claude",
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: [
      {
        slug: "claude-sonnet-5-5",
        name: "Sonnet 5.5",
        capabilities: { optionDescriptors: [effort] },
      },
      {
        slug: "claude-haiku-5-5",
        name: "Haiku 5.5",
        capabilities: null,
        supportsAutoMode: false,
      },
    ],
  },
] as unknown as ServerProvider[];

/** An approved schedule's row, opened for a change. */
function editing(execution: Record<string, unknown>) {
  const definition = {
    execution: {
      projectId: PROJECT,
      title: "Nightly",
      prompt: "Check things.",
      runtimeMode: "approval-required",
      envMode: "worktree",
      ...execution,
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
    automationId: "a-edit",
    projectId: PROJECT,
    definition,
    revision: 1,
    enabled: true,
    cancelled: false,
    nextRunAt: definition.schedule.startsAt,
  } as unknown as AgentControlAutomation;
  const row = { id: "a-edit", automation, proposal: null, lapsed: null } as unknown as ScheduleRow;
  return scheduleEditorOpening({
    mode: "edit",
    projectId: PROJECT,
    row,
    providers,
    nowMs: NOW_MS,
  })!;
}

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

  it("offers ready providers' models in the composer's picker, the effort where the model has it", () => {
    const draft = scheduleEditorOpening({
      mode: "new",
      projectId: PROJECT,
      row: null,
      providers,
      nowMs: NOW_MS,
    })!.draft;
    const picker = scheduleModelPicker(providers, draft.modelSelection);
    expect(picker.groups.map((group) => group.providerKey)).toEqual(["claude"]);
    expect(picker.pillLabel).toBe("Sonnet 5.5");
    expect(picker.pillProviderDriver).toBe("claudeAgent");
    expect(picker.pillReasoningLabel).not.toBeNull();
    const entries = listModelPickerEntries(picker);
    const haiku = withScheduleModel(
      draft,
      providers,
      entries.find((entry) => entry.selection.model === "claude-haiku-5-5")!.selection,
    );
    expect(haiku.modelSelection).toEqual({ instanceId: "claude", model: "claude-haiku-5-5" });
    // Options the picked model does not offer are dropped.
    const carried = withScheduleModel(draft, providers, {
      ...haiku.modelSelection,
      options: [{ id: "effort", value: "high" }],
    });
    expect(carried.modelSelection.options).toBeUndefined();
    const back = withScheduleModel(
      haiku,
      providers,
      listModelPickerEntries(scheduleModelPicker(providers, haiku.modelSelection)).find(
        (entry) => entry.selection.model === "claude-sonnet-5-5",
      )!.selection,
    );
    expect(back.modelSelection.options).toEqual([{ id: "effort", value: "medium" }]);
  });

  it("asks for a model when the machine has none ready", () => {
    const draft = scheduleEditorOpening({
      mode: "new",
      projectId: PROJECT,
      row: null,
      providers: [],
      nowMs: NOW_MS,
    })!.draft;
    const picker = scheduleModelPicker([], draft.modelSelection);
    expect(picker.pillLabel).toBe("Pick a model");
    expect(picker.groups).toEqual([]);
  });

  it("keeps a stored model that is no longer offered readable and unchanged on save", () => {
    // Its provider is off: named by the provider's own model list.
    const off = editing({ modelSelection: { instanceId: "off", model: "gpt-5.5" } });
    const offPicker = scheduleModelPicker(providers, off.draft.modelSelection);
    expect(offPicker.pillLabel).toBe("GPT-5.5");
    expect(offPicker.pillProviderDriver).toBe("codex");
    // An instance the machine no longer has, with options nothing describes.
    const gone = editing({
      modelSelection: {
        instanceId: "removed",
        model: "some-model-1",
        options: [{ id: "effort", value: "max" }],
      },
    });
    const gonePicker = scheduleModelPicker(providers, gone.draft.modelSelection);
    expect(gonePicker.pillLabel).toBe("some-model-1");
    expect(listModelPickerEntries(gonePicker).find((entry) => entry.selected)?.key).toBe(
      "removed:some-model-1",
    );
    // A model its ready provider dropped.
    const dropped = editing({ modelSelection: { instanceId: "claude", model: "claude-opus-4" } });
    expect(scheduleModelPicker(providers, dropped.draft.modelSelection).pillLabel).toBe(
      "claude-opus-4",
    );
    for (const opening of [off, gone, dropped]) {
      expect(scheduleDraftKey(opening.draft)).toBe(opening.initialKey);
      expect(definitionFromDraft(opening.draft).execution.modelSelection).toEqual(
        opening.draft.modelSelection,
      );
    }
    expect(definitionFromDraft(gone.draft).execution.modelSelection.options).toEqual([
      { id: "effort", value: "max" },
    ]);
  });

  it("offers Access without Mode, and no Auto where the model cannot run it", () => {
    const opening = editing({
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5-5" },
      runtimeMode: "auto-accept-edits",
    });
    const policy = schedulePolicyModel(opening.draft, providers);
    expect(policy.mode).toBeNull();
    expect(policy.access.segments.find((segment) => segment.selected)?.value).toBe(
      "auto-accept-edits",
    );
    expect(policy.access.segments.find((segment) => segment.value === "auto")?.disabled).toBe(
      false,
    );
    const haiku = schedulePolicyModel(
      {
        ...opening.draft,
        modelSelection: { instanceId: "claude", model: "claude-haiku-5-5" },
      } as typeof opening.draft,
      providers,
    );
    expect(haiku.access.segments.find((segment) => segment.value === "auto")?.disabled).toBe(true);
  });

  it("shows the machine's token mode for a schedule without one and saves none", () => {
    const opening = editing({
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5-5" },
    });
    expect(opening.draft.tokenMode).toBeNull();
    expect(scheduleTokenMode(opening.draft, "balanced")).toBe("balanced");
    expect(definitionFromDraft(opening.draft).execution).not.toHaveProperty("tokenMode");
    const aggressive = { ...opening.draft, tokenMode: "aggressive" as const };
    expect(scheduleTokenMode(aggressive, "balanced")).toBe("aggressive");
    expect(definitionFromDraft(aggressive).execution.tokenMode).toBe("aggressive");
    const stored = editing({
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5-5" },
      tokenMode: "balanced",
    });
    expect(scheduleTokenMode(stored.draft, "off")).toBe("balanced");
    expect(definitionFromDraft(stored.draft).execution.tokenMode).toBe("balanced");
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
