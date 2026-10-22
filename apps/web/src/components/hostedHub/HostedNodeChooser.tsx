import { useShallow } from "zustand/react/shallow";

import { useHostedHubStore } from "../../hostedHub/state";
import { DeviceIcon } from "../DeviceIcon";
import { Button } from "../ui/button";
import { useHostedConnectionActions } from "./HostedConnectionControls";
import {
  nodeSelectionBlocked,
  nodeSelectionBlockedReason,
  selectableNodes,
  sortNodes,
} from "./HostedNodeDisplay.logic";

/**
 * The nodes a hosted page that acts on one node can be pointed at, for when the
 * selection cursor is on none yet: a reload or a new tab on a page whose
 * address names no node. A choice moves the cursor in place, through the same
 * select Settings' device switcher uses, and waits for a current directory and
 * a revalidated browser, as the directory's rows do. Renders nothing while no
 * node can be offered.
 */
export function HostedNodeChooser({ label }: { readonly label: string }) {
  const { nodes, directoryStatus, browserStatus } = useHostedHubStore(
    useShallow((state) => ({
      nodes: state.nodes,
      directoryStatus: state.directoryStatus,
      browserStatus: state.browserStatus,
    })),
  );
  const { switchNodeInPlace } = useHostedConnectionActions();
  const choices = sortNodes(selectableNodes(nodes));
  if (choices.length === 0) return null;
  return (
    <div role="group" aria-label={label} className="flex max-w-md flex-wrap justify-center gap-2">
      {choices.map((node) => {
        const blocked = { directoryStatus, browserStatus, node };
        return (
          <Button
            key={node.id}
            size="sm"
            variant="outline"
            disabled={nodeSelectionBlocked(blocked)}
            title={nodeSelectionBlockedReason(blocked) ?? undefined}
            onClick={() => void switchNodeInPlace(node)}
          >
            <DeviceIcon
              environmentId={node.environmentId}
              label={node.label}
              className="size-3.5 shrink-0"
            />
            <span className="truncate">{node.label}</span>
          </Button>
        );
      })}
    </div>
  );
}
