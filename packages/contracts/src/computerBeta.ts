import * as Schema from "effect/Schema";
import type { ComputerEvent } from "./computer.ts";
import type { DesktopAppSnapState } from "./computerPermissions.ts";

/** Public queue fence, never a native-host credential. */
export const ComputerTurnIntent = Schema.Struct({
  mode: Schema.Literals(["request", "chat"]),
  generation: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});
export type ComputerTurnIntent = typeof ComputerTurnIntent.Type;
/** The desktop's answer to one Computer consent request over the private bridge. */
export const ComputerConsentReply = Schema.Struct({
  approved: Schema.Boolean,
  outcome: Schema.Literals([
    "accept",
    "decline",
    "pending",
    "expired",
    "unavailable",
    "busy",
    "stopped",
  ]),
  /**
   * False when asking again in this turn cannot help: a decline, a stopped task, a second
   * expiry, or the last of the few dialogs in a row that could not be shown.
   */
  retryable: Schema.Boolean,
  /** How long an accepted app approval lasts; only app approvals carry it. */
  scope: Schema.optionalKey(Schema.Literals(["always", "chat"])),
});
export type ComputerConsentReply = typeof ComputerConsentReply.Type;
/** An app the user chose "Always allow" for; stored by the server, listed in settings. */
export interface ComputerApprovedApp {
  /** Normalized app name, the approval key. */
  key: string;
  name: string;
  allowedAt: string;
}
/** A required macOS permission for Computer Use; Input Monitoring is optional. */
export type ComputerSetupPermission = "accessibility" | "screenRecording";
export interface ComputerBetaSetup {
  /** Required permissions that are not granted yet. */
  missing: readonly ComputerSetupPermission[];
  /** Input Monitoring is granted, so physical Escape stops an agent. */
  escapeStop: boolean;
  /**
   * Required grants were all seen on an earlier build and one is missing now: macOS may still
   * list the old build, which needs removing and adding again.
   */
  staleGrant: boolean;
  /**
   * Computer Use moved to its own helper app (Ryco Computer Use) and the grants Ryco had do not
   * carry over: the helper needs allowing once.
   */
  movedToHelper?: boolean;
}
export interface ComputerBetaPreferences {
  /** Computer Use is available in every chat from this Mac without `/computer-use`. */
  defaultEnabled: boolean;
  autoPreview: boolean;
  previewSize: "compact" | "large";
  cursorColor: string | null;
}
export interface ComputerBetaState {
  supported: boolean;
  targets?: readonly { threadId: string; turnId: string; targetId: string; label: string }[];
  permissions: DesktopAppSnapState;
  preferences: ComputerBetaPreferences;
  inputMonitorReady: boolean;
  setup: ComputerBetaSetup;
  approvedApps: readonly ComputerApprovedApp[];
  error: string | null;
}
export type ComputerBetaUpdate =
  | { type: "state"; state: ComputerBetaState }
  | { type: "event"; event: ComputerEvent }
  | { type: "target"; threadId: string; turnId: string; targetId: string; label: string }
  | { type: "ended"; threadId: string; turnId: string }
  | {
      type: "frame";
      threadId: string;
      turnId: string;
      targetId: string;
      sequence: number;
      mimeType: "image/jpeg" | "image/png";
      bytes: Uint8Array;
    }
  | { type: "error"; threadId: string; turnId: string; message: string };
