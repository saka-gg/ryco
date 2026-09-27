import { Schema } from "effect";
import type { ComputerEvent } from "./computer.ts";
import type { DesktopAppSnapState } from "./computerPermissions.ts";

/** Public queue fence, never a native-host credential. */
export const ComputerTurnIntent = Schema.Struct({
  mode: Schema.Literals(["request", "chat"]),
  generation: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});
export type ComputerTurnIntent = typeof ComputerTurnIntent.Type;
export interface ComputerBetaPreferences {
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
