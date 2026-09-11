import type {
  EnvironmentMachineKind,
  ExecutionEnvironmentDescriptor,
  ServerConfig,
} from "@ryco/contracts";

export const ENVIRONMENT_MACHINE_LABELS: Record<EnvironmentMachineKind, string> = {
  laptop: "Laptop",
  desktop: "Desktop",
  "mini-pc": "Mini PC",
  workstation: "Workstation",
  server: "Server",
  cloud: "Cloud",
  linux: "Linux / WSL",
  windows: "Windows",
};

/** Reuse existing platform/name metadata; icon selection must never probe permissions or delay startup. */
export function inferEnvironmentMachineKind(
  platform: string | undefined,
  label = "",
): EnvironmentMachineKind {
  const name = label.toLowerCase().replaceAll(/[\s_-]+/g, "");
  if (/macmini|minipc/.test(name)) return "mini-pc";
  if (/macstudio|workstation/.test(name)) return "workstation";
  if (/macbook|notebook|laptop/.test(name)) return "laptop";
  if (/imac|macpro|desktop/.test(name)) return "desktop";
  if (platform === "windows" || platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "desktop";
  return "server";
}

export function resolveEnvironmentMachineKind(
  config?: Pick<ServerConfig, "settings" | "environment"> | null,
  fallback?: Pick<ExecutionEnvironmentDescriptor, "label" | "platform"> | null,
): EnvironmentMachineKind {
  const environment = config?.environment ?? fallback;
  return (
    config?.settings.environmentIcon ??
    environment?.platform.machine ??
    inferEnvironmentMachineKind(environment?.platform.os, environment?.label)
  );
}
