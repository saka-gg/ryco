// The phone's schedule editor: where a draft starts and how its pickers change it. The rules
// (the sentence, fixes, validation, the model default) are the web editor's, shared through
// `@ryco/client-runtime/state/automations/editor` and the schedule model. Pure.

import {
  blankScheduleDraft,
  draftOfLatest,
  scheduleDraftKey,
  type ScheduleDraft,
} from "@ryco/client-runtime/state/agentControl";
import type { DialogRow } from "@ryco/client-runtime/state/automations/dialogModel";
import {
  calendarChoiceWeekdays,
  defaultScheduleModel,
  emptyModelSelection,
  type CalendarChoice,
} from "@ryco/client-runtime/state/automations/editor";
import type {
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ServerProvider,
} from "@ryco/contracts";
import {
  DAY_MS,
  fitScheduleModelOptions,
  isAutomationProviderReady,
  providerDisplayName,
} from "@ryco/shared/automationSchedule";
import {
  createModelSelection,
  getModelDisplayName,
  getProviderOptionCurrentValue,
  REASONING_DESCRIPTOR_IDS,
} from "@ryco/shared/model";

export type ScheduleEditorMode = "new" | "edit" | "repropose";

export interface ScheduleEditorOpening {
  readonly draft: ScheduleDraft;
  /** `scheduleDraftKey` as it opened; "" for a re-proposal (always worth saving). */
  readonly initialKey: string;
  readonly isNew: boolean;
}

/**
 * Where the editor starts, like the web's: a new schedule blank (its machine's first ready
 * model; the worktree off the project's default branch, which the node picks), a pending
 * edit or a proposed new schedule as proposed, else the schedule itself, its past start
 * rolled forward. Null while the schedule a change is for is not known yet.
 */
export function scheduleEditorOpening(input: {
  readonly mode: ScheduleEditorMode;
  readonly projectId: ProjectId;
  readonly row: DialogRow["row"] | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly nowMs: number;
}): ScheduleEditorOpening | null {
  const options = { defaultBaseRef: "" };
  if (input.mode === "new") {
    const draft = blankScheduleDraft({
      projectId: input.projectId,
      nowMs: input.nowMs,
      modelSelection: defaultScheduleModel(input.providers) ?? emptyModelSelection(),
      baseRef: "",
    });
    return { draft, initialKey: scheduleDraftKey(draft), isNew: true };
  }
  const row = input.row;
  if (!row) return null;
  if (input.mode === "repropose") {
    const source = row.lapsed ?? row.proposal;
    if (!source) return null;
    return {
      draft: draftOfLatest(source, input.nowMs, options),
      initialKey: "",
      isNew: !row.automation,
    };
  }
  const proposed = row.proposal?.kind === "edit" || !row.automation;
  const from = proposed ? (row.proposal ?? row.lapsed) : row.automation;
  if (!from) return null;
  const draft = draftOfLatest(from, input.nowMs, options);
  return { draft, initialKey: scheduleDraftKey(draft), isNew: !row.automation };
}

/** What "Repeats" reads as: an interval, chosen days, or one run. */
export type ScheduleRepeat = "interval" | "days" | "once";

export function scheduleRepeatOf(draft: ScheduleDraft): ScheduleRepeat {
  return draft.kind === "once" ? "once" : draft.kind === "calendar" ? "days" : "interval";
}

/** The draft as another kind of schedule; its first run stays where it was. */
export function withRepeat(draft: ScheduleDraft, repeat: ScheduleRepeat): ScheduleDraft {
  if (repeat === "once") return { ...draft, kind: "once" };
  if (repeat === "interval")
    return {
      ...draft,
      kind: "fixed-interval",
      intervalMs: draft.intervalMs > 0 ? draft.intervalMs : DAY_MS,
    };
  return {
    ...draft,
    kind: "calendar",
    weekdays: draft.weekdays.length > 0 ? draft.weekdays : calendarChoiceWeekdays("daily", draft),
  };
}

