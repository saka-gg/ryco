import "../../index.css";

import { ProviderDriverKind } from "@ryco/contracts";
import { createModelCapabilities } from "@ryco/shared/model";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { TraitsChips } from "./TraitsChips";

const provider = ProviderDriverKind.make("claudeAgent");

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
) {
  return {
    id,
    label,
    type: "select" as const,
    options: [...options],
  };
}

function booleanDescriptor(id: string, label: string) {
  return { id, label, type: "boolean" as const };
}

function modelWith(
  optionDescriptors: ReadonlyArray<
    ReturnType<typeof selectDescriptor> | ReturnType<typeof booleanDescriptor>
  >,
) {
  return {
    slug: "test-model",
    name: "Test Model",
    isCustom: false,
    capabilities: createModelCapabilities({ optionDescriptors: [...optionDescriptors] }),
  };
}

describe("TraitsChips", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  afterEach(async () => {
    if (mounted) {
      const teardown = mounted.cleanup ?? mounted.unmount;
      await teardown?.call(mounted).catch(() => {});
    }
    mounted = null;
    document.body.innerHTML = "";
  });

  it("hides the agent chip while keeping other OpenCode options available", async () => {
    mounted = await render(
      <TraitsChips
        provider={ProviderDriverKind.make("opencode")}
        hideAgent
        model="test-model"
        models={[
          modelWith([
            selectDescriptor("agent", "Agent", [
              { id: "build", label: "Build", isDefault: true },
              { id: "plan", label: "Plan" },
            ]),
            selectDescriptor("variant", "Variant", [
              { id: "high", label: "High", isDefault: true },
            ]),
          ]),
        ]}
        modelOptions={[{ id: "agent", value: "plan" }]}
        onModelOptionsChange={() => {}}
      />,
    );
    await expect.element(page.getByRole("button", { name: /agent/i })).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: /variant/i })).toBeInTheDocument();
  });

  it("renders nothing when every option belongs to the model picker's tuning dial", async () => {
    mounted = await render(
      <TraitsChips
        provider={provider}
        model="test-model"
        models={[
          modelWith([
            selectDescriptor("effort", "Reasoning", [
              { id: "low", label: "Low" },
              { id: "high", label: "High", isDefault: true },
            ]),
            booleanDescriptor("fastMode", "Fast Mode"),
            selectDescriptor("contextWindow", "Context Window", [
              { id: "200k", label: "200k", isDefault: true },
              { id: "1m", label: "1M" },
            ]),
            booleanDescriptor("thinking", "Thinking"),
          ]),
        ]}
        modelOptions={undefined}
        onModelOptionsChange={() => {}}
      />,
    );
    expect(document.querySelector("button")).toBeNull();
  });

  it("renders agent and variant chips beside dial-owned options", async () => {
    mounted = await render(
      <TraitsChips
        provider={provider}
        model="test-model"
        models={[
          modelWith([
            selectDescriptor("effort", "Reasoning", [
              { id: "high", label: "High", isDefault: true },
            ]),
            selectDescriptor("variant", "Variant", [
              { id: "small", label: "Small" },
              { id: "large", label: "Large", isDefault: true },
            ]),
            selectDescriptor("agent", "Agent", [{ id: "build", label: "Build", isDefault: true }]),
          ]),
        ]}
        modelOptions={undefined}
        onModelOptionsChange={() => {}}
      />,
    );
    await expect.element(page.getByRole("button", { name: /variant/i })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: /agent/i })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: /reasoning/i })).not.toBeInTheDocument();
  });

  it("keeps dial-owned selections when an agent is chosen", async () => {
    const onModelOptionsChange = vi.fn();
    mounted = await render(
      <TraitsChips
        provider={ProviderDriverKind.make("opencode")}
        model="test-model"
        models={[
          modelWith([
            selectDescriptor("effort", "Reasoning", [
              { id: "low", label: "Low" },
              { id: "high", label: "High", isDefault: true },
            ]),
            selectDescriptor("agent", "Agent", [
              { id: "build", label: "Build", isDefault: true },
              { id: "plan", label: "Plan" },
            ]),
          ]),
        ]}
        modelOptions={[{ id: "effort", value: "low" }]}
        onModelOptionsChange={onModelOptionsChange}
      />,
    );
    await page.getByRole("button", { name: /agent/i }).click();
    await page.getByRole("menuitemradio", { name: "Plan" }).click();
    await vi.waitFor(() => {
      expect(onModelOptionsChange).toHaveBeenCalledWith([
        { id: "effort", value: "low" },
        { id: "agent", value: "plan" },
      ]);
    });
  });
});
