import "../../index.css";

import type { FastModeNotice } from "@ryco/client-runtime/state/session";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { ModelTriggerTraits } from "./ModelTriggerTraits";
import type { ModelTuningSummary } from "./modelTuning.logic";

const COOLDOWN: FastModeNotice = {
  kind: "cooldown",
  label: "Fast paused",
  detail: "A rate limit paused Fast mode for now.",
};
const BLOCKED: FastModeNotice = {
  kind: "blocked",
  label: "Fast unavailable",
  detail: "Claude Code only serves Fast mode on a direct Anthropic connection.",
};
const EXTERNAL: FastModeNotice = {
  kind: "external",
  label: "Fast on",
  detail: "Claude Code's own settings turned Fast mode on.",
};

function summary(input: Partial<ModelTuningSummary>): ModelTuningSummary {
  return {
    level: { id: "high", label: "High", index: 2 },
    speed: "fast",
    contextWindowLabel: null,
    ...input,
  };
}

function traitsElement(): HTMLElement {
  const traits = document.querySelector<HTMLElement>('[data-slot="model-trigger-traits"]');
  if (!traits) throw new Error("Expected the model trigger traits to render.");
  return traits;
}

describe("ModelTriggerTraits", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
  });

  it("fills the bolt while Fast is on and nothing contradicts it", async () => {
    mounted = await render(<ModelTriggerTraits summary={summary({})} />);

    const traits = traitsElement();
    expect(traits.querySelector("[data-fast-mode-notice]")).toBeNull();
    const bolt = traits.querySelector("svg");
    expect(bolt?.classList.contains("fill-current")).toBe(true);
  });

  it.each([
    ["cooldown", COOLDOWN],
    ["blocked", BLOCKED],
  ] as const)("draws a muted outline bolt that names the %s notice", async (kind, notice) => {
    mounted = await render(
      <ModelTriggerTraits summary={summary({ speed: "fast", speedNotice: notice })} />,
    );

    const badge = page.getByRole("img", { name: `${notice.label}. ${notice.detail}` });
    await expect.element(badge).toBeInTheDocument();
    await expect.element(badge).toHaveAttribute("data-fast-mode-notice", kind);
    await expect.element(badge).toHaveAttribute("title", `${notice.label}. ${notice.detail}`);
    await expect.element(badge).toHaveClass("text-muted-foreground");
    const bolt = traitsElement().querySelector("svg");
    expect(bolt?.classList.contains("fill-current")).toBe(false);
    // The pill is tight: the notice adds no text beside the level.
    expect(traitsElement().textContent).toBe("High");
  });

  it("shows an outline bolt in the Fast tone when Claude Code's settings turned Fast on", async () => {
    mounted = await render(
      <ModelTriggerTraits
        summary={summary({ level: null, speed: "standard", speedNotice: EXTERNAL })}
      />,
    );

    const badge = page.getByRole("img", { name: `${EXTERNAL.label}. ${EXTERNAL.detail}` });
    await expect.element(badge).toHaveAttribute("data-fast-mode-notice", "external");
    await expect.element(badge).toHaveClass("text-(--fast-mode-tone)");
    const bolt = traitsElement().querySelector("svg");
    expect(bolt?.classList.contains("fill-current")).toBe(false);
  });

  it("renders nothing for Standard without a notice, level or context", async () => {
    mounted = await render(
      <ModelTriggerTraits summary={summary({ level: null, speed: "standard" })} />,
    );

    expect(document.querySelector('[data-slot="model-trigger-traits"]')).toBeNull();
  });
});
