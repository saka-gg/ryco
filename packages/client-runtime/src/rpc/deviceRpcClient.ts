import {
  DEVICE_WS_METHODS,
  type DeviceAttachInput,
  type DeviceBootInput,
  type DeviceBootResult,
  type DeviceDescribeUiInput,
  type DeviceDescribeUiResult,
  type DeviceDetachInput,
  type DeviceEvent,
  type DeviceInstallAppInput,
  type DeviceInstallAppResult,
  type DeviceKeyEventInput,
  type DeviceLaunchAppInput,
  type DeviceLaunchAppResult,
  type DeviceListInput,
  type DeviceListResult,
  type DeviceOpenUrlInput,
  type DeviceTestingInput,
  type DevicePressButtonInput,
  type DeviceScreenshotInput,
  type DeviceScreenshotResult,
  type DeviceScrollToElementInput,
  type DeviceScrollToElementResult,
  type DeviceShutdownInput,
  type DeviceStartRecordingInput,
  type DeviceStartRecordingResult,
  type DeviceStopRecordingInput,
  type DeviceStopRecordingResult,
  type DeviceSwipeInput,
  type DeviceTapInput,
  type DeviceThreadInput,
  type DeviceTypeTextInput,
  type ThreadDeviceState,
} from "@ryco/contracts";

import type { DeviceRpcProtocolClient } from "./protocol.ts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  isUnsupportedRpcError,
  RpcTransportDisposedError,
  type SubscriptionFailureKind,
} from "./wsTransport.ts";
import type {
  DeviceFrameSource,
  DeviceFrameSourceHandlers,
} from "../connection/deviceFrameSource.ts";

export interface DeviceStreamSubscriptionOptions {
  readonly onResubscribe?: () => void;
  readonly onError?: () => void;
}

export interface DeviceRpcClient {
  readonly dispose: () => Promise<void>;
  readonly reconnect: () => Promise<void>;
  readonly isHeartbeatFresh: () => boolean;
  readonly openFrameSource?: (
    udid: DeviceAttachInput["udid"],
    handlers: DeviceFrameSourceHandlers,
  ) => DeviceFrameSource;
  readonly list: (input?: DeviceListInput) => Promise<DeviceListResult>;
  readonly getThreadState: (input: DeviceThreadInput) => Promise<ThreadDeviceState>;
  readonly screenshot: (input: DeviceScreenshotInput) => Promise<DeviceScreenshotResult>;
  readonly describeUi: (input: DeviceDescribeUiInput) => Promise<DeviceDescribeUiResult>;
  readonly boot: (input: DeviceBootInput) => Promise<DeviceBootResult>;
  readonly shutdown: (input: DeviceShutdownInput) => Promise<void>;
  readonly attach: (input: DeviceAttachInput) => Promise<ThreadDeviceState>;
  readonly detach: (input: DeviceDetachInput) => Promise<ThreadDeviceState>;
  readonly tap: (input: DeviceTapInput) => Promise<void>;
  readonly swipe: (input: DeviceSwipeInput) => Promise<void>;
  readonly typeText: (input: DeviceTypeTextInput) => Promise<void>;
  readonly keyEvent: (input: DeviceKeyEventInput) => Promise<void>;
  readonly pressButton: (input: DevicePressButtonInput) => Promise<void>;
  readonly scrollToElement: (
    input: DeviceScrollToElementInput,
  ) => Promise<DeviceScrollToElementResult>;
  readonly installApp: (input: DeviceInstallAppInput) => Promise<DeviceInstallAppResult>;
  readonly launchApp: (input: DeviceLaunchAppInput) => Promise<DeviceLaunchAppResult>;
  readonly testing: (input: DeviceTestingInput) => Promise<void>;
  readonly openUrl: (input: DeviceOpenUrlInput) => Promise<void>;
  readonly startRecording: (
    input: DeviceStartRecordingInput,
  ) => Promise<DeviceStartRecordingResult>;
  readonly stopRecording: (input: DeviceStopRecordingInput) => Promise<DeviceStopRecordingResult>;
  readonly onEvent: (
    listener: (event: DeviceEvent) => void,
    options?: DeviceStreamSubscriptionOptions,
  ) => () => void;
}

