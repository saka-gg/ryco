import type { ReactNode } from "react";
import type { EnvironmentId } from "@ryco/contracts";
import { AnchoredMenu } from "../../components/AnchoredMenu";
import { DeviceIcon } from "../../components/DeviceIcon";
import type { ProjectEnvironment } from "../projects/projectsModel";

const connectionLabels = {
  connected: "Ready for changes",
  "read-only": "Read-only",
  reconnecting: "Reconnecting",
  offline: "Offline",
} as const;

export function NewTaskDeviceMenu(props: {
  readonly environments: ReadonlyArray<ProjectEnvironment>;
  readonly environmentId: EnvironmentId | null;
  readonly disabled: boolean;
  readonly onSelect: (environmentId: EnvironmentId) => void;
  readonly onClose: () => void;
  readonly children: (open: () => void) => ReactNode;
}) {
  return (
    <AnchoredMenu
      title="Devices"
      menuWidth={300}
      className="max-w-full shrink"
      actions={props.environments
        .toSorted(
          (a, b) =>
            Number(b.connectionState === "connected") - Number(a.connectionState === "connected"),
        )
        .map((environment) => ({
          id: environment.environmentId,
          title: environment.label,
          subtitle: connectionLabels[environment.connectionState],
          state: environment.environmentId === props.environmentId ? "on" : "off",
          attributes: { disabled: props.disabled || environment.connectionState !== "connected" },
        }))}
      renderIcon={(action) => {
        const environment = props.environments.find((entry) => entry.environmentId === action.id);
        return environment ? (
          <DeviceIcon
            environmentId={environment.environmentId}
            label={environment.label}
            size={22}
          />
        ) : null;
      }}
      onClose={props.onClose}
      onPressAction={({ nativeEvent }) => {
        const environment = props.environments.find(
          (entry) => entry.environmentId === nativeEvent.event,
        );
        if (!props.disabled && environment?.connectionState === "connected")
          props.onSelect(environment.environmentId);
      }}
    >
      {props.children}
    </AnchoredMenu>
  );
}
