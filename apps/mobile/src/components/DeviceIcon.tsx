import Svg, { Rect, Path } from "react-native-svg";
import type { EnvironmentId, EnvironmentMachineKind } from "@ryco/contracts";
import {
  inferEnvironmentMachineKind,
  resolveEnvironmentMachineKind,
} from "@ryco/shared/environmentIcon";
import {
  IconCloud,
  IconDeviceDesktop,
  IconDeviceLaptop,
  IconServer,
  IconTerminal2,
  IconBrandWindows,
} from "@tabler/icons-react-native";
import { useEnvironmentServerConfigs } from "../state/environmentServerConfigs";
import { useThemeColor } from "../lib/useThemeColor";

export function EnvironmentMachineIcon({
  kind,
  size = 20,
}: {
  kind: EnvironmentMachineKind;
  size?: number;
}) {
  const color = useThemeColor("--color-icon");
  if (kind === "mini-pc" || kind === "workstation")
    return (
      <Svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color as string}
        strokeWidth={1.75}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Rect
          x={kind === "mini-pc" ? 3 : 5}
          y={kind === "mini-pc" ? 8 : 3}
          width={kind === "mini-pc" ? 18 : 14}
          height={kind === "mini-pc" ? 9 : 18}
          rx={3}
        />
        <Path
          d={kind === "mini-pc" ? "M7 13h3m7 0h.01" : "M9 8h6M9 11h6m-3 6h.01"}
          strokeLinecap="round"
        />
      </Svg>
    );
  const Icon = {
    laptop: IconDeviceLaptop,
    desktop: IconDeviceDesktop,
    server: IconServer,
    cloud: IconCloud,
    linux: IconTerminal2,
    windows: IconBrandWindows,
  }[kind];
  return (
    <Icon
      size={size}
      color={color as string}
      strokeWidth={1.75}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}

export function DeviceIcon({
  environmentId,
  label,
  platformOs,
  size,
}: {
  environmentId: EnvironmentId;
  label?: string | undefined;
  platformOs?: string | undefined;
  size?: number;
}) {
  const config = useEnvironmentServerConfigs().get(environmentId);
  return (
    <EnvironmentMachineIcon
      kind={
        config
          ? resolveEnvironmentMachineKind(config)
          : inferEnvironmentMachineKind(platformOs, label)
      }
      {...(size === undefined ? {} : { size })}
    />
  );
}
