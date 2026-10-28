/**
 * Which service manager runs a node, apart from the service code itself: the database owner
 * lock and update detection ask this on every start, and should not load how services are
 * installed.
 */
export type NodeServicePlatform = "launchd" | "systemd";

export function nodeServicePlatform(
  platform: NodeJS.Platform = process.platform,
): NodeServicePlatform | null {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  return null;
}

/**
 * The service manager that started this process as a node service, or `null`.
 * `RYCO_SERVICE_LABEL` alone does not tell: everything the service starts
 * inherits it, provider sessions and the commands their agents run included.
 * launchd starts its jobs itself, so a job's parent is pid 1; systemd 248+
 * names the process it started in `SYSTEMD_EXEC_PID` (older versions set none,
 * and the label decides alone).
 */
export function nodeServiceManagerOfProcess(facts: {
  readonly serviceLabel: string | undefined;
  readonly platform: NodeJS.Platform;
  readonly pid: number;
  readonly parentPid: number;
  readonly systemdExecPid: string | undefined;
}): NodeServicePlatform | null {
  if (!facts.serviceLabel) return null;
  const manager = nodeServicePlatform(facts.platform);
  if (manager === "launchd" && facts.parentPid !== 1) return null;
  if (
    manager === "systemd" &&
    facts.systemdExecPid !== undefined &&
    facts.systemdExecPid.trim() !== String(facts.pid)
  ) {
    return null;
  }
  return manager;
}
