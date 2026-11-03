import { describe, expect, it } from "vite-plus/test";
import { isValidElement, type ReactElement } from "react";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationThreadActivity,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@ryco/contracts";
import { DraftId } from "../../composerDraftStore";
import {
  getComposerProviderState,
  renderProviderTraitsChips,
  renderProviderModelTuning,
  getProviderModelTuningSummary,
  renderProviderTraitsMenuContent,
} from "./composerProviderState";

// Everything in composerProviderState is now data-driven by the model's
// optionDescriptors, so these tests use a single synthetic provider/model and
// vary only the descriptor shape per scenario.

const PROVIDER: ProviderDriverKind = ProviderDriverKind.make("codex");
const INSTANCE_ID = ProviderInstanceId.make("codex_secondary");
const MODEL = "test-model";

function selectDescriptor(
  id: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
  promptInjectedValues?: ReadonlyArray<string>,
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  const defaultId = options.find((option) => option.isDefault)?.id;
  return {
    id,
    label: id,
    type: "select",
    options: [...options],
    ...(defaultId ? { currentValue: defaultId } : {}),
    ...(promptInjectedValues && promptInjectedValues.length > 0
      ? { promptInjectedValues: [...promptInjectedValues] }
      : {}),
  };
}

function booleanDescriptor(id: string): Extract<ProviderOptionDescriptor, { type: "boolean" }> {
  return { id, label: id, type: "boolean" };
}

function modelWith(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<ServerProviderModel> {
  return [
    { slug: MODEL, name: MODEL, isCustom: false, capabilities: { optionDescriptors: descriptors } },
  ];
}

function selections(
  ...entries: Array<[string, string | boolean]>
): ReadonlyArray<ProviderOptionSelection> {
  return entries.map(([id, value]) => ({ id, value }));
}

const ULTRATHINK_FRAME_CLASSES = {
  composerFrameClassName: "ultrathink-frame",
  composerSurfaceClassName: "shadow-[0_0_0_1px_rgba(255,255,255,0.04)_inset]",
  modelPickerIconClassName: "ultrathink-chroma",
} as const;

describe("getComposerProviderState", () => {
  it("returns descriptor defaults when no selections are provided", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("effort", [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ]),
      ]),
      prompt: "",
      modelOptions: undefined,
    });

    expect(state).toEqual({
      provider: PROVIDER,
      promptEffort: "high",
      modelOptionsForDispatch: selections(["effort", "high"]),
    });
  });

  it("lets selections override defaults and propagates them through dispatch", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("effort", [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ]),
        booleanDescriptor("fastMode"),
      ]),
      prompt: "",
      modelOptions: selections(["effort", "low"], ["fastMode", true]),
    });

    expect(state).toEqual({
      provider: PROVIDER,
      promptEffort: "low",
      modelOptionsForDispatch: selections(["effort", "low"], ["fastMode", true]),
    });
  });

  it("preserves selections that match defaults so deepMerge can overwrite prior state", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("effort", [{ id: "high", label: "High", isDefault: true }]),
        booleanDescriptor("fastMode"),
      ]),
      prompt: "",
      modelOptions: selections(["effort", "high"], ["fastMode", false]),
    });

    expect(state.modelOptionsForDispatch).toEqual(
      selections(["effort", "high"], ["fastMode", false]),
    );
  });

  it("drops selections for descriptors the model does not declare", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([booleanDescriptor("thinking")]),
      prompt: "",
      modelOptions: selections(["effort", "max"], ["thinking", false]),
    });

    expect(state).toEqual({
      provider: PROVIDER,
      promptEffort: null,
      modelOptionsForDispatch: selections(["thinking", false]),
    });
  });

  it("derives promptEffort from the first select descriptor and preserves all others for dispatch", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("effort", [{ id: "high", label: "High", isDefault: true }]),
        selectDescriptor("contextWindow", [
          { id: "200k", label: "200k", isDefault: true },
          { id: "1m", label: "1M" },
        ]),
        selectDescriptor("agent", [
          { id: "build", label: "Build", isDefault: true },
          { id: "plan", label: "Plan" },
        ]),
      ]),
      prompt: "",
      modelOptions: selections(["agent", "plan"]),
    });

    expect(state.promptEffort).toBe("high");
    expect(state.modelOptionsForDispatch).toEqual(
      selections(["effort", "high"], ["contextWindow", "200k"], ["agent", "plan"]),
    );
  });

  it("returns undefined dispatch options when the model declares no descriptors", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([]),
      prompt: "",
      modelOptions: selections(["anything", "value"]),
    });

    expect(state).toEqual({
      provider: PROVIDER,
      promptEffort: null,
      modelOptionsForDispatch: undefined,
    });
  });

  it("adds ultrathink class names when the prompt triggers a promptInjectedValues descriptor", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor(
          "effort",
          [
            { id: "medium", label: "Medium" },
            { id: "high", label: "High", isDefault: true },
            { id: "ultrathink", label: "Ultrathink" },
          ],
          ["ultrathink"],
        ),
      ]),
      prompt: "Ultrathink:\nInvestigate this failure",
      modelOptions: selections(["effort", "medium"]),
    });

    expect(state).toEqual({
      provider: PROVIDER,
      promptEffort: "medium",
      modelOptionsForDispatch: selections(["effort", "medium"]),
      ...ULTRATHINK_FRAME_CLASSES,
    });
  });

  it("does not add ultrathink class names when the descriptor has no promptInjectedValues", () => {
    const state = getComposerProviderState({
      provider: PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("effort", [{ id: "high", label: "High", isDefault: true }]),
      ]),
      prompt: "Ultrathink:\nInvestigate this failure",
      modelOptions: undefined,
    });

    expect(state).not.toHaveProperty("composerFrameClassName");
    expect(state).not.toHaveProperty("composerSurfaceClassName");
    expect(state).not.toHaveProperty("modelPickerIconClassName");
  });
});

