import { expect, it } from "vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@ryco/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@ryco/contracts/settings";
import { deriveEffectiveComposerModelState } from "./draftStore.ts";

it("ignores legacy project model and reasoning options while retaining thread choices", () => {
  const input = {
    draft: null,
    providers: [],
    selectedProvider: ProviderDriverKind.make("codex"),
    threadModelSelection: null,
    settings: DEFAULT_UNIFIED_SETTINGS,
  };
  const legacy = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.5",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  expect(deriveEffectiveComposerModelState({ ...input, projectModelSelection: legacy })).toEqual(
    deriveEffectiveComposerModelState(input),
  );
  const thread = { ...legacy, options: [{ id: "reasoningEffort", value: "low" }] };
  expect(
    deriveEffectiveComposerModelState({
      ...input,
      threadModelSelection: thread,
      projectModelSelection: legacy,
    }),
  ).toEqual(deriveEffectiveComposerModelState({ ...input, threadModelSelection: thread }));
  expect(
    deriveEffectiveComposerModelState({ ...input, threadModelSelection: thread }).modelOptions,
  ).not.toBeNull();
});
