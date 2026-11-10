import type { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import type { ClientVisibility } from "./clientVisibility.ts";
import { createTerminalOutputScope } from "./terminalOutputScope.ts";

let environmentCounter = 0;

const make = (
  options: { readonly visibility?: ClientVisibility; readonly environmentId?: string } = {},
) => {
  const detached: string[] = [];
  const hints: ClientVisibility[] = [];
  let current = options.visibility ?? "foreground";
  const environmentId = (options.environmentId ??
    `env-${(environmentCounter += 1)}`) as EnvironmentId;
  const scope = createTerminalOutputScope({
    environmentId: () => environmentId,
    detach: async (ref) => {
      detached.push(`${ref.threadId}/${ref.terminalId}`);
    },
    setVisibility: async (next) => {
      hints.push(next);
    },
    readVisibility: () => current,
  });
  return {
    scope,
    environmentId,
    detached,
    hints,
    setVisibility: (next: ClientVisibility) => {
      current = next;
      scope.visibilityChanged(next);
    },
  };
};

const ref = { threadId: "thread", terminalId: "default" };

describe("terminal output scope", () => {
  it("names held terminals in every subscription and counts holders", () => {
    const { scope, detached } = make();
    const releaseA = scope.attach(ref);
    const releaseB = scope.attach(ref);
    expect(scope.subscribeInput()).toEqual({
      replay: "metadata",
      output: { attached: [ref] },
    });
    scope.acknowledge();
    releaseA();
    releaseA();
    expect(scope.isAttached(ref)).toBe(true);
    expect(detached).toEqual([]);
    releaseB();
    expect(scope.isAttached(ref)).toBe(false);
    expect(detached).toEqual(["thread/default"]);
    expect(scope.subscribeInput().output).toEqual({ attached: [] });
    scope.dispose();
  });

  it("keeps holds per environment, so a replacing connection names them at once", () => {
    const first = make({ environmentId: "env-replaced" });
    const release = first.scope.attach(ref);
    first.scope.dispose();
    const second = make({ environmentId: "env-replaced" });
    expect(second.scope.isAttached(ref)).toBe(true);
    expect(second.scope.subscribeInput().output).toEqual({ attached: [ref] });
    second.scope.acknowledge();
    release();
    // The disposed connection stays quiet; the current one detaches.
    expect(first.detached).toEqual([]);
    expect(second.detached).toEqual(["thread/default"]);
    // Another environment's connection never sees it.
    const other = make();
    expect(other.scope.isAttached(ref)).toBe(false);
    second.scope.dispose();
    other.scope.dispose();
  });

  it("sends nothing to a node that never acknowledged (an older node)", () => {
    const { scope, detached, hints, setVisibility } = make();
    scope.subscribeInput();
    const release = scope.attach(ref);
    release();
    setVisibility("background");
    expect(detached).toEqual([]);
    expect(hints).toEqual([]);
    expect(scope.isScoped()).toBe(false);
    scope.dispose();
  });

  it("tells an acknowledging node the visibility, again after each new stream", () => {
    const { scope, hints, setVisibility } = make({ visibility: "background" });
    scope.subscribeInput();
    scope.acknowledge();
    expect(hints).toEqual(["background"]);
    setVisibility("foreground");
    setVisibility("background");
    expect(hints).toEqual(["background", "foreground", "background"]);
    // A reconnect starts a new stream on a node that thinks the client is in the foreground.
    scope.subscribeInput();
    expect(scope.isScoped()).toBe(false);
    scope.acknowledge();
    expect(hints).toEqual(["background", "foreground", "background", "background"]);
    scope.dispose();
  });

  it("sends a detach released before the acknowledgement once it arrives", () => {
    const { scope, detached } = make();
    scope.subscribeInput();
    const releaseKept = scope.attach({ threadId: "thread", terminalId: "kept" });
    const releaseGone = scope.attach(ref);
    releaseGone();
    releaseKept();
    // Held again before the acknowledgement: attached again, so no detach for it.
    const releaseAgain = scope.attach({ threadId: "thread", terminalId: "kept" });
    expect(detached).toEqual([]);
    scope.acknowledge();
    expect(detached).toEqual(["thread/default"]);
    releaseAgain();
    scope.dispose();
  });

  it("keeps saying output may be filtered between a reconnect and the new acknowledgement", () => {
    const { scope } = make();
    expect(scope.mayHaveFilteredOutput()).toBe(false);
    scope.subscribeInput();
    scope.acknowledge();
    scope.subscribeInput();
    expect(scope.isScoped()).toBe(false);
    expect(scope.mayHaveFilteredOutput()).toBe(true);
    scope.dispose();
  });
});
