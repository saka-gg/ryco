import { Schema } from "effect";

export const SpeechRequest = Schema.Union([
  Schema.Struct({ action: Schema.Literals(["status", "remove"]) }),
  Schema.Struct({
    action: Schema.Literals(["install", "begin", "finish", "cancel"]),
    requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  }),
  Schema.Struct({
    action: Schema.Literal("chunk"),
    requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    sequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    pcm: Schema.String.check(Schema.isMaxLength(43_692)),
  }),
]);
export type SpeechRequest = typeof SpeechRequest.Type;
export const SpeechResponse = Schema.Struct({
  state: Schema.Literals([
    "ready",
    "missing-model",
    "unsupported",
    "busy",
    "accepted",
    "transcribed",
  ]),
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(32_000))),
});
export type SpeechResponse = typeof SpeechResponse.Type;
export class SpeechError extends Schema.TaggedError<SpeechError>()("SpeechError", {
  message: Schema.String,
}) {}
