import { assert, describe, it } from "@effect/vitest";

import {
  collectStartupMeasures,
  DeterministicSourceControlDriver,
  sanitizeDiagnostic,
} from "./browserProbe.ts";

describe("app startup measures", () => {
  it("keeps the latest ryco:startup measure per name, without the prefix", () => {
    assert.deepStrictEqual(
      collectStartupMeasures([
        { name: "ryco:startup:root-before-load", duration: 12 },
        { name: "ryco:tab-switch:thread", duration: 40 },
        { name: "ryco:startup:primary-shell-painted", duration: 410 },
        { name: "ryco:startup:root-before-load", duration: 3 },
      ]),
      { "root-before-load": 3, "primary-shell-painted": 410 },
    );
  });
});

describe("external browser diagnostics", () => {
  it("removes query, hash, and credential values from errors", () => {
    const sanitized = sanitizeDiagnostic(
      "WebSocket wss://example.test/ws?wsToken=secret failed; Token: another-secret; https://example.test/pair#token=third",
    );
    assert.equal(
      sanitized,
      "WebSocket wss://example.test/ws?[redacted] failed; Token=[redacted] https://example.test/pair?[redacted]",
    );
    assert.notInclude(sanitized, "secret");
  });
});

describe("deterministic source-control browser driver", () => {
  const request = (id: string, tag: string, payload: Record<string, unknown> = {}) =>
    JSON.stringify({ _tag: "Request", id, tag, payload });

  it("forwards unrelated traffic and responds to source-control reads", () => {
    const driver = new DeterministicSourceControlDriver();
    assert.equal(driver.handle(request("1", "server.getConfig")), null);

    const response = JSON.parse(
      driver.handle(request("2", "sourceControl.listIssues", { cwd: "/fixture" })) ?? "{}",
    ) as { exit?: { value?: unknown }; requestId?: string };
    assert.equal(response.requestId, "2");
    assert.deepStrictEqual(response.exit?.value, []);
  });

  it("keeps discovery empty once, then publishes an active run and PR", () => {
    const driver = new DeterministicSourceControlDriver();
    driver.setPhase("discovery");
    const first = JSON.parse(
      driver.handle(
        request("1", "sourceControl.listWorkflowRuns", {
          cwd: "/fixture",
          commitSha: "abc123",
          limit: 20,
        }),
      ) ?? "{}",
    ) as { exit: { value: { runs: unknown[] } } };
    const second = JSON.parse(
      driver.handle(
        request("2", "sourceControl.listWorkflowRuns", {
          cwd: "/fixture",
          commitSha: "abc123",
          limit: 20,
        }),
      ) ?? "{}",
    ) as { exit: { value: { runs: unknown[] } } };
    const pullRequests = JSON.parse(
      driver.handle(
        request("3", "sourceControl.listChangeRequests", {
          cwd: "/fixture",
          state: "open",
          limit: 50,
        }),
      ) ?? "{}",
    ) as { exit: { value: unknown[] } };

    assert.lengthOf(first.exit.value.runs, 0);
    assert.lengthOf(second.exit.value.runs, 1);
    assert.lengthOf(pullRequests.exit.value, 1);
    assert.equal(driver.count("discovery", "workflow"), 2);
  });

  it("transitions detail and workflow fixtures to terminal states", () => {
    const driver = new DeterministicSourceControlDriver();
    driver.setPhase("settle-transition");
    driver.settle();
    const detail = JSON.parse(
      driver.handle(
        request("1", "sourceControl.getChangeRequestDetail", {
          cwd: "/fixture",
          reference: "1",
        }),
      ) ?? "{}",
    ) as { exit: { value: { state: string } } };
    const workflows = JSON.parse(
      driver.handle(
        request("2", "sourceControl.listWorkflowRuns", {
          cwd: "/fixture",
          pullRequestNumber: 1,
          limit: 20,
        }),
      ) ?? "{}",
    ) as { exit: { value: { runs: Array<{ status: string }> } } };

    assert.equal(detail.exit.value.state, "merged");
    assert.equal(workflows.exit.value.runs[0]?.status, "completed");
    assert.equal(driver.count("settle-transition", "detail"), 1);
    assert.equal(driver.count("settle-transition", "workflow"), 1);
  });
});
