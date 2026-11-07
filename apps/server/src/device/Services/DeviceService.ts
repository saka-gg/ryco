import type { DeviceSshHost } from "@ryco/contracts";
import { Context } from "effect";

import type { DeviceManager } from "../DeviceManager.ts";

export interface DeviceServiceShape {
  /**
   * True for local macOS simulators or configured SSH device hosts. Callers
   * use this to expose the same policy-gated tools on Linux coding nodes.
   */
  readonly supported: boolean;
  readonly manager: DeviceManager;
  /**
   * Apply the SSH device hosts from the node's settings, beside the
   * read-only ones from RYCO_DEVICE_HOSTS_FILE, without a restart.
   */
  readonly configureSshHosts?: (hosts: readonly DeviceSshHost[]) => Promise<void>;
}

export class DeviceService extends Context.Service<DeviceService, DeviceServiceShape>()(
  "ryco/device/Services/DeviceService",
) {}
