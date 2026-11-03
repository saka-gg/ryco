import type { MobileTerminalStatus } from "./terminalSessionModel";

/** The environment row's connection state, as the shared readiness projection reports it. */
export type TerminalConnectionState = "connected" | "reconnecting" | "offline" | "read-only";
export type TerminalRendererPhase = "loading" | "ready" | "failed";
export type TerminalConnectionNotice = "Connecting…" | "Offline" | "Read-only";

export type TerminalScreenState =
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "empty"; readonly canStart: boolean; readonly readOnly: boolean }
  | { readonly kind: "renderer-loading" }
  | { readonly kind: "renderer-failed" }
  | { readonly kind: "starting" }
  | { readonly kind: "hydrating" }
  /** Nothing rendered yet and the machine cannot be asked for the snapshot now. */
  | { readonly kind: "waiting"; readonly notice: TerminalConnectionNotice }
  | {
      readonly kind: "terminal";
      readonly writable: boolean;
      readonly connectionNotice: TerminalConnectionNotice | null;
      readonly status: MobileTerminalStatus;
    };

function connectionNotice(input: {
  readonly connectionState: TerminalConnectionState;
  readonly mutationReady: boolean;
}): TerminalConnectionNotice | null {
  if (input.mutationReady) return null;
  if (input.connectionState === "read-only") return "Read-only";
  if (input.connectionState === "offline") return "Offline";
  // Connected but not yet mutation-ready: a hosted session still synchronizing.
  return "Connecting…";
}

/**
 * The terminal screen's state. Input needs both a hydrated renderer and the
 * shared mutation readiness: a viewer, an offline machine and a hosted session
 * that has not accepted its current snapshot keep what is shown, read-only.
 */
export function buildTerminalScreenState(input: {
  readonly workspaceRootAvailable: boolean;
  readonly hasSession: boolean;
  readonly connectionState: TerminalConnectionState;
  readonly mutationReady: boolean;
  readonly rendererPhase: TerminalRendererPhase;
  readonly opening: boolean;
  readonly hydrated: boolean;
  /** The renderer shows this session's output, hydrated now or before a disconnect. */
  readonly rendered: boolean;
  readonly terminalStatus: MobileTerminalStatus;
}): TerminalScreenState {
  if (!input.workspaceRootAvailable) {
    return { kind: "unavailable", message: "This task has no workspace for a terminal." };
  }
  if (!input.hasSession) {
    return {
      kind: "empty",
      canStart: input.mutationReady,
      readOnly: input.connectionState === "read-only",
    };
  }
  if (input.rendererPhase === "failed") return { kind: "renderer-failed" };
  if (input.rendererPhase !== "ready") return { kind: "renderer-loading" };

  const notice = connectionNotice(input);
  if (!input.rendered) {
    if (notice !== null) return { kind: "waiting", notice };
    if (input.opening) return { kind: "starting" };
    return { kind: "hydrating" };
  }
  return {
    kind: "terminal",
    writable:
      notice === null && input.hydrated && !input.opening && input.terminalStatus === "running",
    connectionNotice: notice,
    status: input.terminalStatus,
  };
}
