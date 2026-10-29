import { EventId, TurnId, type OrchestrationThreadActivity } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveClaudeFastModeNotice } from "./fastModeNotice.ts";

const INSTANCE = "claude-hub";
const MODEL = "claude-opus-4-8";

let nextId = 0;
function fastModeActivity(payload: Record<string, unknown>): OrchestrationThreadActivity {
  nextId += 1;
  return {
    id: EventId.make(`claude-fast-mode:thread-1:state-${nextId}`),
    kind: "fast-mode.state",
    tone: "info",
    summary: "Fast mode state",
    payload: { instanceId: INSTANCE, model: MODEL, ...payload },
    turnId: null,
    createdAt: "2026-10-28T00:00:00.000Z",
  };
}

function otherActivity(): OrchestrationThreadActivity {
  return {
    id: EventId.make("tool-1"),
    kind: "tool.completed",
    tone: "tool",
    summary: "Ran command",
    payload: { state: "on" },
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-10-28T00:00:01.000Z",
  };
}

const derive = (
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  overrides: Partial<Parameters<typeof deriveClaudeFastModeNotice>[0]> = {},
) =>
  deriveClaudeFastModeNotice({
    activities,
    instanceId: INSTANCE,
    model: MODEL,
    fastRequested: true,
    ...overrides,
  });

describe("deriveClaudeFastModeNotice", () => {
  it("stays silent without a report or while the report matches the request", () => {
    expect(derive([])).toBeNull();
    expect(derive([otherActivity()])).toBeNull();
    expect(derive([fastModeActivity({ state: "on" })])).toBeNull();
    expect(derive([fastModeActivity({ state: "off" })], { fastRequested: false })).toBeNull();
  });

  it("says when a rate limit paused the requested fast mode", () => {
    expect(derive([fastModeActivity({ state: "cooldown" })])).toEqual({
      kind: "cooldown",
      label: "Fast paused",
      detail: "A rate limit paused Fast mode for now.",
    });
  });

  it("explains why Claude Code refused the requested fast mode", () => {
    expect(derive([fastModeActivity({ state: "off", disabledReason: "not_first_party" })])).toEqual(
      {
        kind: "blocked",
        label: "Fast unavailable",
        detail: "Claude Code only serves Fast mode on a direct Anthropic connection.",
      },
    );
    expect(
      derive([fastModeActivity({ state: "off", disabledReason: "extra_usage_disabled" })])?.detail,
    ).toBe("Usage credits are off for this Claude account.");
    // An unknown reason, one that names an Object.prototype member included.
    for (const disabledReason of ["something_new", "constructor", "unknown"]) {
      expect(derive([fastModeActivity({ state: "off", disabledReason })])?.detail).toBe(
        "Claude Code reports Fast mode as unavailable.",
      );
    }
  });

  it("does not read a not-yet-requested fast mode as refused", () => {
    for (const disabledReason of ["preference", "sdk_opt_in_required", "pending", undefined]) {
      expect(derive([fastModeActivity({ state: "off", disabledReason })])).toBeNull();
    }
  });

  it("says when Claude Code's own settings turned fast mode on", () => {
    const external = {
      kind: "external",
      label: "Fast on",
      detail: "Claude Code's own settings turned Fast mode on.",
    };
    expect(
      derive([fastModeActivity({ state: "on", requested: false })], { fastRequested: false }),
    ).toEqual(external);
    // A report that does not say what its session requested.
    expect(derive([fastModeActivity({ state: "on" })], { fastRequested: false })).toEqual(external);
    expect(derive([fastModeActivity({ state: "cooldown" })], { fastRequested: false })).toBeNull();
    expect(
      derive([fastModeActivity({ state: "off", disabledReason: "free" })], {
        fastRequested: false,
      }),
    ).toBeNull();
  });

  it("keeps quiet after fast mode is turned off until the next session reports", () => {
    // The session served the Fast mode Ryco asked for; the composer now asks for Standard, and
    // the restarted session reports only when the next message starts it.
    const requestedAndServing = [fastModeActivity({ state: "on", requested: true })];
    expect(derive(requestedAndServing, { fastRequested: false })).toBeNull();
    expect(derive(requestedAndServing)).toBeNull();
    // Turning fast mode on still says in advance that Claude Code will not serve it.
    const blocked = { state: "off", disabledReason: "not_first_party", requested: false };
    expect(derive([fastModeActivity(blocked)])?.kind).toBe("blocked");
    expect(derive([fastModeActivity({ state: "cooldown", requested: false })])?.kind).toBe(
      "cooldown",
    );
  });

  it("ignores a report from another instance or model", () => {
    const blocked = [fastModeActivity({ state: "off", disabledReason: "free" })];
    expect(derive(blocked, { instanceId: "claude-direct" })).toBeNull();
    expect(derive(blocked, { instanceId: null })).toBeNull();
    expect(derive(blocked, { model: "claude-opus-4-7" })).toBeNull();
    expect(derive(blocked, { model: undefined })).toBeNull();
    // A report without the fields cannot contradict the selection.
    expect(
      derive([
        {
          ...fastModeActivity({ state: "cooldown" }),
          payload: { state: "cooldown" },
        },
      ])?.kind,
    ).toBe("cooldown");
  });

  it("follows the newest report", () => {
    const blocked = fastModeActivity({ state: "off", disabledReason: "free" });
    const cooldown = fastModeActivity({ state: "cooldown" });
    const serving = fastModeActivity({ state: "on" });
    expect(derive([blocked, otherActivity(), cooldown, otherActivity()])?.kind).toBe("cooldown");
    expect(derive([cooldown, blocked])?.kind).toBe("blocked");
    expect(derive([blocked, cooldown, serving])).toBeNull();
    // An older report from another instance never shows through a newer matching one.
    expect(
      derive([fastModeActivity({ state: "cooldown" }), fastModeActivity({ state: "on" })]),
    ).toBeNull();
    expect(
      derive([
        fastModeActivity({ state: "cooldown" }),
        fastModeActivity({ state: "on", instanceId: "claude-direct" }),
      ]),
    ).toBeNull();
  });

  it("stays silent for a malformed newest report", () => {
    expect(
      derive([
        fastModeActivity({ state: "cooldown" }),
        { ...fastModeActivity({ state: "on" }), payload: null },
      ]),
    ).toBeNull();
    expect(derive([fastModeActivity({ state: "turbo" })])).toBeNull();
  });
});
