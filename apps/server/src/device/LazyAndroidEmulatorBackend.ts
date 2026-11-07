/**
 * The Android adapter as the platform router sees it at boot: one small
 * object that loads `AndroidEmulatorBackend` (and through it scrcpy, the UI
 * reader, logs and testing) on the first Android call, usually the first
 * device list. A server nobody opens the device pane on never loads it.
 *
 * One instance per host, like the adapter it stands for: SDK failures,
 * transport identities and ownership stay pinned across every caller.
 *
 * @module device/LazyAndroidEmulatorBackend
 */
import type { DeviceGeometry } from "@ryco/contracts";

import type { AndroidEmulatorBackend, AndroidEmulatorOptions } from "./AndroidEmulatorBackend.ts";
import type { DeviceBackend } from "./DeviceBackend.ts";

type Forwarded<K extends keyof DeviceBackend> =
  NonNullable<DeviceBackend[K]> extends (...args: infer A) => infer R ? (...args: A) => R : never;

export class LazyAndroidEmulatorBackend implements DeviceBackend {
  readonly platform = "android-emulator" as const;
  private loaded: AndroidEmulatorBackend | null = null;
  private loading: Promise<AndroidEmulatorBackend> | null = null;
  private disposed = false;
  private readonly options: AndroidEmulatorOptions;

  constructor(options: AndroidEmulatorOptions = {}) {
    this.options = options;
  }

  private backend(): Promise<AndroidEmulatorBackend> {
    if (this.loaded) return Promise.resolve(this.loaded);
    this.loading ??= import("./AndroidEmulatorBackend.ts").then((module) => {
      this.loaded = new module.AndroidEmulatorBackend(this.options);
      return this.loaded;
    });
    return this.loading;
  }

  private forward<K extends keyof DeviceBackend>(method: K): Forwarded<K> {
    return ((...args: unknown[]) =>
      this.backend().then((backend: DeviceBackend) =>
        (backend[method] as (...values: unknown[]) => unknown).apply(backend, args),
      )) as Forwarded<K>;
  }

  readonly availability = this.forward("availability");
  readonly listDevices = this.forward("listDevices");
  readonly boot = this.forward("boot");
  readonly shutdown = this.forward("shutdown");
  readonly install = this.forward("install");
  readonly launch = this.forward("launch");
  readonly testing = this.forward("testing");
  readonly detail = this.forward("detail");
  readonly readLogs = this.forward("readLogs");
  readonly openUrl = this.forward("openUrl");
  readonly tap = this.forward("tap");
  readonly swipe = this.forward("swipe");
  readonly typeText = this.forward("typeText");
  readonly keyEvent = this.forward("keyEvent");
  readonly pressButton = this.forward("pressButton");
  readonly touch = this.forward("touch");
  readonly paste = this.forward("paste");
  readonly setOrientation = this.forward("setOrientation");
  readonly screenshot = this.forward("screenshot");
  readonly startRecording = this.forward("startRecording");
  readonly stopRecording = this.forward("stopRecording");
  readonly describeUi = this.forward("describeUi");
  readonly attachStream = this.forward("attachStream");
  readonly requestKeyframe = this.forward("requestKeyframe");

  // Nothing to fence before the adapter exists; afterwards it fences itself.
  suspendTesting(udid?: string): () => void {
    return this.loaded?.suspendTesting(udid) ?? (() => {});
  }

  // Synchronous reads: there is no geometry or stream before the adapter loads.
  geometry(udid: string): DeviceGeometry | null {
    return this.loaded?.geometry(udid) ?? null;
  }

  uprightFrames(_udid: string): boolean {
    return true;
  }

  previewMode(udid: string): "video" | "screenshots" | null {
    return this.loaded?.previewMode(udid) ?? null;
  }

  async detachStream(udid: string): Promise<void> {
    await this.loaded?.detachStream(udid);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const backend = this.loaded ?? (await this.loading?.catch(() => null));
    await backend?.dispose();
  }
}
