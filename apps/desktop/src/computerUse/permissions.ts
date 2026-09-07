export interface NativePermissionSnapshot {
  accessibility: string;
  screenRecording: string;
  helperAvailable: boolean;
  checkedAt: string | null;
  error: string | null;
}

const statuses = new Set(["granted", "denied", "unknown", "not_required"]);
/** Deduplicate UI/focus checks without mixing permission status with app discovery. */
export class ComputerPermissionMonitor {
  private current: NativePermissionSnapshot = {
    accessibility: "unknown",
    screenRecording: "unknown",
    helperAvailable: false,
    checkedAt: null,
    error: null,
  };
  private inFlight: Promise<NativePermissionSnapshot> | null = null;
  private readonly probe: () => Promise<unknown>;
  constructor(probe: () => Promise<unknown>) {
    this.probe = probe;
  }
  state(): NativePermissionSnapshot {
    return this.current;
  }
  refresh(): Promise<NativePermissionSnapshot> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.read().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }
  private async read(): Promise<NativePermissionSnapshot> {
    try {
      const value = (await this.probe()) as {
        protocolVersion?: unknown;
        permissions?: { accessibility?: unknown; screenRecording?: unknown };
      };
      const accessibility = value?.permissions?.accessibility;
      const screenRecording = value?.permissions?.screenRecording;
      if (
        value?.protocolVersion !== 3 ||
        typeof accessibility !== "string" ||
        typeof screenRecording !== "string" ||
        !statuses.has(accessibility) ||
        !statuses.has(screenRecording)
      )
        throw new Error("Unsupported permission response");
      this.current = {
        accessibility,
        screenRecording,
        helperAvailable: true,
        checkedAt: new Date().toISOString(),
        error:
          accessibility === "unknown" || screenRecording === "unknown"
            ? "The native helper could not determine a permission. Check this build in system settings and retry."
            : null,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      this.current = {
        accessibility: "unknown",
        screenRecording: "unknown",
        helperAvailable: false,
        checkedAt: new Date().toISOString(),
        error:
          code === "ENOENT"
            ? "Native helper is missing. Run the desktop native build or reinstall Ryco."
            : code === "EACCES"
              ? "Native helper could not be launched. Check its executable permissions or reinstall Ryco."
              : "Native permission check failed. Retry or rebuild this desktop app. Browser control remains available.",
      };
    }
    return this.current;
  }
}
