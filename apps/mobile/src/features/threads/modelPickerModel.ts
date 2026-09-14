import type {
  ModelSelection,
  ProviderOptionDescriptor,
  ProviderOptionSelectionValue,
  ServerConfig,
} from "@ryco/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getModelSelectionOptionDescriptors,
  getProviderOptionCurrentValue,
} from "@ryco/shared/model";

import { buildModelOptions, groupByProvider, type ModelOption } from "../../lib/modelOptions";

// Pure model for the thread's provider+model picker.
//
// Two things separate this from the New Task picker, and both are correctness
// rather than polish:
//
// 1. The caller supplies a locked provider only when shared session policy says
//    a started thread is not safely idle. At idle, every ready provider remains
//    selectable and the next message performs a context handoff.
//
// 2. `serverConfigAtom` is scoped to the ACTIVE environment and is nulled while
//    switching nodes. With a null config `buildModelOptions` returns exactly one
//    option — the fallback — and rendering that as "one model available" or as
//    an empty state would both be lies. It is a loading state.

export interface ModelPickerEntry {
  readonly key: string;
  readonly label: string;
  readonly providerKey: string;
  readonly providerDriver: string;
  readonly selection: ModelSelection;
  /** Needed to derive this model's own option descriptors. */
  readonly capabilities: ModelOption["capabilities"];
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
}

export interface ModelPickerGroup {
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly providerDriver: string;
  readonly entries: ReadonlyArray<ModelPickerEntry>;
}

/**
 * A model's own adjustable options — reasoning effort, fast mode — as declared
 * by the provider for THAT model.
 *
 * They belong to the model, not the thread: a model that does not declare fast
 * mode simply has none, so the rail carrying these must disappear rather than
 * render an empty or disabled control. `hasRail` says whether there is anything
 * to show at all.
 */
export interface ModelOptionChoice {
  readonly id: string;
  readonly label: string;
  /** <=6 characters, for the 58pt rail. `label` still reaches screen readers. */
  readonly shortLabel: string;
  readonly selected: boolean;
}

export interface ModelOptionControl {
  readonly id: string;
  readonly label: string;
  readonly kind: "select" | "boolean";
  /** Select only. Ordered as the provider declared them. */
  readonly choices: ReadonlyArray<ModelOptionChoice>;
  /** Boolean only. */
  readonly enabled: boolean;
}

export interface ModelPickerModel {
  /** Controls for the CURRENTLY SELECTED model. Empty when it declares none. */
  readonly options: ReadonlyArray<ModelOptionControl>;
  readonly hasOptionRail: boolean;
  /** Rail pill text: the short model name, or a stand-in while config loads. */
  readonly pillLabel: string;
  /**
   * The selected reasoning level, short form, for the composer chip. Null when
   * the model declares no reasoning option — the chip must then show nothing
   * rather than a placeholder.
   */
  readonly pillReasoningLabel: string | null;
  /** True only when the model declares fast mode AND it is on. */
  readonly pillFastEnabled: boolean;
  readonly pillProviderDriver: string | null;
  readonly pillAccessibilityLabel: string;
  readonly groups: ReadonlyArray<ModelPickerGroup>;
  /** True while the server config has not arrived for this environment. */
  readonly loading: boolean;
  /** Set when the thread is pinned to one provider. */
  readonly lockedProviderKey: string | null;
  readonly lockNotice: string | null;
  /** True when a query matched nothing — distinct from having no models. */
  readonly emptyForQuery: boolean;
}

export interface ModelPickerInput {
  readonly serverConfig: ServerConfig | null | undefined;
  readonly currentSelection: ModelSelection | null;
  /** Exact provider instance retained while the thread is not safely idle. */
  readonly lockedProviderKey?: string | null;
  /** Human-readable explanation for the temporary lock. */
  readonly lockNotice?: string | null;
  /** @deprecated Compatibility for New Task and older pure-model callers. */
  readonly providerLocked?: boolean;
  readonly query?: string;
}

const LOCK_NOTICE = "Wait for this task to become idle before switching providers.";

function matches(option: ModelOption, query: string): boolean {
  if (!query) return true;
  return `${option.label} ${option.providerLabel}`.toLocaleLowerCase().includes(query);
}

export function buildModelPickerModel(input: ModelPickerInput): ModelPickerModel {
  return buildModelPickerModelFromOptions({
    ...input,
    modelOptions: buildModelOptions(input.serverConfig, input.currentSelection),
    loading: input.serverConfig === null || input.serverConfig === undefined,
  });
}

