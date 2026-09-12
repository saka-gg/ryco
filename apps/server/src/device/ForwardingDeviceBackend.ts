import type { DeviceHardwareButton, DeviceGeometry } from "@ryco/contracts";
import type {
  DeviceBackend,
  DeviceFrameListener,
  DeviceListOptions,
  DeviceSwipeGesture,
  DeviceKeyEvent,
} from "./DeviceBackend.ts";

export type DeviceCall = Exclude<
  keyof DeviceBackend,
  | "platform"
  | "geometry"
  | "attachStream"
  | "dispose"
  | "onDisconnect"
  | "hostSummaries"
  | "discoverDevices"
  | "testing"
  | "suspendTesting"
>;
export type DeviceArgs<K extends DeviceCall> = Parameters<DeviceBackend[K]>;
export type DeviceResult<K extends DeviceCall> = Awaited<ReturnType<DeviceBackend[K]>>;

/** Keeps routing and transport adapters aligned with the platform interface. */
export abstract class ForwardingDeviceBackend implements DeviceBackend {
  readonly platform = "ios-simulator" as const;
  abstract call<K extends DeviceCall>(method: K, args: DeviceArgs<K>): Promise<DeviceResult<K>>;
  abstract geometry(udid: string): DeviceGeometry | null;
  abstract attachStream(udid: string, listener: DeviceFrameListener): Promise<void>;
  abstract dispose(): Promise<void>;
  abstract testing(input: Parameters<DeviceBackend["testing"]>[0]): Promise<void>;
  abstract suspendTesting(udid?: string): () => void;
  availability(): ReturnType<DeviceBackend["availability"]> {
    return this.call("availability", []);
  }
  listDevices(options?: DeviceListOptions): ReturnType<DeviceBackend["listDevices"]> {
    return this.call("listDevices", [options]);
  }
  boot(udid: string): ReturnType<DeviceBackend["boot"]> {
    return this.call("boot", [udid]);
  }
  shutdown(udid: string): ReturnType<DeviceBackend["shutdown"]> {
    return this.call("shutdown", [udid]);
  }
  install(udid: string, appPath: string): ReturnType<DeviceBackend["install"]> {
    return this.call("install", [udid, appPath]);
  }
  launch(
    udid: string,
    bundleId: string,
    args?: readonly string[],
  ): ReturnType<DeviceBackend["launch"]> {
    return this.call("launch", [udid, bundleId, args]);
  }
  openUrl(udid: string, url: string): ReturnType<DeviceBackend["openUrl"]> {
    return this.call("openUrl", [udid, url]);
  }
  tap(udid: string, x: number, y: number): ReturnType<DeviceBackend["tap"]> {
    return this.call("tap", [udid, x, y]);
  }
  swipe(udid: string, gesture: DeviceSwipeGesture): ReturnType<DeviceBackend["swipe"]> {
    return this.call("swipe", [udid, gesture]);
  }
  typeText(udid: string, text: string): ReturnType<DeviceBackend["typeText"]> {
    return this.call("typeText", [udid, text]);
  }
  keyEvent(udid: string, event: DeviceKeyEvent): ReturnType<DeviceBackend["keyEvent"]> {
    return this.call("keyEvent", [udid, event]);
  }
  pressButton(
    udid: string,
    button: DeviceHardwareButton,
  ): ReturnType<DeviceBackend["pressButton"]> {
    return this.call("pressButton", [udid, button]);
  }
  screenshot(
    udid: string,
    options?: { readonly save?: boolean },
  ): ReturnType<DeviceBackend["screenshot"]> {
    return this.call("screenshot", [udid, options]);
  }
  startRecording(udid: string): ReturnType<DeviceBackend["startRecording"]> {
    return this.call("startRecording", [udid]);
  }
  stopRecording(udid: string): ReturnType<DeviceBackend["stopRecording"]> {
    return this.call("stopRecording", [udid]);
  }
  describeUi(udid: string): ReturnType<DeviceBackend["describeUi"]> {
    return this.call("describeUi", [udid]);
  }
  detachStream(udid: string): ReturnType<DeviceBackend["detachStream"]> {
    return this.call("detachStream", [udid]);
  }
}
