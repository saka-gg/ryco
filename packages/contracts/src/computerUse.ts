import { Effect, Schema } from "effect";

const boundedText = Schema.String.check(Schema.isMaxLength(512));
export const ComputerAppAccess = Schema.Literals(["ask", "allow", "block"]);
export type ComputerAppAccess = typeof ComputerAppAccess.Type;
export const ComputerBrowser = Schema.Literals(["ryco", "chrome", "brave", "edge"]);
export type ComputerBrowser = typeof ComputerBrowser.Type;
export const ComputerUsePolicy = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  foregroundEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  apps: Schema.Record(boundedText, ComputerAppAccess).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  browsers: Schema.Array(ComputerBrowser).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type ComputerUsePolicy = typeof ComputerUsePolicy.Type;

export const ComputerUseApp = Schema.Struct({
  id: boundedText,
  name: boundedText,
});
export type ComputerUseApp = typeof ComputerUseApp.Type;

export const ComputerUseActivity = Schema.Struct({
  threadId: Schema.String,
  target: boundedText,
  mode: Schema.Literals(["background", "foreground"]),
  action: boundedText,
  x: Schema.optionalKey(Schema.Number),
  y: Schema.optionalKey(Schema.Number),
});
export type ComputerUseActivity = typeof ComputerUseActivity.Type;

export const ComputerUseState = Schema.Struct({
  policy: ComputerUsePolicy,
  apps: Schema.Array(ComputerUseApp),
  connectedBrowsers: Schema.Array(ComputerBrowser),
  accessibility: Schema.String,
  screenRecording: Schema.String,
  helperAvailable: Schema.Boolean,
  permissionInfo: Schema.optionalKey(
    Schema.Struct({
      checkedAt: Schema.NullOr(Schema.String),
      error: Schema.NullOr(boundedText),
      appName: boundedText,
      development: Schema.Boolean,
    }),
  ),
  activity: Schema.NullOr(ComputerUseActivity),
  error: Schema.NullOr(boundedText),
});
export type ComputerUseState = typeof ComputerUseState.Type;

export const ComputerUsePairing = Schema.Struct({
  browser: ComputerBrowser,
  url: Schema.String,
  token: Schema.String,
});
export type ComputerUsePairing = typeof ComputerUsePairing.Type;

/** Only the backend receives this through its private bootstrap descriptor. */
export const ComputerUseBridgeConfig = Schema.Struct({
  url: Schema.String,
  token: Schema.String.check(Schema.isMinLength(43), Schema.isMaxLength(43)),
});
export type ComputerUseBridgeConfig = typeof ComputerUseBridgeConfig.Type;

export const ComputerUseRequest = Schema.Struct({
  sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  threadId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  turnId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  tool: Schema.Literals(["computer", "browser"]),
  args: Schema.Record(Schema.String, Schema.Unknown),
});
export type ComputerUseRequest = typeof ComputerUseRequest.Type;

export const ComputerUseResult = Schema.Struct({
  content: Schema.Array(
    Schema.Union([
      Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
      Schema.Struct({
        type: Schema.Literal("image"),
        data: Schema.String,
        mimeType: Schema.Literals(["image/png", "image/jpeg"]),
      }),
    ]),
  ),
  isError: Schema.optionalKey(Schema.Boolean),
});
export type ComputerUseResult = typeof ComputerUseResult.Type;
