import {
  findCompletionReturnForChild,
  type AgentControlQueueState,
  type AgentControlStatusTone,
} from "@ryco/client-runtime/state/agentControl";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  selectSidebarThreadSummaryByRef,
  selectThreadAvailabilityByRef,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import type { ThreadLineage } from "@ryco/contracts/orchestration";
import { useMemo } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { useStore } from "../../state/threadsRuntime";
import {
  buildThreadOriginBreadcrumbModel,
  type ThreadOriginBreadcrumbModel,
} from "./threadOriginBreadcrumbModel";

const RESULT_TEXT_CLASS: Readonly<Record<AgentControlStatusTone, string>> = {
  pending: "text-accent-strong",
  info: "text-accent-strong",
  success: "text-success",
  danger: "text-danger-foreground",
  muted: "text-foreground-tertiary",
};

function lineageOf(
  state: Parameters<typeof selectSidebarThreadSummaryByRef>[0],
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ThreadLineage | null {
  return (
    selectSidebarThreadSummaryByRef(state, scopeThreadRef(environmentId, threadId))?.lineage ?? null
  );
}

function ownReturnOf(queue: AgentControlQueueState | null, threadId: ThreadId) {
  return queue === null ? null : findCompletionReturnForChild(queue, threadId);
}

/**
 * Where a delegated or forked thread came from, under the thread screen's context bar: a compact
 * link back to its parent ("From Fix login redirect loop") and, for delegated work, where its
 * result to that parent stands. Renders nothing on a thread nothing delegated or forked.
 */
export function ThreadOriginBreadcrumb(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The environment's Agent Control queue while Agent Control is on: it holds this child's return. */
  readonly agentControlQueue: AgentControlQueueState | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const lineage = useStore((state) => lineageOf(state, props.environmentId, props.threadId));
  const parentRef = useMemo(
    () => (lineage === null ? null : scopeThreadRef(props.environmentId, lineage.parentThreadId)),
    [lineage, props.environmentId],
  );
  const parentTitle = useStore((state) =>
    parentRef === null ? null : (selectSidebarThreadSummaryByRef(state, parentRef)?.title ?? null),
  );
  // Unknown until the environment's shell snapshot arrives: no link, and no claim it is gone.
  const parentAvailability = useStore((state) => selectThreadAvailabilityByRef(state, parentRef));
  const ownReturn = useMemo(
    () => ownReturnOf(props.agentControlQueue, props.threadId),
    [props.agentControlQueue, props.threadId],
  );
  const iconColor = String(useThemeColor("--color-icon-subtle"));
  const model = buildThreadOriginBreadcrumbModel({
    lineage,
    parentTitle,
    parentAvailability,
    ownReturn,
  });
  if (model === null) return null;
  const { parentThreadId } = model;
  const content = <ThreadOriginContent model={model} iconColor={iconColor} />;
  return parentThreadId !== null ? (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={model.accessibilityLabel}
      accessibilityHint="Opens the chat it came from"
      hitSlop={{ top: 6, bottom: 6 }}
      onPress={() => props.onOpenThread(parentThreadId)}
      className="mx-4 mb-1 min-h-8 flex-row items-center self-start rounded-full px-1 active:opacity-70"
    >
      {content}
    </Pressable>
  ) : (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={model.accessibilityLabel}
      className="mx-4 mb-1 min-h-8 flex-row items-center self-start px-1"
    >
      {content}
    </View>
  );
}

function ThreadOriginContent(props: {
  readonly model: ThreadOriginBreadcrumbModel;
  readonly iconColor: string;
}) {
  const { model } = props;
  const opens = model.parentThreadId !== null;
  return (
    <View className="shrink flex-row items-center gap-1.5">
      <SymbolView
        name={model.kind === "forked" ? "arrow.triangle.branch" : "arrow.up.left"}
        size={11}
        tintColor={props.iconColor}
        type="monochrome"
      />
      <Text className="shrink text-xs text-foreground-muted" numberOfLines={1}>
        {`${model.lead} `}
        <Text
          className={cn("font-ryco-medium", opens ? "text-foreground" : "text-foreground-muted")}
        >
          {model.parentTitle}
        </Text>
      </Text>
      {model.result ? (
        <Text
          className={cn("shrink-0 text-xs font-ryco-medium", RESULT_TEXT_CLASS[model.result.tone])}
          numberOfLines={1}
        >
          {`· ${model.result.text}`}
        </Text>
      ) : null}
      {opens ? (
        <SymbolView name="chevron.right" size={9} tintColor={props.iconColor} type="monochrome" />
      ) : null}
    </View>
  );
}
