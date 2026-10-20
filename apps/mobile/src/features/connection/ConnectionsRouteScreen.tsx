import { useIsFocused } from "@react-navigation/native";

import { useDirectoryPresenceDemand } from "../../hostedHub/directoryDemand";
import { NodesScreen } from "../nodes/NodesScreen";

/**
 * The Machines surface — the one place a machine is managed rather than
 * inhabited. Wave 4 removed the Home mode that used to own this list, so this
 * route is now the surface itself, not a compatibility shim for it.
 *
 * It stays the target of the `connections` deep link and of native pushes, so
 * the route id and linking path keep their old spelling. While focused, it
 * keeps the node list's presence fresh.
 */
export function ConnectionsRouteScreen() {
  useDirectoryPresenceDemand(useIsFocused());
  return <NodesScreen />;
}
