import { useIsFocused, type StaticScreenProps } from "@react-navigation/native";

import { useDirectoryPresenceDemand } from "../../hostedHub/directoryDemand";
import { NodesScreen } from "../nodes/NodesScreen";

type ConnectionsRouteScreenProps = StaticScreenProps<
  | {
      /** Opens this machine's own page in the sheet (Hub node or paired directly). */
      readonly environmentId?: string | string[];
    }
  | undefined
>;

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * The Machines surface — the one place a machine is managed rather than
 * inhabited: the list of machines, and per machine one page with its
 * connection, settings, access and appearance.
 *
 * It stays the target of the `connections` deep link and of native pushes, so
 * the route id and linking path keep their old spelling;
 * `connections?environmentId=…` opens one machine's page. While focused, it
 * keeps the node list's presence fresh.
 */
export function ConnectionsRouteScreen(props: ConnectionsRouteScreenProps) {
  useDirectoryPresenceDemand(useIsFocused());
  return <NodesScreen initialEnvironmentId={firstParam(props.route?.params?.environmentId)} />;
}
