import type { EnvironmentMachineKind } from "@ryco/contracts";
import {
  CloudIcon,
  LaptopIcon,
  MonitorIcon,
  ServerIcon,
  TerminalIcon,
  Grid2X2Icon,
} from "lucide-react";
export function EnvironmentMachineIcon({
  kind,
  className,
}: {
  kind: EnvironmentMachineKind;
  className?: string | undefined;
}) {
  if (kind === "mini-pc" || kind === "workstation")
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        className={className}
        aria-hidden="true"
        data-device-icon={kind}
      >
        <rect
          x={kind === "mini-pc" ? 3 : 5}
          y={kind === "mini-pc" ? 8 : 3}
          width={kind === "mini-pc" ? 18 : 14}
          height={kind === "mini-pc" ? 9 : 18}
          rx="3"
        />
        <path
          d={kind === "mini-pc" ? "M7 13h3m7 0h.01" : "M9 8h6M9 11h6m-3 6h.01"}
          strokeLinecap="round"
        />
      </svg>
    );
  const Icon = {
    laptop: LaptopIcon,
    desktop: MonitorIcon,
    server: ServerIcon,
    cloud: CloudIcon,
    linux: TerminalIcon,
    windows: Grid2X2Icon,
  }[kind];
  return <Icon className={className} aria-hidden="true" data-device-icon={kind} />;
}
