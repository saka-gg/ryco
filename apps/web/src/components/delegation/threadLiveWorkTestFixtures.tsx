import { EnvironmentId, ThreadId } from "@ryco/contracts";

import { emptyAgentPanelModel } from "../../threadWorkspaceViewModel";
import { DelegationDock } from "./DelegationDock";
import { ThreadLiveWorkContext, type ThreadLiveWork } from "./threadLiveWork";

/** Background work that outlived its turn, with nothing running; override any field. */
export function makeThreadLiveWork(overrides: Partial<ThreadLiveWork> = {}): ThreadLiveWork {
  return {
    agentPanelModel: emptyAgentPanelModel(),
    work: { tasks: [], detailsOmitted: false },
    liveness: "monitoring",
    connected: true,
    mutationReady: true,
    stoppingAll: false,
    onStopAll: () => {},
    onStopTask: async () => {},
    onOpenAgents: () => {},
    onOpenAgent: () => {},
    ...overrides,
  };
}

/** The composer's dock for a thread that has only this live work. */
export function LiveWorkDock(props: { readonly liveWork: ThreadLiveWork | null }) {
  return (
    <ThreadLiveWorkContext value={props.liveWork}>
      <DelegationDock
        environmentId={EnvironmentId.make("live-work-dock-env")}
        threadId={ThreadId.make("live-work-dock-thread")}
      />
    </ThreadLiveWorkContext>
  );
}
