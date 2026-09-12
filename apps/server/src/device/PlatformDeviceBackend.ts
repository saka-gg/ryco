/** Routes platform operations through one manager, boot budget and authorization surface. */
import type { DeviceAvailability, DeviceDescriptor } from "@ryco/contracts";
import { type DeviceBackend, type DeviceListOptions } from "./DeviceBackend.ts";

export class PlatformDeviceBackend implements DeviceBackend {
  // The manager never uses this field for routing; descriptors carry their platform.
  readonly platform = "ios-simulator" as const;
  private readonly observed = new Map<DeviceBackend, readonly DeviceDescriptor[]>();
  private readonly ios: DeviceBackend;
  private readonly android: DeviceBackend;
  constructor(ios: DeviceBackend, android: DeviceBackend) {
    this.ios = ios;
    this.android = android;
  }

  private target(udid: string): DeviceBackend {
    return udid.startsWith("android:") ? this.android : this.ios;
  }

  async availability(): Promise<DeviceAvailability> {
    const states = await Promise.all([this.ios.availability(), this.android.availability()]);
    const usable = states.find(
      (state) =>
        state.kind === "available" ||
        state.kind === "degraded" ||
        // iOS builds its helper on attachment. Unrelated Android setup must not
        // hide the picker that initiates that build.
        (state.kind === "setup-required" &&
          state.steps.every((step) => step.done || step.id === "build-device-helper")),
    );
    if (usable) return usable;
    const steps = states.flatMap((state) => (state.kind === "setup-required" ? state.steps : []));
    if (steps.length) return { kind: "setup-required", steps };
    return states[0]!;
  }

  async listDevices(options?: DeviceListOptions) {
    // An absent SDK must not hide iOS, and an absent Xcode must not hide Android.
    const devices = await Promise.all(
      [this.ios, this.android].map(async (backend) => {
        try {
          const listed = await backend.listDevices({ includeShutdown: true });
          this.observed.set(backend, listed);
          return listed;
        } catch {
          // A failed SDK probe is not evidence that an owned device shut down.
          // Keep its last observation so manager reconciliation does not lose ownership.
          // Input and attachment still revalidate through the actual platform adapter.
          return this.observed.get(backend) ?? [];
        }
      }),
    );
    return devices
      .flat()
      .filter((device) => options?.includeShutdown || device.state !== "shutdown");
  }

  async boot(...args: Parameters<DeviceBackend["boot"]>): ReturnType<DeviceBackend["boot"]> {
    const backend = this.target(args[0]);
    const device = await backend.boot(...args);
    this.observed.set(backend, [
      ...(this.observed.get(backend) ?? []).filter((d) => d.udid !== device.udid),
      device,
    ]);
    return device;
  }

  async shutdown(
    ...args: Parameters<DeviceBackend["shutdown"]>
  ): ReturnType<DeviceBackend["shutdown"]> {
    const backend = this.target(args[0]);
    await backend.shutdown(...args);
    this.observed.set(
      backend,
      (this.observed.get(backend) ?? []).map((d) =>
        d.udid === args[0] ? Object.assign({}, d, { state: "shutdown" as const }) : d,
      ),
    );
  }

  install(...args: Parameters<DeviceBackend["install"]>): ReturnType<DeviceBackend["install"]> {
    return this.target(args[0]).install(...args);
  }

  launch(...args: Parameters<DeviceBackend["launch"]>): ReturnType<DeviceBackend["launch"]> {
    return this.target(args[0]).launch(...args);
  }

  openUrl(...args: Parameters<DeviceBackend["openUrl"]>): ReturnType<DeviceBackend["openUrl"]> {
    return this.target(args[0]).openUrl(...args);
  }

  tap(...args: Parameters<DeviceBackend["tap"]>): ReturnType<DeviceBackend["tap"]> {
    return this.target(args[0]).tap(...args);
  }

  swipe(...args: Parameters<DeviceBackend["swipe"]>): ReturnType<DeviceBackend["swipe"]> {
    return this.target(args[0]).swipe(...args);
  }

  typeText(...args: Parameters<DeviceBackend["typeText"]>): ReturnType<DeviceBackend["typeText"]> {
    return this.target(args[0]).typeText(...args);
  }

  keyEvent(...args: Parameters<DeviceBackend["keyEvent"]>): ReturnType<DeviceBackend["keyEvent"]> {
    return this.target(args[0]).keyEvent(...args);
  }

  pressButton(
    ...args: Parameters<DeviceBackend["pressButton"]>
  ): ReturnType<DeviceBackend["pressButton"]> {
    return this.target(args[0]).pressButton(...args);
  }

  screenshot(
    ...args: Parameters<DeviceBackend["screenshot"]>
  ): ReturnType<DeviceBackend["screenshot"]> {
    return this.target(args[0]).screenshot(...args);
  }

  startRecording(
    ...args: Parameters<DeviceBackend["startRecording"]>
  ): ReturnType<DeviceBackend["startRecording"]> {
    return this.target(args[0]).startRecording(...args);
  }

  stopRecording(
    ...args: Parameters<DeviceBackend["stopRecording"]>
  ): ReturnType<DeviceBackend["stopRecording"]> {
    return this.target(args[0]).stopRecording(...args);
  }

  describeUi(
    ...args: Parameters<DeviceBackend["describeUi"]>
  ): ReturnType<DeviceBackend["describeUi"]> {
    return this.target(args[0]).describeUi(...args);
  }

  geometry(...args: Parameters<DeviceBackend["geometry"]>): ReturnType<DeviceBackend["geometry"]> {
    return this.target(args[0]).geometry(...args);
  }

  attachStream(
    ...args: Parameters<DeviceBackend["attachStream"]>
  ): ReturnType<DeviceBackend["attachStream"]> {
    return this.target(args[0]).attachStream(...args);
  }

  detachStream(
    ...args: Parameters<DeviceBackend["detachStream"]>
  ): ReturnType<DeviceBackend["detachStream"]> {
    return this.target(args[0]).detachStream(...args);
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([this.ios.dispose(), this.android.dispose()]);
  }
}
