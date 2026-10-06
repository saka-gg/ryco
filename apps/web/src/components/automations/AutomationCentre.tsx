import type { EnvironmentId, ProjectId } from "@ryco/contracts";

import { AutomationCentreView } from "./AutomationCentreView";
import { useAutomationCentre } from "./useAutomationCentre";

export function AutomationCentre({
  environmentId,
  projectId,
  embedded = false,
  disabledReasonShownByHost = false,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  /** See `AutomationCentreViewProps.embedded`. */
  embedded?: boolean;
  /** See `AutomationCentreViewProps.disabledReasonShownByHost`. */
  disabledReasonShownByHost?: boolean;
}) {
  const centre = useAutomationCentre(environmentId, projectId);
  return (
    <AutomationCentreView
      environmentId={environmentId}
      projectId={projectId}
      snapshot={centre.snapshot}
      providers={centre.providers}
      busy={centre.busy}
      error={centre.error}
      disabledReason={centre.disabledReason}
      onDecision={centre.decide}
      onRefresh={centre.refresh}
      onCommand={centre.command}
      embedded={embedded}
      disabledReasonShownByHost={disabledReasonShownByHost}
    />
  );
}
