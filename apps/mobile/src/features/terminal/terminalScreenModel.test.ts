import { describe, expect, it } from "vite-plus/test";

import { buildTerminalScreenState } from "./terminalScreenModel";

const ready = {
  workspaceRootAvailable: true,
  hasSession: true,
  connectionState: "connected",
  mutationReady: true,
  rendererPhase: "ready",
  opening: false,
  hydrated: true,
  rendered: true,
  terminalStatus: "running",
} as const;

describe("terminal screen model", () => {
  it("requires an explicit start and current mutation authority", () => {
    expect(buildTerminalScreenState({ ...ready, hasSession: false })).toEqual({
      kind: "empty",
      canStart: true,
      readOnly: false,
    });
    expect(
      buildTerminalScreenState({
        ...ready,
        hasSession: false,
        connectionState: "read-only",
        mutationReady: false,
      }),
    ).toEqual({ kind: "empty", canStart: false, readOnly: true });
  });

  it("keeps rendered output visible but read-only while not mutation-ready", () => {
    expect(
      buildTerminalScreenState({ ...ready, connectionState: "offline", mutationReady: false }),
    ).toEqual({
      kind: "terminal",
      writable: false,
      connectionNotice: "Offline",
      status: "running",
    });
    expect(
      buildTerminalScreenState({ ...ready, connectionState: "connected", mutationReady: false }),
    ).toEqual({
      kind: "terminal",
      writable: false,
      connectionNotice: "Connecting…",
      status: "running",
    });
    expect(
      buildTerminalScreenState({ ...ready, connectionState: "read-only", mutationReady: false }),
    ).toEqual({
      kind: "terminal",
      writable: false,
      connectionNotice: "Read-only",
      status: "running",
    });
  });

  it("does not become writable before hydration, and says why nothing shows yet", () => {
    expect(buildTerminalScreenState({ ...ready, hydrated: false, rendered: false })).toEqual({
      kind: "hydrating",
    });
    expect(
      buildTerminalScreenState({ ...ready, hydrated: false, rendered: false, opening: true }),
    ).toEqual({ kind: "starting" });
    expect(
      buildTerminalScreenState({
        ...ready,
        hydrated: false,
        rendered: false,
        connectionState: "offline",
        mutationReady: false,
      }),
    ).toEqual({ kind: "waiting", notice: "Offline" });
    // Output from before a resume stays up while the fresh snapshot loads.
    expect(buildTerminalScreenState({ ...ready, hydrated: false })).toMatchObject({
      kind: "terminal",
      writable: false,
    });
    expect(buildTerminalScreenState({ ...ready, rendererPhase: "failed" })).toEqual({
      kind: "renderer-failed",
    });
  });

  it("keeps exited terminals visible but not writable", () => {
    expect(buildTerminalScreenState({ ...ready, terminalStatus: "exited" })).toEqual({
      kind: "terminal",
      writable: false,
      connectionNotice: null,
      status: "exited",
    });
  });
});
