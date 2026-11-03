import { type ModelSelection, ProviderInstanceId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { modelSelectionChangeRestartsSession } from "../provider/sessionModelRestart.ts";
import { implicitTurnModelSelection } from "./implicitTurnModelSelection.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const selection = (
  options?: ModelSelection["options"],
  model = "claude-opus-4-6",
  instanceId = claude,
): ModelSelection => ({ instanceId, model, ...(options !== undefined ? { options } : {}) });

describe("implicitTurnModelSelection", () => {
  const implicit = (
    applied: ModelSelection | undefined,
    stored: ModelSelection,
    overrides: {
      readonly driver?: string;
      readonly sessionModelSwitch?: "in-session" | "unsupported";
      readonly hasLiveBackgroundWork?: boolean;
    } = {},
  ) =>
    implicitTurnModelSelection({
      driver: overrides.driver ?? "claudeAgent",
      sessionModelSwitch: overrides.sessionModelSwitch ?? "in-session",
      applied,
      stored,
      hasLiveBackgroundWork: overrides.hasLiveBackgroundWork ?? false,
      changeRestartsSession: modelSelectionChangeRestartsSession,
    });

  it("runs on the pick stored since the session applied its last selection", () => {
    const picked = selection([{ id: "effort", value: "max" }]);
    expect(implicit(selection(), picked)).toEqual(picked);
    expect(implicit(selection(), selection(undefined, "claude-sonnet-4-6"))).toEqual(
      selection(undefined, "claude-sonnet-4-6"),
    );
  });

  it("keeps what the session runs when nothing was stored since, or nothing is known", () => {
    expect(implicit(selection(), selection())).toBeUndefined();
    expect(implicit(undefined, selection())).toBeUndefined();
  });

  it("leaves a pick of another instance to the send that hands off", () => {
    const other = selection(undefined, "claude-opus-4-6", ProviderInstanceId.make("claude_work"));
    expect(implicit(selection(), other)).toBeUndefined();
  });

  it("never asks a session that cannot switch models for another model", () => {
    const codex = ProviderInstanceId.make("acp");
    const applied = selection(undefined, "model-a", codex);
    expect(
      implicit(applied, selection(undefined, "model-b", codex), {
        driver: "acp",
        sessionModelSwitch: "unsupported",
      }),
    ).toBeUndefined();
    const options = selection([{ id: "effort", value: "low" }], "model-a", codex);
    expect(
      implicit(applied, options, { driver: "acp", sessionModelSwitch: "unsupported" }),
    ).toEqual(options);
  });

  it("does not restart a Claude session that still runs background work, which no one was asked to end", () => {
    const busy = { hasLiveBackgroundWork: true };
    expect(implicit(selection(), selection(undefined, "claude-sonnet-4-6"), busy)).toBeUndefined();
    expect(
      implicit(selection(), selection([{ id: "effort", value: "low" }]), busy),
    ).toBeUndefined();
    // Fast mode switches in the live session, and other drivers switch in-session too.
    const fast = selection([{ id: "fastMode", value: true }]);
    expect(implicit(selection(), fast, busy)).toEqual(fast);
    const codex = ProviderInstanceId.make("codex");
    const codexPick = selection(undefined, "gpt-5.1-codex", codex);
    expect(
      implicit(selection(undefined, "gpt-5-codex", codex), codexPick, { ...busy, driver: "codex" }),
    ).toEqual(codexPick);
  });
});
