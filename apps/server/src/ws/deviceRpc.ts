import { Effect, Option, Queue, Schema, Stream } from "effect";
import {
  type AuthRpcError,
  DEVICE_WS_METHODS,
  DeviceRpcError,
  type DeviceAppRequest,
  type DeviceAppResponse,
  type DeviceEvent,
  type DeviceInputRequest,
  type DeviceInputResponse,
  type DeviceLifecycleRequest,
  type DeviceLifecycleResponse,
  type DeviceReadRequest,
  type DeviceReadResponse,
  type DeviceRecordingRequest,
  type DeviceRecordingResponse,
  type DeviceRpcErrorCode,
  type DeviceTapInput,
  type ThreadDeviceState,
} from "@ryco/contracts";

import type { DeviceManager } from "../device/DeviceManager.ts";
import { DeviceBackendError } from "../device/DeviceBackend.ts";
import type { DeviceServiceShape } from "../device/Services/DeviceService.ts";
import { readTapRequest } from "../device/uiTreeTargeting.ts";
import { observeRpcEffect, observeRpcStream } from "../observability/RpcInstrumentation.ts";

const DEVICE_EVENT_BUFFER_CAPACITY = 128;
const DEVICE_ERROR_MESSAGE_LIMIT = 2_048;
const UNSUPPORTED_MESSAGE =
  "The Simulator workspace requires a macOS Ryco node with Xcode and an iOS runtime.";

type DeviceOperation = "attach" | "screenshot" | "recording" | "helper" | "operation";

function safeMessage(cause: unknown, fallback: string): string {
  const raw = cause instanceof Error && cause.message.trim() ? cause.message.trim() : fallback;
  // Device failures can originate in subprocess stderr. Keep a useful first
  // line without sending an unbounded command dump across the RPC boundary.
  return raw.replaceAll("\0", "").slice(0, DEVICE_ERROR_MESSAGE_LIMIT) || fallback;
}

function errorCode(cause: unknown, operation: DeviceOperation): DeviceRpcErrorCode {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/unsupported platform|requires macos|only available on macos/iu.test(message)) {
    return "unsupported-platform";
  }
  if (/xcode|license|runtime is installed|developer directory|command line tools/iu.test(message)) {
    return "setup-required";
  }
  if (/compile|swiftc|helper build/iu.test(message)) return "helper-build-failed";
  if (/protocol|acknowledg|request id|malformed helper|helper exited/iu.test(message)) {
    return "helper-protocol-failed";
  }
  if (operation === "attach" && /timed out|never published|display|framebuffer/iu.test(message)) {
    return "attach-timeout";
  }
  if (/stale|superseded|generation/iu.test(message)) return "stale-session";
  if (operation === "screenshot") return "screenshot-failed";
  if (operation === "recording") return "recording-failed";
  if (cause instanceof DeviceBackendError) return "device-unavailable";
  return operation === "helper" ? "helper-protocol-failed" : "operation-failed";
}

function toDeviceRpcError(
  cause: unknown,
  fallback: string,
  operation: DeviceOperation = "operation",
): DeviceRpcError {
  if (Schema.is(DeviceRpcError)(cause)) return cause;
  return new DeviceRpcError({
    code: errorCode(cause, operation),
    message: safeMessage(cause, fallback),
    retryable: cause instanceof DeviceBackendError ? cause.retryable : false,
  });
}

function attempt<A>(
  promise: () => Promise<A>,
  fallback: string,
  operation: DeviceOperation = "operation",
): Effect.Effect<A, DeviceRpcError> {
  return Effect.tryPromise({
    try: promise,
    catch: (cause) => toDeviceRpcError(cause, fallback, operation),
  });
}

function unsupportedError(): DeviceRpcError {
  return new DeviceRpcError({
    code: "unsupported-platform",
    message: UNSUPPORTED_MESSAGE,
    retryable: false,
  });
}

function unsupported<A>(): Effect.Effect<A, DeviceRpcError> {
  return Effect.fail(unsupportedError());
}

async function tapFromInput(manager: DeviceManager, input: DeviceTapInput): Promise<void> {
  const request = readTapRequest(input);
  if (request.kind === "point") {
    await manager.tap(input.udid, request.x, request.y);
    return;
  }
  await manager.tapElement(input.udid, request.target);
}

function unsupportedThreadState(threadId: ThreadDeviceState["threadId"]): ThreadDeviceState {
  return {
    threadId,
    version: 0,
    attachedDeviceUdid: null,
    attachPhase: null,
    devices: [],
    agentActive: false,
    availability: { kind: "unsupported-platform", platform: process.platform },
    lastError: null,
  };
}