describe("provider traits render guards", () => {
  it("hides the provider agent selector when build mode is enforced", () => {
    const args = {
      provider: ProviderDriverKind.make("opencode"),
      draftId: DraftId.make("build-mode"),
      model: MODEL,
      models: modelWith([
        selectDescriptor("agent", [
          { id: "build", label: "Build", isDefault: true },
          { id: "plan", label: "Plan" },
        ]),
      ]),
      modelOptions: selections(["agent", "plan"]),
      prompt: "",
      onPromptChange: () => {},
    };
    expect(renderProviderTraitsChips({ ...args, hideAgent: true })).toBeNull();
    expect(renderProviderTraitsMenuContent({ ...args, hideAgent: true })).toBeNull();
    expect(isValidElement(renderProviderTraitsChips(args))).toBe(true);
    expect(isValidElement(renderProviderTraitsMenuContent(args))).toBe(true);
  });

  it("returns null when no thread target is provided", () => {
    const models = modelWith([
      selectDescriptor("effort", [{ id: "high", label: "High", isDefault: true }]),
    ]);
    const args = {
      provider: PROVIDER,
      model: MODEL,
      models,
      modelOptions: undefined,
      prompt: "",
      onPromptChange: () => {},
    };

    expect(renderProviderTraitsChips(args)).toBeNull();
    expect(renderProviderTraitsMenuContent(args)).toBeNull();
  });

  it("passes instance id through traits render helpers", () => {
    const models = modelWith([
      selectDescriptor("effort", [{ id: "high", label: "High", isDefault: true }]),
      selectDescriptor("agent", [{ id: "build", label: "Build", isDefault: true }]),
    ]);
    const args = {
      provider: PROVIDER,
      instanceId: INSTANCE_ID,
      draftId: DraftId.make("draft-traits-instance"),
      model: MODEL,
      models,
      modelOptions: undefined,
      prompt: "",
      onPromptChange: () => {},
    };
    const chips = renderProviderTraitsChips(args);
    const menu = renderProviderTraitsMenuContent(args);
    const tuning = renderProviderModelTuning(args);

    for (const element of [chips, menu, tuning]) {
      expect(isValidElement(element)).toBe(true);
      expect((element as ReactElement<{ instanceId?: ProviderInstanceId }>).props.instanceId).toBe(
        INSTANCE_ID,
      );
    }
  });

  it("routes dial-owned options to the model tuning dial instead of chips", () => {
    const args = {
      provider: PROVIDER,
      draftId: DraftId.make("draft-tuning-only"),
      model: MODEL,
      models: modelWith([
        selectDescriptor("effort", [{ id: "high", label: "High", isDefault: true }]),
        selectDescriptor("contextWindow", [{ id: "1m", label: "1M", isDefault: true }]),
      ]),
      modelOptions: undefined,
      prompt: "",
      onPromptChange: () => {},
    };
    expect(renderProviderTraitsChips(args)).toBeNull();
    expect(renderProviderTraitsMenuContent({ ...args, omitTuning: true })).toBeNull();
    expect(isValidElement(renderProviderTraitsMenuContent(args))).toBe(true);
    expect(isValidElement(renderProviderModelTuning(args))).toBe(true);
    expect(
      getProviderModelTuningSummary({
        provider: PROVIDER,
        model: MODEL,
        models: args.models,
        modelOptions: undefined,
        prompt: "",
      }),
    ).toEqual({
      level: { id: "high", label: "High", index: 0 },
      speed: "standard",
      contextWindowLabel: "1M",
    });
  });
});