export function withCalendarChoice(draft: ScheduleDraft, choice: CalendarChoice): ScheduleDraft {
  return { ...draft, kind: "calendar", weekdays: calendarChoiceWeekdays(choice, draft) };
}

export interface ScheduleModelChoice {
  /** `instanceId` and slug, joined by a unit separator. */
  readonly id: string;
  readonly title: string;
  readonly selected: boolean;
}

export interface ScheduleProviderChoices {
  readonly instanceId: string;
  readonly title: string;
  readonly models: ReadonlyArray<ScheduleModelChoice>;
}

const SEPARATOR = "\u001f";

/** The models a schedule can run on: each ready provider's, by provider. */
export function scheduleModelChoices(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
): ReadonlyArray<ScheduleProviderChoices> {
  return providers
    .filter((provider) => isAutomationProviderReady(provider) && provider.models.length > 0)
    .map((provider) => ({
      instanceId: provider.instanceId,
      title: providerDisplayName(provider),
      models: provider.models.map((model) => ({
        id: `${provider.instanceId}${SEPARATOR}${model.slug}`,
        title: getModelDisplayName(model),
        selected: selection.instanceId === provider.instanceId && selection.model === model.slug,
      })),
    }));
}

function reasoningDescriptor(providers: ReadonlyArray<ServerProvider>, selection: ModelSelection) {
  const model = providers
    .find((provider) => provider.instanceId === selection.instanceId)
    ?.models.find((candidate) => candidate.slug === selection.model);
  const descriptor = (model?.capabilities?.optionDescriptors ?? []).find(
    (candidate) => candidate.type === "select" && REASONING_DESCRIPTOR_IDS.has(candidate.id),
  );
  return descriptor?.type === "select" ? descriptor : null;
}

/** A model picked from `scheduleModelChoices`: the effort is kept where it fits, else its default. */
export function withModelChoice(
  draft: ScheduleDraft,
  providers: ReadonlyArray<ServerProvider>,
  choiceId: string,
): ScheduleDraft {
  const [instanceId, slug] = choiceId.split(SEPARATOR);
  if (!instanceId || !slug) return draft;
  const kept = fitScheduleModelOptions(
    createModelSelection(instanceId as ProviderInstanceId, slug, draft.modelSelection.options),
    providers,
  );
  const descriptor = reasoningDescriptor(providers, kept);
  if (!descriptor || kept.options?.some((option) => option.id === descriptor.id))
    return { ...draft, modelSelection: kept };
  const value = getProviderOptionCurrentValue(descriptor);
  return {
    ...draft,
    modelSelection: createModelSelection(
      kept.instanceId,
      kept.model,
      typeof value === "string"
        ? [...(kept.options ?? []), { id: descriptor.id, value }]
        : kept.options,
    ),
  };
}

export interface ScheduleEffortChoices {
  readonly descriptorId: string;
  readonly label: string;
  readonly choices: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly selected: boolean;
  }>;
}

/** The model's reasoning effort choices, or null when it has none. */
export function scheduleEffortChoices(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
): ScheduleEffortChoices | null {
  const descriptor = reasoningDescriptor(providers, selection);
  if (!descriptor) return null;
  const current =
    selection.options?.find((option) => option.id === descriptor.id)?.value ??
    getProviderOptionCurrentValue(descriptor);
  return {
    descriptorId: descriptor.id,
    label: descriptor.label,
    choices: descriptor.options.map((choice) => ({
      id: choice.id,
      title: choice.label,
      selected: choice.id === current,
    })),
  };
}

export function withEffort(
  draft: ScheduleDraft,
  descriptorId: string,
  value: string,
): ScheduleDraft {
  const others = (draft.modelSelection.options ?? []).filter(
    (option) => option.id !== descriptorId,
  );
  return {
    ...draft,
    modelSelection: createModelSelection(
      draft.modelSelection.instanceId,
      draft.modelSelection.model,
      [...others, { id: descriptorId, value }],
    ),
  };
}