function makeDeviceEventStream(
  service: DeviceServiceShape | undefined,
): Stream.Stream<DeviceEvent, DeviceRpcError> {
  if (!service?.supported) return Stream.fail(unsupportedError());
  const manager = service.manager;
  return Stream.callback<DeviceEvent, DeviceRpcError>(
    (queue) =>
      Effect.acquireRelease(
        Effect.sync(() => manager.onEvent((event) => Queue.offerUnsafe(queue, event))),
        (unsubscribe) => Effect.sync(unsubscribe),
      ),
    { bufferSize: DEVICE_EVENT_BUFFER_CAPACITY, strategy: "dropping" },
  );
}

export interface DeviceRpcContext {
  readonly deviceService: Option.Option<DeviceServiceShape>;
  readonly withAccess: <A, E, R>(
    access: "viewer" | "operator" | "owner" | "authenticated" | "direct_owner",
    method: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | AuthRpcError, R>;
}

function invoke<A>(
  manager: DeviceManager | undefined,
  call: (manager: DeviceManager) => Promise<A>,
  fallback: string,
  operation: DeviceOperation = "operation",
): Effect.Effect<A, DeviceRpcError> {
  return manager ? attempt(() => call(manager), fallback, operation) : unsupported<A>();
}

function handleRead(
  manager: DeviceManager | undefined,
  request: DeviceReadRequest,
): Effect.Effect<DeviceReadResponse, DeviceRpcError> {
  switch (request.type) {
    case "list":
      return invoke(
        manager,
        (active) => active.list({ includeShutdown: request.input.includeShutdown ?? false }),
        "Failed to list simulators.",
      ).pipe(Effect.map((result) => ({ type: "list" as const, result })));
    case "get-thread-state":
      return (
        manager
          ? attempt(
              () => manager.getThreadState(request.input.threadId),
              "Failed to read simulator state.",
            )
          : Effect.succeed(unsupportedThreadState(request.input.threadId))
      ).pipe(Effect.map((result) => ({ type: "get-thread-state" as const, result })));
    case "screenshot":
      return invoke(
        manager,
        (active) => active.screenshot(request.input.udid, { save: request.input.save ?? false }),
        "Failed to capture a screenshot.",
        "screenshot",
      ).pipe(Effect.map((result) => ({ type: "screenshot" as const, result })));
    case "describe-ui":
      return invoke(
        manager,
        (active) => active.describeUi(request.input.udid),
        "Failed to read the simulator accessibility tree.",
      ).pipe(Effect.map((result) => ({ type: "describe-ui" as const, result })));
  }
}

function handleLifecycle(
  manager: DeviceManager | undefined,
  request: DeviceLifecycleRequest,
): Effect.Effect<DeviceLifecycleResponse, DeviceRpcError> {
  switch (request.type) {
    case "boot":
      return invoke(
        manager,
        (active) => active.boot(request.input.udid),
        "Failed to boot the simulator.",
      ).pipe(Effect.map((result) => ({ type: "boot" as const, result })));
    case "shutdown":
      return invoke(
        manager,
        (active) => active.shutdown(request.input.udid),
        "Failed to shut down the simulator.",
      ).pipe(Effect.as({ type: "shutdown" as const }));
    case "attach":
      return invoke(
        manager,
        (active) => active.attach(request.input.threadId, request.input.udid),
        "Failed to attach the simulator.",
        "attach",
      ).pipe(Effect.map((result) => ({ type: "attach" as const, result })));
    case "detach":
      return invoke(
        manager,
        (active) => active.detach(request.input.threadId),
        "Failed to detach the simulator.",
      ).pipe(Effect.map((result) => ({ type: "detach" as const, result })));
  }
}

function handleInput(
  manager: DeviceManager | undefined,
  request: DeviceInputRequest,
): Effect.Effect<DeviceInputResponse, DeviceRpcError> {
  switch (request.type) {
    case "tap":
      return invoke(
        manager,
        (active) => tapFromInput(active, request.input),
        "Failed to tap the simulator.",
      ).pipe(Effect.as({ type: "tap" as const }));
    case "swipe":
      return invoke(
        manager,
        (active) =>
          active.swipe(request.input.udid, {
            fromX: request.input.fromX,
            fromY: request.input.fromY,
            toX: request.input.toX,
            toY: request.input.toY,
            durationMs: request.input.durationMs,
          }),
        "Failed to swipe on the simulator.",
      ).pipe(Effect.as({ type: "swipe" as const }));
    case "type-text":
      return invoke(
        manager,
        (active) => active.typeText(request.input.udid, request.input.text),
        "Failed to type text.",
      ).pipe(Effect.as({ type: "type-text" as const }));
    case "key-event":
      return invoke(
        manager,
        (active) =>
          active.keyEvent(request.input.udid, {
            keyCode: request.input.keyCode,
            modifiers: request.input.modifiers,
            direction: request.input.direction,
          }),
        "Failed to send the key event.",
      ).pipe(Effect.as({ type: "key-event" as const }));
    case "press-button":
      return invoke(
        manager,
        (active) => active.pressButton(request.input.udid, request.input.button),
        "Failed to press the simulator button.",
      ).pipe(Effect.as({ type: "press-button" as const }));
    case "scroll-to-element":
      return invoke(
        manager,
        async (active) => {
          const match = await active.scrollToElement(
            request.input.udid,
            { label: request.input.label, role: request.input.role },
            { maxScrolls: request.input.maxSwipes },
          );
          return { udid: request.input.udid, element: match.node, tapPoint: match.point };
        },
        "Failed to scroll to the element.",
      ).pipe(Effect.map((result) => ({ type: "scroll-to-element" as const, result })));
  }
}

function handleApp(
  manager: DeviceManager | undefined,
  request: DeviceAppRequest,
): Effect.Effect<DeviceAppResponse, DeviceRpcError> {
  switch (request.type) {
    case "testing":
      return invoke(
        manager,
        (active) => active.testing(request.input),
        "Could not apply simulator testing action.",
      ).pipe(Effect.as({ type: "testing" as const }));
    case "install-app":
      return invoke(
        manager,
        (active) => active.install(request.input.udid, request.input.appPath),
        "Failed to install the app.",
      ).pipe(Effect.map((result) => ({ type: "install-app" as const, result })));
    case "launch-app":
      return invoke(
        manager,
        (active) =>
          active.launch(request.input.udid, request.input.bundleId, request.input.arguments),
        "Failed to launch the app.",
      ).pipe(Effect.map((result) => ({ type: "launch-app" as const, result })));
    case "open-url":
      return invoke(
        manager,
        (active) => active.openUrl(request.input.udid, request.input.url),
        "Failed to open the URL.",
      ).pipe(Effect.as({ type: "open-url" as const }));
  }
}

function handleRecording(
  manager: DeviceManager | undefined,
  request: DeviceRecordingRequest,
): Effect.Effect<DeviceRecordingResponse, DeviceRpcError> {
  switch (request.type) {
    case "start-recording":
      return invoke(
        manager,
        (active) => active.startRecording(request.input.udid),
        "Failed to start recording.",
        "recording",
      ).pipe(Effect.map((result) => ({ type: "start-recording" as const, result })));
    case "stop-recording":
      return invoke(
        manager,
        (active) => active.stopRecording(request.input.udid),
        "Failed to stop recording.",
        "recording",
      ).pipe(Effect.map((result) => ({ type: "stop-recording" as const, result })));
  }
}

export const makeDeviceHandlers = (ctx: DeviceRpcContext) => {
  const service = Option.getOrUndefined(ctx.deviceService);
  const manager = service?.supported ? service.manager : undefined;
  const observed = <A, E, R>(
    method: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => observeRpcEffect(method, effect, { "rpc.aggregate": "device" });
  const owner = <A>(method: string, effect: Effect.Effect<A, DeviceRpcError>) =>
    ctx.withAccess("owner", method, effect);

  return {
    [DEVICE_WS_METHODS.read]: (request: DeviceReadRequest) =>
      observed(
        DEVICE_WS_METHODS.read,
        ctx.withAccess("viewer", DEVICE_WS_METHODS.read, handleRead(manager, request)),
      ),
    [DEVICE_WS_METHODS.lifecycle]: (request: DeviceLifecycleRequest) =>
      observed(
        DEVICE_WS_METHODS.lifecycle,
        owner(DEVICE_WS_METHODS.lifecycle, handleLifecycle(manager, request)),
      ),
    [DEVICE_WS_METHODS.input]: (request: DeviceInputRequest) =>
      observed(
        DEVICE_WS_METHODS.input,
        owner(DEVICE_WS_METHODS.input, handleInput(manager, request)),
      ),
    [DEVICE_WS_METHODS.app]: (request: DeviceAppRequest) =>
      observed(DEVICE_WS_METHODS.app, owner(DEVICE_WS_METHODS.app, handleApp(manager, request))),
    [DEVICE_WS_METHODS.recording]: (request: DeviceRecordingRequest) =>
      observed(
        DEVICE_WS_METHODS.recording,
        owner(DEVICE_WS_METHODS.recording, handleRecording(manager, request)),
      ),
    [DEVICE_WS_METHODS.subscribeEvents]: (_input: unknown) =>
      observeRpcStream(
        DEVICE_WS_METHODS.subscribeEvents,
        Stream.unwrap(
          ctx.withAccess(
            "viewer",
            DEVICE_WS_METHODS.subscribeEvents,
            Effect.succeed(makeDeviceEventStream(service)),
          ),
        ),
        { "rpc.aggregate": "device" },
      ),
  };
};
