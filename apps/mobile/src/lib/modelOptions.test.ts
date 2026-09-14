import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ServerConfig } from "@ryco/contracts";

import { buildModelOptions } from "./modelOptions";

describe("mobile model options", () => {
  it.each([true, false])("preserves Fast mode %s only on models that support it", (enabled) => {
    const reasoning = {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "low", label: "Low", isDefault: true }],
    };
    const fast = { id: "fastMode", label: "Fast Mode", type: "boolean", currentValue: !enabled };
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            { slug: "current", name: "Current", capabilities: { optionDescriptors: [fast] } },
            {
              slug: "supported",
              name: "Supported",
              capabilities: { optionDescriptors: [reasoning, fast] },
            },
            {
              slug: "unsupported",
              name: "Unsupported",
              capabilities: { optionDescriptors: [reasoning] },
            },
            { slug: "unknown", name: "Unknown", capabilities: null },
          ],
        },
      ],
    } as unknown as ServerConfig;
    const options = buildModelOptions(config, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "current",
      options: [{ id: "fastMode", value: enabled }],
    });
    const supported = options.find((option) => option.selection.model === "supported");
    expect(supported?.selection.options).toEqual([
      { id: "reasoningEffort", value: "low" },
      { id: "fastMode", value: enabled },
    ]);
    expect(
      options.find((option) => option.selection.model === "unsupported")?.selection.options,
    ).toEqual([{ id: "reasoningEffort", value: "low" }]);
    expect(
      options.find((option) => option.selection.model === "unknown")?.selection.options,
    ).toBeUndefined();

    // A subsequent switch carries the chosen state forward too.
    const switched = buildModelOptions(config, supported!.selection);
    expect(
      switched.find((option) => option.selection.model === "current")?.selection.options,
    ).toEqual([{ id: "fastMode", value: enabled }]);
  });

  it("normalizes a legacy fallback selection against current capabilities", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-test",
              name: "GPT Test",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "serviceTier",
                    label: "Service Tier",
                    type: "select",
                    options: [
                      { id: "default", label: "Standard", isDefault: true },
                      { id: "priority", label: "Fast" },
                    ],
                    currentValue: "default",
                  },
                ],
              },
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const [option] = buildModelOptions(config, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-test",
      options: [{ id: "fastMode", value: true }],
    });

    expect(option?.capabilities?.optionDescriptors?.[0]?.id).toBe("serviceTier");
    expect(option?.selection.options).toEqual([{ id: "serviceTier", value: "default" }]);
  });
});
