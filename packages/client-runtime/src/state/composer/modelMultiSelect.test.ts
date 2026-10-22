import { ProviderInstanceId } from "@ryco/contracts";
import { createModelSelection } from "@ryco/shared/model";
import { describe, expect, it } from "vite-plus/test";

import {
  MODEL_MULTI_SELECT_OFF,
  MULTI_MODEL_SEND_MAX_TARGETS,
  disableModelMultiSelect,
  enableModelMultiSelect,
  isModelMultiSelected,
  modelMultiSelectMinimum,
  modelMultiSelectSendBlockReason,
  pruneModelMultiSelect,
  resolveModelMultiSelectTargets,
  retryModelMultiSelect,
  toggleModelMultiSelect,
} from "./modelMultiSelect.ts";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const active = createModelSelection(codex, "gpt-5", [{ id: "reasoningEffort", value: "high" }]);
const opus = createModelSelection(claude, "claude-opus-4-6");
const sonnet = createModelSelection(claude, "claude-sonnet-4-6");
const haiku = createModelSelection(claude, "claude-haiku-4-5");
const mini = createModelSelection(codex, "gpt-5-mini");

describe("model multi-select", () => {
  it("starts from the composer's model when Compare models is turned on", () => {
    const state = enableModelMultiSelect(MODEL_MULTI_SELECT_OFF, active);
    expect(state).toEqual({ enabled: true, selections: [active] });
    expect(enableModelMultiSelect(state, opus)).toBe(state);
    expect(disableModelMultiSelect()).toEqual(MODEL_MULTI_SELECT_OFF);
  });

  it("turns on with the composer's model and the target on a Shift-click", () => {
    const result = toggleModelMultiSelect(MODEL_MULTI_SELECT_OFF, { active, target: opus });
    expect(result).toEqual({
      state: { enabled: true, selections: [active, opus] },
      refused: false,
    });
    expect(isModelMultiSelected(result.state, claude, "claude-opus-4-6")).toBe(true);
    expect(isModelMultiSelected(MODEL_MULTI_SELECT_OFF, codex, "gpt-5")).toBe(false);
  });

  it("only turns the mode on when the composer's own model is Shift-clicked", () => {
    const result = toggleModelMultiSelect(MODEL_MULTI_SELECT_OFF, { active, target: active });
    expect(result.state).toEqual({ enabled: true, selections: [active] });
  });

  it("removes a chosen model and keeps the mode on when the last one goes", () => {
    let state = toggleModelMultiSelect(MODEL_MULTI_SELECT_OFF, { active, target: opus }).state;
    state = toggleModelMultiSelect(state, { active, target: active }).state;
    expect(state.selections).toEqual([opus]);
    // Identity is instance and model: other options still name the same target.
    state = toggleModelMultiSelect(state, {
      active,
      target: createModelSelection(claude, "claude-opus-4-6", [{ id: "effort", value: "max" }]),
    }).state;
    expect(state).toEqual({ enabled: true, selections: [] });
  });

  it("refuses a model past the cap without dropping an earlier one", () => {
    let state = enableModelMultiSelect(MODEL_MULTI_SELECT_OFF, active);
    for (const target of [opus, sonnet, haiku]) {
      state = toggleModelMultiSelect(state, { active, target }).state;
    }
    expect(state.selections).toHaveLength(MULTI_MODEL_SEND_MAX_TARGETS);
    const full = toggleModelMultiSelect(state, { active, target: mini });
    expect(full).toEqual({ state, refused: true });
    // Removing still works at the cap.
    expect(toggleModelMultiSelect(state, { active, target: opus }).state.selections).toEqual([
      active,
      sonnet,
      haiku,
    ]);
    expect(toggleModelMultiSelect(state, { active, target: mini, max: 5 }).refused).toBe(false);
  });

  it("sends the composer's model with its live options", () => {
    const state = toggleModelMultiSelect(MODEL_MULTI_SELECT_OFF, {
      active: createModelSelection(codex, "gpt-5"),
      target: opus,
    }).state;
    expect(resolveModelMultiSelectTargets(state, active)).toEqual([active, opus]);
    expect(resolveModelMultiSelectTargets(MODEL_MULTI_SELECT_OFF, active)).toBeNull();
  });

  it("blocks a compare send until two models are chosen", () => {
    expect(modelMultiSelectSendBlockReason(MODEL_MULTI_SELECT_OFF)).toBeNull();
    const one = enableModelMultiSelect(MODEL_MULTI_SELECT_OFF, active);
    expect(modelMultiSelectSendBlockReason(one)).toBe("Choose at least two models to compare.");
    const two = toggleModelMultiSelect(one, { active, target: opus }).state;
    expect(modelMultiSelectSendBlockReason(two)).toBeNull();
    expect(modelMultiSelectSendBlockReason(two, 1)).toBe("Choose at most 1 models to compare.");
  });

  it("lets one model go out when it retries what an earlier send did not create", () => {
    const retry = retryModelMultiSelect([opus, createModelSelection(claude, opus.model)]);
    expect(retry).toEqual({ enabled: true, selections: [opus], retry: true });
    expect(modelMultiSelectSendBlockReason(retry)).toBeNull();
    expect(modelMultiSelectMinimum(retry)).toBe(1);
    expect(resolveModelMultiSelectTargets(retry, active)).toEqual([opus]);
    // It stays a retry while the user changes the selection, until compare is off.
    const added = toggleModelMultiSelect(retry, { active, target: sonnet }).state;
    expect(added).toEqual({ enabled: true, selections: [opus, sonnet], retry: true });
    const removed = toggleModelMultiSelect(added, { active, target: opus }).state;
    expect(modelMultiSelectSendBlockReason(removed)).toBeNull();
    expect(pruneModelMultiSelect(removed, (selection) => selection.model !== sonnet.model)).toEqual(
      { enabled: true, selections: [], retry: true },
    );
    expect(modelMultiSelectSendBlockReason({ enabled: true, selections: [], retry: true })).toBe(
      "Choose a model to send to.",
    );
    const fresh = enableModelMultiSelect(disableModelMultiSelect(), active);
    expect(fresh).toEqual({ enabled: true, selections: [active] });
    expect(modelMultiSelectSendBlockReason(fresh)).toBe("Choose at least two models to compare.");
    expect(modelMultiSelectMinimum(fresh)).toBe(2);
    expect(retryModelMultiSelect([])).toBe(MODEL_MULTI_SELECT_OFF);
  });

  it("drops models that left the catalog and keeps the same value otherwise", () => {
    const state = toggleModelMultiSelect(MODEL_MULTI_SELECT_OFF, { active, target: opus }).state;
    expect(pruneModelMultiSelect(state, () => true)).toBe(state);
    expect(pruneModelMultiSelect(state, (selection) => selection.instanceId === codex)).toEqual({
      enabled: true,
      selections: [active],
    });
    expect(pruneModelMultiSelect(MODEL_MULTI_SELECT_OFF, () => false)).toBe(MODEL_MULTI_SELECT_OFF);
  });
});
