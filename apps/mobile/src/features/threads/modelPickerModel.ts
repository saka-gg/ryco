import { splitLegacyModels } from "@ryco/client-runtime/state/composer/legacyModelFold";
import { formatProviderUpdateRequiredNotice } from "@ryco/client-runtime/state/composer/providerUpdateRequiredNotice";
import type {
  ModelSelection,
  ProviderOptionDescriptor,
  ProviderOptionSelectionValue,
  ServerConfig,
  ServerProvider,
} from "@ryco/contracts";
import type { FastModeNotice } from "@ryco/client-runtime/state/session";
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
  /** Empty only while searching, when the group stays for its notice alone. */
  readonly entries: ReadonlyArray<ModelPickerEntry>;
  /**
   * Models the manifest marks legacy, folded under a collapsed "Legacy models"
   * row after `entries`. The selected model and custom models never fold, and
   * a search lists matching legacy models in `entries` instead.
   */
  readonly legacyEntries: ReadonlyArray<ModelPickerEntry>;
  /** Which CLI update unlocks models this instance can't run yet, if any match. */
  readonly updateRequiredNotice: string | null;
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
  /**
   * True when a query matched no model — distinct from having no models. Groups
   * can remain for their update notices.
   */
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
  /** Provider snapshots, for the notices naming the update a model needs. */
  readonly providers?: ReadonlyArray<ServerProvider> | undefined;
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
    providers: input.serverConfig?.providers,
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

  const providers = new Map<string, ServerProvider>(
    (input.providers ?? []).map((provider) => [provider.instanceId, provider]),
  );

  const groups = groupByProvider(options).flatMap((group): ReadonlyArray<ModelPickerGroup> => {
    const locked = lockedProviderKey !== null && group.providerKey !== lockedProviderKey;
    const toEntry = (option: ModelOption): ModelPickerEntry => ({
      key: option.key,
      label: option.label,
      providerKey: option.providerKey,
      providerDriver: option.providerDriver,
      selection: option.selection,
      capabilities: option.capabilities,
      selected: option.key === selectedKey,
      disabled: locked,
      disabledReason: locked ? lockNotice : null,
    });
    const matching = group.models.filter((option) => matches(option, query));
    // A search lists matching legacy models inline. The selected model stays
    // in view even when it is legacy, as Claude's text-generation default is.
    const { current, legacy } = query
      ? { current: matching, legacy: [] }
      : splitLegacyModels(matching, (option) => option.key === selectedKey);
    const provider = providers.get(group.providerKey);
    const updateRequiredNotice = provider
      ? formatProviderUpdateRequiredNotice(provider, query)
      : null;
    // A search for a model the CLI is too old to run keeps its group, so the
    // notice can say which update unlocks it.
    if (current.length === 0 && updateRequiredNotice === null) return [];
    return [
      {
        providerKey: group.providerKey,
        providerLabel: group.providerLabel,
        providerDriver: group.models[0]?.providerDriver ?? "",
        entries: current.map(toEntry),
        legacyEntries: legacy.map(toEntry),
        updateRequiredNotice,
      },
    ];
  });

  const reasoning = controls.find((control) => control.kind === "select");
  // By id: a model's first on/off option can be another one, such as Haiku's thinking.
  const fastControl = controls.find(
    (control) => control.kind === "boolean" && control.id === "fastMode",
  );

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
    emptyForQuery: query.length > 0 && groups.every((group) => group.entries.length === 0),
  };
}

export interface ModelPillFastMode {
  /** The pill's trailing glyph; undefined shows none. */
  readonly icon: "bolt.fill" | "bolt.slash" | "bolt" | undefined;
  /** The bolt stands for Fast that is not serving, so it takes the subtle tone. */
  readonly muted: boolean;
  readonly accessibilityLabel: string;
}

/**
 * The pill's Fast bolt and spoken label with Claude Code's own report folded in: the notice comes
 * from `deriveClaudeFastModeNotice`, asked with `pillFastEnabled` as the request, so it is applied
 * to a built model rather than rebuilding every group on each thread activity. Paused or refused
 * Fast strikes the bolt through; Fast that Claude Code's own settings turned on shows an outline.
 * The spoken label says which and why, since the glyph alone cannot.
 */
export function resolveModelPillFastMode(
  model: Pick<ModelPickerModel, "pillFastEnabled" | "pillAccessibilityLabel">,
  fastModeNotice: FastModeNotice | null | undefined,
): ModelPillFastMode {
  if (!fastModeNotice) {
    return {
      icon: model.pillFastEnabled ? "bolt.fill" : undefined,
      muted: false,
      accessibilityLabel: model.pillAccessibilityLabel,
    };
  }
  const external = fastModeNotice.kind === "external";
  return {
    icon: external ? "bolt" : "bolt.slash",
    muted: !external,
    accessibilityLabel: `${model.pillAccessibilityLabel} ${fastModeNotice.label}. ${fastModeNotice.detail}`,
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

/** Every model the picker offers, folded legacy ones included. */
export function listModelPickerEntries(
  model: Pick<ModelPickerModel, "groups">,
): ReadonlyArray<ModelPickerEntry> {
  return model.groups.flatMap((group) => [...group.entries, ...group.legacyEntries]);
}

/** The selection a tap should produce, or null when the tap must be ignored. */
export function resolveModelPickerSelection(
  model: ModelPickerModel,
  key: string,
): ModelSelection | null {
  const entry = listModelPickerEntries(model).find((candidate) => candidate.key === key);
  if (!entry || entry.disabled || entry.selected) return null;
  return entry.selection;
}
