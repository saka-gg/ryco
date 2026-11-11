// The phone's schedule editor: where a draft starts and how its pickers change it. The rules
// (the sentence, fixes, validation, the model default) are the web editor's, shared through
// `@ryco/client-runtime/state/automations/editor` and the schedule model; the model pill and
// the "⋯" menu are the chat composer's (`ComposerModelControls`), fed from here. Pure.

import {
  blankScheduleDraft,
  draftOfLatest,
  scheduleDraftKey,
  scheduleModelLabel,
  type ScheduleDraft,
} from "@ryco/client-runtime/state/agentControl";
import { getAutoRuntimeModeUnavailableReason } from "@ryco/client-runtime/state/composer";
import type { DialogRow } from "@ryco/client-runtime/state/automations/dialogModel";
import {
  calendarChoiceWeekdays,
  defaultScheduleModel,
  emptyModelSelection,
  modelMissing,
  type CalendarChoice,
} from "@ryco/client-runtime/state/automations/editor";
import type { AgentTokenMode, ModelSelection, ProjectId, ServerProvider } from "@ryco/contracts";
import {
  DAY_MS,
  fitScheduleModelOptions,
  isAutomationProviderReady,
  providerDisplayName,
} from "@ryco/shared/automationSchedule";

import { buildModelOptionsFromProviders, type ModelOption } from "../../lib/modelOptions";
import {
  buildModelPickerModelFromOptions,
  type ModelPickerModel,
} from "../threads/modelPickerModel";
import { buildSessionPolicyModel, type SessionPolicyModel } from "../threads/sessionPolicyModel";

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

/**
 * What "Repeats" reads as: an interval, chosen days, or one run. `webhook`: it runs when its
 * webhook is called; the phone shows that trigger but does not offer it, and keeps it as is.
 */
export type ScheduleRepeat = "interval" | "days" | "once" | "webhook";

export function scheduleRepeatOf(draft: ScheduleDraft): ScheduleRepeat {
  if (draft.kind === "webhook") return "webhook";
  return draft.kind === "once" ? "once" : draft.kind === "calendar" ? "days" : "interval";
}

/** The draft as another kind of schedule; its first run stays where it was. */
export function withRepeat(draft: ScheduleDraft, repeat: ScheduleRepeat): ScheduleDraft {
  if (repeat === "webhook") return { ...draft, kind: "webhook" };
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

/** A stored model no provider offers: named as the schedule list names it, under its provider. */
function storedModelOption(
  option: ModelOption,
  providers: ReadonlyArray<ServerProvider>,
): ModelOption {
  const owner = providers.find((provider) => provider.instanceId === option.selection.instanceId);
  return {
    ...option,
    label: scheduleModelLabel(option.selection, providers),
    providerLabel: owner ? providerDisplayName(owner) : option.providerLabel,
    providerDriver: owner?.driver ?? option.providerDriver,
  };
}

/**
 * The schedule's model as the chat composer's model picker: the models of every provider runs
 * can start on (the server's `isAgentControlProviderReady`), by provider. A stored model that is
 * no longer offered (its provider gone, off or not ready, or the model dropped) stays in view
 * under its own name, so the pill reads it and saving without a change keeps it.
 */
export function scheduleModelPicker(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
): ModelPickerModel {
  const ready = providers.filter(isAutomationProviderReady);
  if (modelMissing(selection)) {
    const picker = buildModelPickerModelFromOptions({
      modelOptions: buildModelOptionsFromProviders(ready, null),
      providers,
      currentSelection: null,
    });
    return {
      ...picker,
      pillLabel: "Pick a model",
      pillAccessibilityLabel: "Model: pick a model.",
    };
  }
  const key = `${selection.instanceId}:${selection.model}`;
  const offered = buildModelOptionsFromProviders(ready, null).some((option) => option.key === key);
  const options = buildModelOptionsFromProviders(ready, selection);
  const modelOptions = offered
    ? options
    : options.map((option) => (option.key === key ? storedModelOption(option, providers) : option));
  return buildModelPickerModelFromOptions({
    modelOptions,
    providers,
    currentSelection: selection,
  });
}

/** A model or tuning picked in the model picker: only the options that model offers survive. */
export function withScheduleModel(
  draft: ScheduleDraft,
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
): ScheduleDraft {
  return { ...draft, modelSelection: fitScheduleModelOptions(selection, providers) };
}

/**
 * The composer's Access group for a schedule. A schedule stores no interaction mode (each run
 * starts in the default one), so the Mode group is not offered; Auto is off where the model
 * cannot run it, as in a chat.
 */
export function schedulePolicyModel(
  draft: ScheduleDraft,
  providers: ReadonlyArray<ServerProvider>,
): SessionPolicyModel {
  const provider = providers.find(
    (candidate) => candidate.instanceId === draft.modelSelection.instanceId,
  );
  return buildSessionPolicyModel({
    runtimeMode: draft.runtimeMode,
    interactionMode: "default",
    interactionModeSupported: false,
    askModeSupported: false,
    autoModeUnavailableReason: getAutoRuntimeModeUnavailableReason(
      provider?.models ?? [],
      draft.modelSelection.model,
    ),
  });
}

/** Said where the model pill would be, for a heartbeat: its runs use the chat's own model. */
export const HEARTBEAT_MODEL_HINT = "Each run uses the chat's model";

/**
 * Whether the editor offers the model pill. A heartbeat's runs are turns of its chat, which
 * use the chat's model, so it shows none, unless the stored model fails validation: then the
 * pill stays so the schedule can still be saved.
 */
export function scheduleShowsModelPicker(
  draft: Pick<ScheduleDraft, "target">,
  modelError: string | null | undefined,
): boolean {
  return draft.target === null || (modelError !== undefined && modelError !== null);
}

/**
 * The token mode the Tokens group shows: the schedule's own, else the machine's default, which
 * a run without one starts with. Picking that default again keeps the schedule without one.
 */
export function scheduleTokenMode(
  draft: ScheduleDraft,
  machineDefault: AgentTokenMode,
): AgentTokenMode {
  return draft.tokenMode ?? machineDefault;
}