export function buildModelPickerModelFromOptions(
  input: Omit<ModelPickerInput, "serverConfig"> & {
    readonly modelOptions: ReadonlyArray<ModelOption>;
    readonly loading?: boolean;
  },
): ModelPickerModel {
  const query = input.query?.trim().toLocaleLowerCase() ?? "";
  const loading = input.loading ?? false;
  const options = input.modelOptions;
  const lockedProviderKey =
    input.lockedProviderKey ??
    (input.providerLocked ? (input.currentSelection?.instanceId ?? null) : null);
  const lockNotice = input.lockNotice ?? LOCK_NOTICE;

  const selectedKey = input.currentSelection
    ? `${input.currentSelection.instanceId}:${input.currentSelection.model}`
    : null;
  const selectedOption = options.find((option) => option.key === selectedKey) ?? null;

  const controls = buildModelOptionControls(input.currentSelection, selectedOption?.capabilities);

  const groups = groupByProvider(options)
    .map((group) => {
      const locked = lockedProviderKey !== null && group.providerKey !== lockedProviderKey;
      return {
        providerKey: group.providerKey,
        providerLabel: group.providerLabel,
        providerDriver: group.models[0]?.providerDriver ?? "",
        entries: group.models
          .filter((option) => matches(option, query))
          .map((option) => ({
            key: option.key,
            label: option.label,
            providerKey: option.providerKey,
            providerDriver: option.providerDriver,
            selection: option.selection,
            capabilities: option.capabilities,
            selected: option.key === selectedKey,
            disabled: locked,
            disabledReason: locked ? lockNotice : null,
          })),
      };
    })
    .filter((group) => group.entries.length > 0);

  const reasoning = controls.find((control) => control.kind === "select");
  const fastControl = controls.find((control) => control.kind === "boolean");

  return {
    options: controls,
    hasOptionRail: controls.length > 0,
    pillReasoningLabel: reasoning?.choices.find((choice) => choice.selected)?.shortLabel ?? null,
    pillFastEnabled: fastControl?.enabled === true,
    pillLabel:
      selectedOption?.label ?? input.currentSelection?.model ?? (loading ? "Loading…" : "Model"),
    pillProviderDriver: selectedOption?.providerDriver ?? null,
    // The chip shows the reasoning level and a bolt, so the spoken label has to
    // say them too — and it uses the FULL reasoning label, not the abbreviation,
    // because "UCode" is meaningless read aloud.
    pillAccessibilityLabel: selectedOption
      ? [
          `Model: ${selectedOption.label}, ${selectedOption.providerLabel}.`,
          reasoning
            ? `${reasoning.label}: ${reasoning.choices.find((choice) => choice.selected)?.label ?? "default"}.`
            : null,
          fastControl?.enabled === true ? `${fastControl.label} on.` : null,
        ]
          .filter(Boolean)
          .join(" ")
      : loading
        ? "Model: loading."
        : "Model: none selected.",
    groups,
    loading,
    lockedProviderKey,
    lockNotice: lockedProviderKey !== null ? lockNotice : null,
    emptyForQuery: query.length > 0 && groups.length === 0,
  };
}

/**
 * Rail-width abbreviations, keyed by the provider's choice ID rather than its
 * label. Ids are normalized by every driver; labels are upstream text that can
 * change under us, so keying on them would silently stop matching.
 */
const CHOICE_ABBREVIATION: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Min",
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
  ultra: "Ultra",
  ultracode: "UCode",
  ultrathink: "UThink",
};

/** Deterministic fallback for ids no driver has declared yet. */
export function shortChoiceLabel(choice: { readonly id: string; readonly label: string }): string {
  const mapped = CHOICE_ABBREVIATION[choice.id.trim().toLocaleLowerCase()];
  if (mapped) return mapped;
  const label = choice.label.trim().replace(/\s+/g, " ");
  if (label.length <= 6) return label;
  const [first = "", second] = label.split(" ");
  // "Ultra Deep" -> "UltraD"; "Ultracode" -> "Ultrac".
  return second ? `${first.slice(0, 5)}${second[0]!.toLocaleUpperCase()}` : first.slice(0, 6);
}

export function buildModelOptionControls(
  selection: ModelSelection | null,
  capabilities: Parameters<typeof getModelSelectionOptionDescriptors>[1],
): ReadonlyArray<ModelOptionControl> {
  return getModelSelectionOptionDescriptors(selection, capabilities).map(toControl);
}

function toControl(descriptor: ProviderOptionDescriptor): ModelOptionControl {
  if (descriptor.type === "boolean") {
    return {
      id: descriptor.id,
      label: descriptor.label,
      kind: "boolean",
      choices: [],
      enabled: descriptor.currentValue === true,
    };
  }
  return {
    id: descriptor.id,
    label: descriptor.label,
    kind: "select",
    // Declaration order is the provider's ordering and carries meaning
    // (low -> high); do not sort it.
    choices: descriptor.options.map((choice) => ({
      id: choice.id,
      label: choice.label,
      shortLabel: shortChoiceLabel(choice),
      selected: choice.id === getProviderOptionCurrentValue(descriptor),
    })),
    enabled: false,
  };
}

/**
 * A new `ModelSelection` with one option changed.
 *
 * Options ride ON the selection, so changing reasoning or fast mode is the same
 * kind of write as changing the model itself — it goes through
 * `thread.meta.update` like any other selection change.
 */
export function applyModelOption(
  selection: ModelSelection,
  capabilities: Parameters<typeof getModelSelectionOptionDescriptors>[1],
  optionId: string,
  value: ProviderOptionSelectionValue,
): ModelSelection {
  const descriptors = getModelSelectionOptionDescriptors(selection, capabilities);
  const target = descriptors.find((descriptor) => descriptor.id === optionId);
  if (
    !target ||
    (target.type === "boolean"
      ? typeof value !== "boolean"
      : !target.options.some((choice) => choice.id === value))
  )
    return selection;
  const next = descriptors.map((descriptor) =>
    descriptor.id === optionId ? { ...descriptor, currentValue: value } : descriptor,
  ) as ReadonlyArray<ProviderOptionDescriptor>;
  const options = buildProviderOptionSelectionsFromDescriptors(next);
  return options ? { ...selection, options } : selection;
}

/** The selection a tap should produce, or null when the tap must be ignored. */
export function resolveModelPickerSelection(
  model: ModelPickerModel,
  key: string,
): ModelSelection | null {
  for (const group of model.groups) {
    const entry = group.entries.find((candidate) => candidate.key === key);
    if (!entry) continue;
    if (entry.disabled || entry.selected) return null;
    return entry.selection;
  }
  return null;
}