describe("getProviderModelTuningSummary Fast mode notice", () => {
  const CLAUDE = ProviderDriverKind.make("claudeAgent");
  const CLAUDE_INSTANCE = "claude-hub";
  const models = modelWith([booleanDescriptor("fastMode")]);
  const report = (payload: Record<string, unknown>): OrchestrationThreadActivity => ({
    id: EventId.make("claude-fast-mode:thread-1:state"),
    kind: "fast-mode.state",
    tone: "info",
    summary: "Fast mode state",
    payload: { instanceId: CLAUDE_INSTANCE, model: MODEL, ...payload },
    turnId: null,
    createdAt: "2026-10-28T00:00:00.000Z",
  });
  const summarize = (input: {
    provider?: ProviderDriverKind;
    fast: boolean;
    activities?: ReadonlyArray<OrchestrationThreadActivity>;
  }) =>
    getProviderModelTuningSummary({
      provider: input.provider ?? CLAUDE,
      model: MODEL,
      models,
      modelOptions: selections(["fastMode", input.fast]),
      prompt: "",
      instanceId: CLAUDE_INSTANCE,
      ...(input.activities ? { activities: input.activities } : {}),
    });

  it("carries the notice when Claude Code serves another speed than the requested one", () => {
    expect(
      summarize({ fast: true, activities: [report({ state: "cooldown" })] })?.speedNotice,
    ).toMatchObject({ kind: "cooldown", label: "Fast paused" });
    expect(
      summarize({
        fast: true,
        activities: [report({ state: "off", disabledReason: "not_first_party" })],
      })?.speedNotice,
    ).toMatchObject({ kind: "blocked", label: "Fast unavailable" });
    expect(
      summarize({ fast: false, activities: [report({ state: "on", requested: false })] })
        ?.speedNotice,
    ).toMatchObject({ kind: "external", label: "Fast on" });
    // Fast mode the session served because Ryco asked for it is not Claude Code's own doing.
    expect(
      summarize({ fast: false, activities: [report({ state: "on", requested: true })] })
        ?.speedNotice,
    ).toBeUndefined();
  });

  it("leaves the summary alone when the report agrees, is missing, or is not Claude's", () => {
    const serving = summarize({ fast: true, activities: [report({ state: "on" })] });
    expect(serving).toEqual({ level: null, speed: "fast", contextWindowLabel: null });
    expect(summarize({ fast: true })?.speedNotice).toBeUndefined();
    // Only Claude threads read the report, so another driver never shows it.
    expect(
      summarize({ provider: PROVIDER, fast: true, activities: [report({ state: "cooldown" })] })
        ?.speedNotice,
    ).toBeUndefined();
  });
});
