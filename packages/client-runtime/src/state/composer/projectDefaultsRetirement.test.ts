import { expect, it } from "vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@ryco/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@ryco/contracts/settings";
import { deriveEffectiveComposerModelState } from "./draftStore.ts";

it("retains the thread model selection and its options", () => {
  const input = {
    draft: null,
    providers: [],
    selectedProvider: ProviderDriverKind.make("codex"),
    threadModelSelection: null,
    settings: DEFAULT_UNIFIED_SETTINGS,
  };
  const base = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.5",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  const thread = { ...base, options: [{ id: "reasoningEffort", value: "low" }] };
  const state = deriveEffectiveComposerModelState({ ...input, threadModelSelection: thread });
  expect(state.modelOptions).not.toBeNull();
  expect(state).toEqual(
    deriveEffectiveComposerModelState({ ...input, threadModelSelection: thread }),
  );
});
