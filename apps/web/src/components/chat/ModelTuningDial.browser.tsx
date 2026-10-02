import "../../index.css";

import { ProviderDriverKind, type ProviderOptionSelection } from "@ryco/contracts";
import { createModelCapabilities } from "@ryco/shared/model";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { ComposerModelTuning } from "./ModelTuningDial";

const provider = ProviderDriverKind.make("claudeAgent");

const EFFORT = {
  id: "effort",
  label: "Reasoning",
  type: "select" as const,
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High", isDefault: true },
    { id: "xhigh", label: "Extra High" },
    { id: "max", label: "Max" },
    { id: "ultracode", label: "Ultracode" },
  ],
};
const FAST = { id: "fastMode", label: "Fast Mode", type: "boolean" as const };
const CONTEXT = {
  id: "contextWindow",
  label: "Context Window",
  type: "select" as const,
  options: [
    { id: "200k", label: "200k" },
    { id: "1m", label: "1M", isDefault: true },
  ],
};
const AGENT = {
  id: "agent",
  label: "Agent",
  type: "select" as const,
  options: [
    { id: "build", label: "Build", isDefault: true },
    { id: "plan", label: "Plan" },
  ],
};

function modelWith(
  optionDescriptors: Parameters<typeof createModelCapabilities>[0]["optionDescriptors"],
) {
  return {
    slug: "test-model",
    name: "Test Model",
    isCustom: false,
    capabilities: createModelCapabilities({ optionDescriptors }),
  };
}

async function mountDial(input: {
  descriptors: Parameters<typeof createModelCapabilities>[0]["optionDescriptors"];
  modelOptions?: ReadonlyArray<ProviderOptionSelection>;
  prompt?: string;
  disabled?: boolean;
}) {
  const onModelOptionsChange = vi.fn();
  const onPromptChange = vi.fn();
  const screen = await render(
    <ComposerModelTuning
      provider={provider}
      model="test-model"
      models={[modelWith(input.descriptors)]}
      modelOptions={input.modelOptions}
      prompt={input.prompt ?? ""}
      onPromptChange={onPromptChange}
      onModelOptionsChange={onModelOptionsChange}
      {...(input.disabled ? { disabled: true } : {})}
    />,
  );
  return { screen, onModelOptionsChange, onPromptChange };
}

function focusSlider(name: string) {
  (page.getByRole("slider", { name }).element() as HTMLElement).focus();
}

describe("ComposerModelTuning", () => {
  let mounted: Awaited<ReturnType<typeof mountDial>> | null = null;

  afterEach(async () => {
    await mounted?.screen.unmount();
    mounted = null;
    document.body.innerHTML = "";
  });

  it("renders the current effort as a slider value with its tone", async () => {
    mounted = await mountDial({ descriptors: [EFFORT, FAST, CONTEXT] });
    const slider = page.getByRole("slider", { name: "Reasoning effort" });
    await expect.element(slider).toHaveAttribute("aria-valuetext", "High");
    await expect.element(slider).toHaveAttribute("aria-valuenow", "2");
    expect(
      document
        .querySelector('[data-slot="model-tuning-dial"]')
        ?.getAttribute("data-reasoning-tone"),
    ).toBe("high");
  });

  it("steps effort with the arrow keys and jumps with End", async () => {
    mounted = await mountDial({ descriptors: [EFFORT] });
    focusSlider("Reasoning effort");
    await userEvent.keyboard("{ArrowLeft}");
    expect(mounted.onModelOptionsChange).toHaveBeenLastCalledWith([
      { id: "effort", value: "medium" },
    ]);
    await userEvent.keyboard("{End}");
    expect(mounted.onModelOptionsChange).toHaveBeenLastCalledWith([
      { id: "effort", value: "ultracode" },
    ]);
  });

  it("toggles fast mode and switches the context window", async () => {
    mounted = await mountDial({ descriptors: [EFFORT, FAST, CONTEXT] });
    await page.getByRole("button", { name: "Fast mode" }).click();
    expect(mounted.onModelOptionsChange).toHaveBeenLastCalledWith([
      { id: "effort", value: "high" },
      { id: "fastMode", value: true },
      { id: "contextWindow", value: "1m" },
    ]);
    await page.getByRole("radio", { name: "200k" }).click();
    expect(mounted.onModelOptionsChange).toHaveBeenLastCalledWith([
      { id: "effort", value: "high" },
      { id: "contextWindow", value: "200k" },
    ]);
  });

  it("enables reset only off-default and restores defaults without touching the agent", async () => {
    mounted = await mountDial({ descriptors: [EFFORT, FAST, AGENT] });
    await expect
      .element(page.getByRole("button", { name: "Reset to model defaults" }))
      .toBeDisabled();
    await mounted.screen.unmount();

    mounted = await mountDial({
      descriptors: [EFFORT, FAST, AGENT],
      modelOptions: [
        { id: "effort", value: "max" },
        { id: "fastMode", value: true },
        { id: "agent", value: "plan" },
      ],
    });
    const reset = page.getByRole("button", { name: "Reset to model defaults" });
    await expect.element(reset).toBeEnabled();
    await reset.click();
    expect(mounted.onModelOptionsChange).toHaveBeenLastCalledWith([
      { id: "effort", value: "high" },
      { id: "agent", value: "plan" },
    ]);
  });

  it("injects the ultrathink prefix through the prompt instead of an option", async () => {
    mounted = await mountDial({
      descriptors: [
        {
          ...EFFORT,
          options: [...EFFORT.options.slice(0, 3), { id: "ultrathink", label: "Ultrathink" }],
          promptInjectedValues: ["ultrathink"],
        },
      ],
      prompt: "fix the flake",
    });
    focusSlider("Reasoning effort");
    await userEvent.keyboard("{End}");
    expect(mounted.onPromptChange).toHaveBeenLastCalledWith("Ultrathink:\nfix the flake");
  });

  it("locks effort while the prompt body says ultrathink", async () => {
    mounted = await mountDial({
      descriptors: [
        {
          ...EFFORT,
          options: [...EFFORT.options.slice(0, 3), { id: "ultrathink", label: "Ultrathink" }],
          promptInjectedValues: ["ultrathink"],
        },
      ],
      prompt: "please ultrathink about this",
    });
    await expect
      .element(page.getByRole("slider", { name: "Reasoning effort" }))
      .toHaveAttribute("aria-disabled", "true");
    await expect.element(page.getByText(/Remove it to change effort/)).toBeInTheDocument();
  });

  it("uses a two-stop dial for thinking-only models", async () => {
    mounted = await mountDial({
      descriptors: [{ id: "thinking", label: "Thinking", type: "boolean" as const }],
      modelOptions: [{ id: "thinking", value: true }],
    });
    const slider = page.getByRole("slider", { name: "Thinking" });
    await expect.element(slider).toHaveAttribute("aria-valuetext", "Thinking");
    focusSlider("Thinking");
    await userEvent.keyboard("{Home}");
    expect(mounted.onModelOptionsChange).toHaveBeenLastCalledWith([
      { id: "thinking", value: false },
    ]);
  });

  it("blocks every change while disabled", async () => {
    mounted = await mountDial({ descriptors: [EFFORT, FAST], disabled: true });
    await expect.element(page.getByRole("button", { name: "Fast mode" })).toBeDisabled();
    const slider = document.querySelector<HTMLElement>('[role="slider"]');
    slider?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(mounted.onModelOptionsChange).not.toHaveBeenCalled();
  });
});
