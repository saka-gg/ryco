import { Schema } from "effect";
import * as C from "@ryco/contracts";

export const DEVICE_HOST_PROTOCOL = 1;
export const DEVICE_HOST_WORKER_ARG = "device-host-stdio";
export const MAX_DEVICE_HOST_MESSAGE = 48 * 1024 * 1024;
export const DeviceHostRequest = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  method: Schema.String,
  args: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(4)),
});
export const deviceHostOperations = {
  availability: { input: Schema.Tuple([]), output: C.DeviceAvailability },
  listDevices: {
    input: Schema.Tuple([
      Schema.UndefinedOr(Schema.Struct({ includeShutdown: Schema.optional(Schema.Boolean) })),
    ]),
    output: Schema.Array(C.DeviceDescriptor),
  },
  boot: { input: Schema.Tuple([C.DeviceUdid]), output: C.DeviceDescriptor },
  shutdown: { input: Schema.Tuple([C.DeviceUdid]), output: Schema.Void },
  install: {
    input: Schema.Tuple([C.DeviceUdid, C.DeviceInstallAppInput.fields.appPath]),
    output: C.DeviceInstallAppResult,
  },
  launch: {
    input: Schema.Tuple([
      C.DeviceUdid,
      C.DeviceBundleId,
      Schema.UndefinedOr(C.DeviceLaunchAppInput.fields.arguments),
    ]),
    output: C.DeviceLaunchAppResult,
  },
  openUrl: {
    input: Schema.Tuple([C.DeviceUdid, C.DeviceOpenUrlInput.fields.url]),
    output: Schema.Void,
  },
  tap: { input: Schema.Tuple([C.DeviceUdid, Schema.Finite, Schema.Finite]), output: Schema.Void },
  swipe: {
    input: Schema.Tuple([
      C.DeviceUdid,
      Schema.Struct({
        fromX: C.DeviceSwipeInput.fields.fromX,
        fromY: C.DeviceSwipeInput.fields.fromY,
        toX: C.DeviceSwipeInput.fields.toX,
        toY: C.DeviceSwipeInput.fields.toY,
        durationMs: C.DeviceSwipeInput.fields.durationMs,
      }),
    ]),
    output: Schema.Void,
  },
  typeText: {
    input: Schema.Tuple([C.DeviceUdid, C.DeviceTypeTextInput.fields.text]),
    output: Schema.Void,
  },
  keyEvent: {
    input: Schema.Tuple([
      C.DeviceUdid,
      Schema.Struct({
        keyCode: C.DeviceKeyEventInput.fields.keyCode,
        modifiers: C.DeviceKeyEventInput.fields.modifiers,
        direction: C.DeviceKeyEventInput.fields.direction,
      }),
    ]),
    output: Schema.Void,
  },
  pressButton: { input: Schema.Tuple([C.DeviceUdid, C.DeviceHardwareButton]), output: Schema.Void },
  screenshot: {
    input: Schema.Tuple([
      C.DeviceUdid,
      Schema.UndefinedOr(Schema.Struct({ save: Schema.optional(Schema.Boolean) })),
    ]),
    output: C.DeviceScreenshotResult,
  },
  startRecording: { input: Schema.Tuple([C.DeviceUdid]), output: C.DeviceStartRecordingResult },
  stopRecording: { input: Schema.Tuple([C.DeviceUdid]), output: C.DeviceStopRecordingResult },
  describeUi: { input: Schema.Tuple([C.DeviceUdid]), output: C.DeviceDescribeUiResult },
  detachStream: { input: Schema.Tuple([C.DeviceUdid]), output: Schema.Void },
  attachStream: {
    input: Schema.Tuple([C.DeviceUdid]),
    output: Schema.NullOr(
      Schema.Struct({
        pointWidth: Schema.Finite,
        pointHeight: Schema.Finite,
        scale: Schema.Finite,
      }),
    ),
  },
} as const;
export type DeviceHostOperation = keyof typeof deviceHostOperations;
export function isDeviceHostOperation(method: string): method is DeviceHostOperation {
  return Object.hasOwn(deviceHostOperations, method);
}
// Heterogeneous schemas are erased only here; both ends validate each operation.
export function decodeDeviceHostValue(
  schema: Schema.ConstraintDecoder<unknown, never>,
  value: unknown,
): unknown {
  return Schema.decodeUnknownSync(schema)(value);
}
