import type { EnvironmentId, ScopedThreadRef, TerminalEvent } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createTerminalEventAdmission, shouldApplyTerminalEvent } from "./admission.ts";

const ENVIRONMENT_ID = "environment-a" as EnvironmentId;
const EVENT = {
  type: "output",
  threadId: "thread-a",
  terminalId: "default",
  createdAt: "2026-08-11T12:00:00.000Z",
  data: "not asserted or logged",
} as TerminalEvent;

describe("shouldApplyTerminalEvent", () => {
  it("applies events for draft-only threads", () => {
    expect(
      shouldApplyTerminalEvent({ serverThreadArchivedAt: undefined, hasDraftThread: true }),
    ).toBe(true);
  });

  it("rejects events for unknown threads", () => {
    expect(
      shouldApplyTerminalEvent({ serverThreadArchivedAt: undefined, hasDraftThread: false }),
    ).toBe(false);
  });

  it("rejects archived server threads even when a same-id draft exists", () => {
    expect(
      shouldApplyTerminalEvent({
        serverThreadArchivedAt: "2026-08-11T00:00:00.000Z",
        hasDraftThread: true,
      }),
    ).toBe(false);
  });

  it("applies events for active server threads", () => {
    expect(shouldApplyTerminalEvent({ serverThreadArchivedAt: null, hasDraftThread: false })).toBe(
      true,
    );
  });
});

describe("createTerminalEventAdmission", () => {
  function setup(input: { readonly archivedAt?: string | null; readonly hasDraft?: boolean }) {
    const applyTerminalEvent = vi.fn();
    const observed: ScopedThreadRef[] = [];
    const admit = createTerminalEventAdmission({
      readServerThreadArchivedAt: (ref) => {
        observed.push(ref);
        return input.archivedAt;
      },
      hasDraftThread: () => input.hasDraft ?? false,
      applyTerminalEvent,
    });
    return { admit, applyTerminalEvent, observed };
  }

  it("scopes the event to its environment's thread and applies it", () => {
    const context = setup({ archivedAt: null });

    expect(context.admit(EVENT, ENVIRONMENT_ID)).toBe(true);
    expect(context.observed).toEqual([{ environmentId: "environment-a", threadId: "thread-a" }]);
    expect(context.applyTerminalEvent).toHaveBeenCalledWith(context.observed[0], EVENT);
  });

  it("applies an event for a draft-only thread", () => {
    const context = setup({ hasDraft: true });

    expect(context.admit(EVENT, ENVIRONMENT_ID)).toBe(true);
    expect(context.applyTerminalEvent).toHaveBeenCalledTimes(1);
  });

  it("keeps an unlisted thread's events until the environment's shell has arrived", () => {
    let bootstrapped = false;
    const applyTerminalEvent = vi.fn();
    const admit = createTerminalEventAdmission({
      readServerThreadArchivedAt: () => undefined,
      hasDraftThread: () => false,
      applyTerminalEvent,
      isShellBootstrapped: () => bootstrapped,
    });

    expect(admit(EVENT, ENVIRONMENT_ID)).toBe(true);
    bootstrapped = true;
    expect(admit(EVENT, ENVIRONMENT_ID)).toBe(false);
    expect(applyTerminalEvent).toHaveBeenCalledTimes(1);
  });

  it("still rejects an archived thread before the shell has arrived", () => {
    const applyTerminalEvent = vi.fn();
    const admit = createTerminalEventAdmission({
      readServerThreadArchivedAt: () => "2026-08-11T00:00:00.000Z",
      hasDraftThread: () => false,
      applyTerminalEvent,
      isShellBootstrapped: () => false,
    });
    expect(admit(EVENT, ENVIRONMENT_ID)).toBe(false);
  });

  it("rejects archived and unknown threads without touching the store", () => {
    const archived = setup({ archivedAt: "2026-08-11T00:00:00.000Z", hasDraft: true });
    const unknown = setup({});

    expect(archived.admit(EVENT, ENVIRONMENT_ID)).toBe(false);
    expect(unknown.admit(EVENT, ENVIRONMENT_ID)).toBe(false);
    expect(archived.applyTerminalEvent).not.toHaveBeenCalled();
    expect(unknown.applyTerminalEvent).not.toHaveBeenCalled();
  });
});