export interface DeviceRpcTransport {
  readonly dispose: () => Promise<void>;
  readonly reconnect: () => Promise<void>;
  readonly isHeartbeatFresh: () => boolean;
  readonly request: <TSuccess>(
    execute: (client: DeviceRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
  ) => Promise<TSuccess>;
  /**
   * Large, repeated reads (screenshots). A transport that keeps them off the
   * application socket provides this; otherwise they use `request`.
   */
  readonly requestBulk?: <TSuccess>(
    execute: (client: DeviceRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
  ) => Promise<TSuccess>;
  readonly subscribe: <TValue>(
    connect: (client: DeviceRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    options?: DeviceStreamSubscriptionOptions & { readonly tag?: string },
  ) => () => void;
}

/** The application socket, whose client also names the device RPCs. */
export interface DeviceCapableMainTransport {
  readonly isHeartbeatFresh: () => boolean;
  readonly request: <TSuccess>(
    execute: (client: DeviceRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
  ) => Promise<TSuccess>;
  readonly subscribe: <TValue>(
    connect: (client: DeviceRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    options?: {
      readonly onResubscribe?: () => void;
      readonly onError?: (kind?: SubscriptionFailureKind) => void;
      readonly classifyFailure?: (error: unknown) => SubscriptionFailureKind;
      readonly tag?: string;
    },
  ) => () => void;
}

/** How long an unused dedicated device socket stays open before it closes. */
export const DEDICATED_DEVICE_SOCKET_IDLE_MS = 60_000;

const NOOP = () => undefined;

const classifyDeviceStreamFailure = (error: unknown): SubscriptionFailureKind =>
  isUnsupportedRpcError(error) ? "unsupported" : "failed";

/**
 * Device control for a direct connection without a socket of its own.
 *
 * Control RPCs and the event stream ride the application socket, which current
 * servers serve them on. The dedicated `/ws/device` socket (and its ws-token
 * request) opens only on demand: for screenshots, which are large and repeat
 * while a screenshot-streamed pane is open, and for everything once an older
 * server answered a device RPC with "Unknown request tag" — an answer given
 * before anything ran, so the request is safely sent again there. An unused
 * dedicated socket closes after `idleCloseMs`.
 */
export function createDirectDeviceRpcTransport(input: {
  readonly main: DeviceCapableMainTransport;
  readonly openDedicated: () => DeviceRpcTransport;
  readonly idleCloseMs?: number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}): DeviceRpcTransport {
  const idleCloseMs = input.idleCloseMs ?? DEDICATED_DEVICE_SOCKET_IDLE_MS;
  const setTimer =
    input.setTimeout ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer =
    input.clearTimeout ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let disposed = false;
  /** Set once the server showed it serves device RPCs only on `/ws/device`. */
  let mainUnsupported = false;
  let dedicated: DeviceRpcTransport | null = null;
  let dedicatedUsers = 0;
  let idleTimer: unknown = null;

  const cancelIdleClose = () => {
    if (idleTimer === null) return;
    clearTimer(idleTimer);
    idleTimer = null;
  };
  const acquireDedicated = (): DeviceRpcTransport => {
    if (disposed) throw new RpcTransportDisposedError();
    cancelIdleClose();
    dedicated ??= input.openDedicated();
    dedicatedUsers += 1;
    return dedicated;
  };
  const releaseDedicated = (transport: DeviceRpcTransport) => {
    if (transport !== dedicated) return;
    dedicatedUsers = Math.max(0, dedicatedUsers - 1);
    if (dedicatedUsers > 0 || disposed) return;
    cancelIdleClose();
    idleTimer = setTimer(() => {
      idleTimer = null;
      if (dedicatedUsers > 0 || dedicated !== transport) return;
      dedicated = null;
      void transport.dispose().catch(NOOP);
    }, idleCloseMs);
  };
  const requestDedicated = async <TSuccess>(
    execute: (client: DeviceRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
  ): Promise<TSuccess> => {
    const transport = acquireDedicated();
    try {
      return await transport.request(execute);
    } finally {
      releaseDedicated(transport);
    }
  };
  const subscribeDedicated = <TValue>(
    connect: (client: DeviceRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    options?: DeviceStreamSubscriptionOptions & { readonly tag?: string },
  ): (() => void) => {
    const transport = acquireDedicated();
    const unsubscribe = transport.subscribe(connect, listener, options);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      unsubscribe();
      releaseDedicated(transport);
    };
  };

  return {
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      cancelIdleClose();
      const transport = dedicated;
      dedicated = null;
      await transport?.dispose();
    },
    reconnect: async () => {
      if (disposed) throw new RpcTransportDisposedError();
      // The application socket is reconnected by its own owner.
      await dedicated?.reconnect();
    },
    isHeartbeatFresh: () =>
      mainUnsupported ? (dedicated?.isHeartbeatFresh() ?? false) : input.main.isHeartbeatFresh(),
    request: async (execute) => {
      if (disposed) throw new RpcTransportDisposedError();
      if (!mainUnsupported) {
        try {
          return await input.main.request(execute);
        } catch (error) {
          if (!isUnsupportedRpcError(error)) throw error;
          mainUnsupported = true;
        }
      }
      return requestDedicated(execute);
    },
    requestBulk: (execute) => requestDedicated(execute),
    subscribe: (connect, listener, options) => {
      if (disposed) return NOOP;
      if (mainUnsupported) return subscribeDedicated(connect, listener, options);
      let active = true;
      let stop: () => void = NOOP;
      stop = input.main.subscribe(connect, listener, {
        ...(options?.tag === undefined ? {} : { tag: options.tag }),
        ...(options?.onResubscribe === undefined ? {} : { onResubscribe: options.onResubscribe }),
        classifyFailure: classifyDeviceStreamFailure,
        onError: (kind) => {
          if (kind === "unsupported" && active && !disposed) {
            mainUnsupported = true;
            stop = subscribeDedicated(connect, listener, options);
            return;
          }
          options?.onError?.();
        },
      });
      return () => {
        active = false;
        stop();
      };
    },
  };
}

function unexpectedResponse(expected: string, actual: string): never {
  throw new Error(`Device RPC returned ${actual}; expected ${expected}.`);
}

export function createDeviceRpcClient(
  transport: DeviceRpcTransport,
  options?: {
    readonly openFrameSource?: DeviceRpcClient["openFrameSource"];
    /** A hosted device client borrows the main transport; its parent owns lifecycle. */
    readonly manageTransport?: boolean;
  },
): DeviceRpcClient {
  const manageTransport = options?.manageTransport ?? true;
  return {
    dispose: () => (manageTransport ? transport.dispose() : Promise.resolve()),
    reconnect: () => (manageTransport ? transport.reconnect() : Promise.resolve()),
    isHeartbeatFresh: () => transport.isHeartbeatFresh(),
    ...(options?.openFrameSource ? { openFrameSource: options.openFrameSource } : {}),
    list: async (input = {}) => {
      const response = await transport.request((client) =>
        client[DEVICE_WS_METHODS.read]({ type: "list", input }),
      );
      return response.type === "list" ? response.result : unexpectedResponse("list", response.type);
    },
    getThreadState: async (input) => {
      const response = await transport.request((client) =>
        client[DEVICE_WS_METHODS.read]({ type: "get-thread-state", input }),
      );
      return response.type === "get-thread-state"
        ? response.result
        : unexpectedResponse("get-thread-state", response.type);
    },
    screenshot: async (input) => {
      const read = (client: DeviceRpcProtocolClient) =>
        client[DEVICE_WS_METHODS.read]({ type: "screenshot", input });
      const response = await (transport.requestBulk
        ? transport.requestBulk(read)
        : transport.request(read));
      return response.type === "screenshot"
        ? response.result
        : unexpectedResponse("screenshot", response.type);
    },
    describeUi: async (input) => {
      const response = await transport.request((client) =>
        client[DEVICE_WS_METHODS.read]({ type: "describe-ui", input }),
      );
      return response.type === "describe-ui"
        ? response.result
        : unexpectedResponse("describe-ui", response.type);
    },
    boot: async (input) => {
      const response = await transport.request((client) =>
        client[DEVICE_WS_METHODS.lifecycle]({ type: "boot", input }),
      );
      return response.type === "boot" ? response.result : unexpectedResponse("boot", response.type);
    },
    shutdown: async (input) => {
      const response = await transport.request((client) =>
        client[DEVICE_WS_METHODS.lifecycle]({ type: "shutdown", input }),
      );
      if (response.type !== "shutdown") unexpectedResponse("shutdown", response.type);
    },
    attach: async (input) => {
      const response = await transport.request((client) =>
        client[DEVICE_WS_METHODS.lifecycle]({ type: "attach", input }),
      );
      return response.type === "attach"
        ? response.result
        : unexpectedResponse("attach", response.type);
    },
    detach: async (input) => {
      const response = await transport.request((client) =>
        client[DEVICE_WS_METHODS.lifecycle]({ type: "detach", input }),
      );
      return response.type === "detach"
        ? response.result
        : unexpectedResponse("detach", response.type);
    },
    tap: async (input) => {
      const response = await transport.request((client) =>
        client[DEVICE_WS_METHODS.input]({ type: "tap", input }),
      );
      if (response.type !== "tap") unexpectedResponse("tap", response.type);
    },
    swipe: async (input) => {
      const response = await transport.request((client) =>
        client[DEVICE_WS_METHODS.input]({ type: "swipe", input }),
      );
      if (response.type !== "swipe") unexpectedResponse("swipe", response.type);
    },
    typeText: async (input) => {
      const response = await transport.request((client) =>
        client[DEVICE_WS_METHODS.input]({ type: "type-text", input }),
      );
      if (response.type !== "type-text") unexpectedResponse("type-text", response.type);
    },
    keyEvent: async (input) => {
      const response = await transport.request((client) =>
        client[DEVICE_WS_METHODS.input]({ type: "key-event", input }),
      );
      if (response.type !== "key-event") unexpectedResponse("key-event", response.type);
    },
    pressButton: async (input) => {
      const response = await transport.request((client) =>
        client[DEVICE_WS_METHODS.input]({ type: "press-button", input }),
      );
      if (response.type !== "press-button") {
        unexpectedResponse("press-button", response.type);
      }
    },
    scrollToElement: async (input) => {
      const response = await transport.request((client) =>
        client[DEVICE_WS_METHODS.input]({ type: "scroll-to-element", input }),
      );
      return response.type === "scroll-to-element"
        ? response.result
        : unexpectedResponse("scroll-to-element", response.type);
    },
    installApp: async (input) => {
      const response = await transport.request((client) =>
        client[DEVICE_WS_METHODS.app]({ type: "install-app", input }),
      );
      return response.type === "install-app"
        ? response.result
        : unexpectedResponse("install-app", response.type);
    },
    launchApp: async (input) => {
      const response = await transport.request((client) =>
        client[DEVICE_WS_METHODS.app]({ type: "launch-app", input }),
      );
      return response.type === "launch-app"
        ? response.result
        : unexpectedResponse("launch-app", response.type);
    },
    testing: async (input) => {
      const response = await transport.request((client) =>
        client[DEVICE_WS_METHODS.app]({ type: "testing", input }),
      );
      if (response.type !== "testing") unexpectedResponse("testing", response.type);
    },
    openUrl: async (input) => {
      const response = await transport.request((client) =>
        client[DEVICE_WS_METHODS.app]({ type: "open-url", input }),
      );
      if (response.type !== "open-url") unexpectedResponse("open-url", response.type);
    },
    startRecording: async (input) => {
      const response = await transport.request((client) =>
        client[DEVICE_WS_METHODS.recording]({ type: "start-recording", input }),
      );
      return response.type === "start-recording"
        ? response.result
        : unexpectedResponse("start-recording", response.type);
    },
    stopRecording: async (input) => {
      const response = await transport.request((client) =>
        client[DEVICE_WS_METHODS.recording]({ type: "stop-recording", input }),
      );
      return response.type === "stop-recording"
        ? response.result
        : unexpectedResponse("stop-recording", response.type);
    },
    onEvent: (listener, options) =>
      transport.subscribe((client) => client[DEVICE_WS_METHODS.subscribeEvents]({}), listener, {
        ...options,
        tag: DEVICE_WS_METHODS.subscribeEvents,
      }),
  };
}
