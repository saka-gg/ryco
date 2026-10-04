import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_CONTROL_REQUEST_TIMEOUT_MS,
  DEFAULT_REGISTRY_SESSION_START_TIMEOUT_MS,
  DEFAULT_SESSION_START_TIMEOUT_MS,
  DEFAULT_TURN_ACCEPTANCE_TIMEOUT_MS,
  DEFAULT_UNRESPONSIVE_AFTER_MS,
  providerOperationTimeoutDetail,
  resolveProviderOperationTimeouts,
} from "./providerOperationPolicy.ts";

describe("resolveProviderOperationTimeouts", () => {
  it("uses the defaults, with a longer start deadline for the ACP registry", () => {
    const timeouts = resolveProviderOperationTimeouts({ env: {} });
    expect(timeouts.sessionStartMs("codex")).toBe(DEFAULT_SESSION_START_TIMEOUT_MS);
    expect(timeouts.sessionStartMs("claudeAgent")).toBe(DEFAULT_SESSION_START_TIMEOUT_MS);
    expect(timeouts.sessionStartMs("acpRegistry")).toBe(DEFAULT_REGISTRY_SESSION_START_TIMEOUT_MS);
    expect(timeouts.turnAcceptanceMs).toBe(DEFAULT_TURN_ACCEPTANCE_TIMEOUT_MS);
    expect(timeouts.controlRequestMs).toBe(DEFAULT_CONTROL_REQUEST_TIMEOUT_MS);
    expect(timeouts.unresponsiveAfterMs).toBe(DEFAULT_UNRESPONSIVE_AFTER_MS);
    expect(timeouts.invalidEnv).toEqual([]);
  });

  it("applies every environment override, the start deadline to all drivers", () => {
    const timeouts = resolveProviderOperationTimeouts({
      env: {
        RYCO_PROVIDER_SESSION_START_TIMEOUT_MS: "45000",
        RYCO_PROVIDER_TURN_ACCEPT_TIMEOUT_MS: "12000",
        RYCO_PROVIDER_CONTROL_TIMEOUT_MS: "7000",
        RYCO_PROVIDER_UNRESPONSIVE_AFTER_MS: "600000",
      },
    });
    expect(timeouts.sessionStartMs("codex")).toBe(45_000);
    expect(timeouts.sessionStartMs("acpRegistry")).toBe(45_000);
    expect(timeouts.turnAcceptanceMs).toBe(12_000);
    expect(timeouts.controlRequestMs).toBe(7_000);
    expect(timeouts.unresponsiveAfterMs).toBe(600_000);
  });

  it("prefers explicit overrides over the environment", () => {
    const timeouts = resolveProviderOperationTimeouts({
      env: {
        RYCO_PROVIDER_SESSION_START_TIMEOUT_MS: "45000",
        RYCO_PROVIDER_CONTROL_TIMEOUT_MS: "7000",
      },
      overrides: { sessionStartMs: 10, controlRequestMs: 20, turnAcceptanceMs: 30 },
    });
    expect(timeouts.sessionStartMs("acpRegistry")).toBe(10);
    expect(timeouts.controlRequestMs).toBe(20);
    expect(timeouts.turnAcceptanceMs).toBe(30);
  });

  it("ignores and reports invalid environment values", () => {
    const timeouts = resolveProviderOperationTimeouts({
      env: {
        RYCO_PROVIDER_SESSION_START_TIMEOUT_MS: "0",
        RYCO_PROVIDER_TURN_ACCEPT_TIMEOUT_MS: "abc",
        RYCO_PROVIDER_CONTROL_TIMEOUT_MS: "-5",
        RYCO_PROVIDER_UNRESPONSIVE_AFTER_MS: "1.5",
      },
    });
    expect(timeouts.sessionStartMs("codex")).toBe(DEFAULT_SESSION_START_TIMEOUT_MS);
    expect(timeouts.turnAcceptanceMs).toBe(DEFAULT_TURN_ACCEPTANCE_TIMEOUT_MS);
    expect(timeouts.controlRequestMs).toBe(DEFAULT_CONTROL_REQUEST_TIMEOUT_MS);
    expect(timeouts.unresponsiveAfterMs).toBe(DEFAULT_UNRESPONSIVE_AFTER_MS);
    expect(new Set(timeouts.invalidEnv)).toEqual(
      new Set([
        "RYCO_PROVIDER_CONTROL_TIMEOUT_MS",
        "RYCO_PROVIDER_SESSION_START_TIMEOUT_MS",
        "RYCO_PROVIDER_TURN_ACCEPT_TIMEOUT_MS",
        "RYCO_PROVIDER_UNRESPONSIVE_AFTER_MS",
      ]),
    );
  });
});

describe("providerOperationTimeoutDetail", () => {
  it("names the start phase that was still waiting", () => {
    const base = { operation: "session.start" as const, label: "Codex", timeoutMs: 120_000 };
    expect(providerOperationTimeoutDetail({ ...base, startPhase: "adapter" })).toBe(
      "Provider 'Codex' did not finish starting within 120s. Ryco stopped waiting; send the message again to retry.",
    );
    expect(providerOperationTimeoutDetail({ ...base, startPhase: "lock" })).toBe(
      "Provider 'Codex' could not start because a previous start for this thread is still shutting down (waited 120s). Try again shortly.",
    );
    expect(providerOperationTimeoutDetail({ ...base, startPhase: "admission" })).toBe(
      "Provider 'Codex' is busy starting other sessions (waited 120s). Try again shortly.",
    );
  });

  it("renders every other operation as one sentence", () => {
    const detail = (operation: Parameters<typeof providerOperationTimeoutDetail>[0]["operation"]) =>
      providerOperationTimeoutDetail({ operation, label: "cursor", timeoutMs: 30_000 });
    expect(detail("session.recover")).toBe(
      "Provider 'cursor' did not resume this thread within 30s.",
    );
    expect(detail("turn.start")).toBe(
      "Provider 'cursor' did not accept the turn within 30s. Ryco cancelled the request; send it again to retry.",
    );
    expect(detail("turn.interrupt")).toBe(
      "Provider 'cursor' did not respond to the interrupt within 30s.",
    );
    expect(detail("session.stop")).toBe(
      "Provider 'cursor' did not confirm the stop within 30s. Ryco will keep trying to stop it in the background.",
    );
    expect(detail("request.respond")).toBe(
      "Provider 'cursor' did not acknowledge the response within 30s; it may or may not have been delivered.",
    );
    expect(detail("goal.sync")).toBe(
      "Provider 'cursor' did not confirm the goal change within 30s.",
    );
    expect(
      providerOperationTimeoutDetail({ operation: "turn.start", label: "x", timeoutMs: 1_500 }),
    ).toContain("within 1.5s");
  });
});
