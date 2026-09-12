import { Context } from "effect";

import type { DeviceManager } from "../DeviceManager.ts";

export interface DeviceServiceShape {
  /**
   * True for local macOS simulators or configured SSH device hosts. Callers
   * use this to expose the same policy-gated tools on Linux coding nodes.
   */
  readonly supported: boolean;
  readonly manager: DeviceManager;
}

export class DeviceService extends Context.Service<DeviceService, DeviceServiceShape>()(
  "ryco/device/Services/DeviceService",
) {}
