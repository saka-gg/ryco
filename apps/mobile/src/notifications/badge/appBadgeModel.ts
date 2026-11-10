import { countNeedsYouByEnvironment } from "@ryco/client-runtime/state/threads";
import type { SidebarAutoSettleAfterDays } from "@ryco/contracts/settings";

import { buildInboxSections, type BuildInboxInput } from "../../features/inbox/inboxModel";
import {
  agentActivityThreads,
  isAgentActivityEnvironmentLive,
} from "../../liveActivity/agentActivityModel";
import type { AppBadgeCounts } from "./appBadge";

/**
 * The badge's counts from the Inbox as Home builds it (`useInboxSource`), by the rule the Live
 * Activity and the nodes' sealed counts use (`countNeedsYouByEnvironment`): every live machine
 * gets its count, 0 included.
 */
export function appBadgeCounts(input: {
  readonly source: Omit<BuildInboxInput, "autoSettleAfterDays" | "nowMs">;
  readonly autoSettleAfterDays: SidebarAutoSettleAfterDays | undefined;
  readonly nowMs: number;
}): AppBadgeCounts {
  const sections = buildInboxSections({
    ...input.source,
    autoSettleAfterDays: input.autoSettleAfterDays,
    nowMs: input.nowMs,
  });
  const needsYou = countNeedsYouByEnvironment(
    agentActivityThreads({
      sections,
      threads: input.source.threads,
      environments: input.source.environments,
    }),
    input.nowMs,
  );
  const live = new Map<string, number>();
  for (const environment of input.source.environments) {
    if (!isAgentActivityEnvironmentLive(environment)) continue;
    live.set(environment.environmentId, needsYou.get(environment.environmentId) ?? 0);
  }
  return {
    live,
    listed: input.source.environments.map((environment) => environment.environmentId),
  };
}
