import { selectCompletionReturnsByChildThreadId } from "@ryco/client-runtime/state/agentControl";
import {
  deriveThreadAgentPanelModel,
  deriveThreadSubagents,
  emptyAgentPanelModel,
  hasThreadAgentActivity,
  isThreadAgentSessionLive,
} from "@ryco/client-runtime/state/session";
import {
  subagentStopKey,
  type SubagentStopIdentity,
} from "@ryco/client-runtime/state/session/subagentStop";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import type { AgentControlProposal } from "@ryco/contracts/agent-control";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Alert, Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { useShallow } from "zustand/react/shallow";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  isArchivedThreadStub,
  selectDelegatedChildThreadsForThreadRef,
  useStore,
  type SidebarThreadSummary,
  type Thread,
} from "../../state/threadsRuntime";
import type { InboxEnvironment } from "../inbox/inboxModel";
import { stopThreadSubagent } from "./sessionActions";
import { startSubagentStop, subagentStopRequests } from "./subagentStopRequests";
import {
  buildThreadAgentsEntry,
  buildThreadAgentsSheetModel,
  threadAgentsSheetSummary,
  type ThreadAgentRow,
  type ThreadAgentsEntry,
  type ThreadAgentSection,
  type ThreadAgentsSheetInput,
  type ThreadAgentTone,
} from "./threadAgentsSheetModel";
import {
  chooseThreadAgentsSheetTask,
  closeThreadAgentsSheet,
  isThreadAgentsSheetMounted,
  openThreadAgentsSheet,
  THREAD_AGENTS_SHEET_CLOSED,
  threadAgentsSheetDismissed,
} from "./threadAgentsSheetState";

const DOT_CLASS: Readonly<Record<ThreadAgentTone, string>> = {
  working: "bg-accent",
  attention: "bg-warning",
  done: "bg-success",
  failed: "bg-danger-foreground",
  muted: "bg-foreground-tertiary",
};

const STATUS_TEXT_CLASS: Readonly<Record<ThreadAgentTone, string>> = {
  working: "text-accent-strong",
  attention: "text-warning",
  done: "text-foreground-tertiary",
  failed: "text-danger-foreground",
  muted: "text-foreground-tertiary",
};

const NO_CHILDREN: ReadonlyArray<SidebarThreadSummary> = [];

/** Everything the sheet lists that does not tick: the chat's agents and its delegated tasks. */
function useThreadAgentsSource(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly thread: Thread | undefined;
  readonly agentControlProposals: ReadonlyArray<AgentControlProposal>;
}): Pick<ThreadAgentsSheetInput, "panel" | "delegatedChildren" | "completionReturns"> {
  const activities = input.thread?.activities;
  // The liveness word, not the session: a session update that keeps it never re-derives.
  const sessionLive = isThreadAgentSessionLive(input.thread?.session);
  const parentTurnState = input.thread?.latestTurn?.state ?? null;
  // The same fold-and-derive composition as web's Agents panel, skipped while the chat's
  // activities hold nothing an agent derives from (most chats, on every streamed update).
  const panel = useMemo(() => {
    if (activities === undefined || !hasThreadAgentActivity(activities)) {
      return emptyAgentPanelModel();
    }
    return deriveThreadAgentPanelModel({
      activities,
      transcriptSubagents: deriveThreadSubagents(activities, { sessionLive, parentTurnState }),
      sessionLive,
    });
  }, [activities, parentTurnState, sessionLive]);
  // Shallow: without the parent's shell the store answers with a fresh array each time.
  const childRows = useStore(
    useShallow((state) =>
      selectDelegatedChildThreadsForThreadRef(
        state,
        scopeThreadRef(input.environmentId, input.threadId),
      ),
    ),
  );
  const delegatedChildren = useMemo(() => {
    const full = childRows.filter(
      (thread): thread is SidebarThreadSummary => !isArchivedThreadStub(thread),
    );
    return full.length > 0 ? full : NO_CHILDREN;
  }, [childRows]);
  // Where each delegated task's result to this chat stands, as web's dock reads it.
  const completionReturns = useMemo(
    () => selectCompletionReturnsByChildThreadId(input.agentControlProposals, input.threadId),
    [input.agentControlProposals, input.threadId],
  );
  return { panel, delegatedChildren, completionReturns };
}

/** The thread screen's way into the sheet: how many agents work, or worked, for this chat. */
export function ThreadAgentsButton(props: {
  readonly entry: ThreadAgentsEntry;
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor("--color-icon-muted");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.entry.accessibilityLabel}
      onPress={props.onPress}
      className="mx-4 mb-1 min-h-9 flex-row items-center gap-2 self-start rounded-full border border-border bg-card-translucent px-3 py-1.5 active:bg-card-alt"
    >
      <View
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          props.entry.live ? DOT_CLASS.working : DOT_CLASS.muted,
        )}
      />
      <Text
        className={cn(
          "text-xs font-ryco-medium",
          props.entry.live ? "text-accent-strong" : "text-foreground-muted",
        )}
      >
        {props.entry.label}
      </Text>
      <SymbolView
        name="chevron.right"
        size={10}
        tintColor={iconColor as string}
        type="monochrome"
      />
    </Pressable>
  );
}

/** One agent or delegated task: what it is, its status and time, and what it is doing. */
export function ThreadAgentRowView(props: {
  readonly row: ThreadAgentRow;
  /** A hairline above every row but a card's first. */
  readonly divided: boolean;
  readonly expanded: boolean;
  readonly stopping: boolean;
  readonly onPress: () => void;
  readonly onStop: () => void;
}) {
  const iconColor = useThemeColor("--color-icon-muted");
  const { row } = props;
  const opensThread = row.childThreadId !== null;
  const details = props.expanded ? row.details : null;
  const meta = [row.statusLabel, row.elapsed].filter(Boolean).join(" · ");
  return (
    <View className={cn(props.divided && "border-t border-border")}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${row.label}. ${meta}.${row.activity ? ` ${row.activity}.` : ""}`}
        accessibilityHint={
          opensThread ? "Opens the task" : props.expanded ? "Hides details" : "Shows details"
        }
        accessibilityState={opensThread ? undefined : { expanded: props.expanded }}
        onPress={props.onPress}
        className="min-h-14 flex-row items-start gap-3 px-4 py-3 active:bg-subtle"
      >
        <View className={cn("mt-1.5 h-2 w-2 rounded-full", DOT_CLASS[row.tone])} />
        <View className="min-w-0 flex-1 gap-0.5">
          <View className="flex-row items-center gap-2">
            <Text className="shrink text-sm font-ryco-medium text-foreground" numberOfLines={1}>
              {row.label}
            </Text>
            {row.role ? (
              <Text className="shrink-0 text-2xs text-foreground-tertiary" numberOfLines={1}>
                {row.role}
              </Text>
            ) : null}
            <View className="flex-1" />
            <Text className={cn("shrink-0 text-2xs font-ryco-medium", STATUS_TEXT_CLASS[row.tone])}>
              {meta}
            </Text>
          </View>
          {row.activity ? (
            <Text
              className={cn(
                "text-xs",
                row.activityFailed ? "text-danger-foreground" : "text-foreground-muted",
              )}
              numberOfLines={props.expanded ? undefined : 2}
            >
              {row.activity}
            </Text>
          ) : null}
        </View>
        <SymbolView
          name={opensThread ? "chevron.right" : props.expanded ? "chevron.up" : "chevron.down"}
          size={11}
          tintColor={iconColor as string}
          type="monochrome"
        />
      </Pressable>
      {details ? (
        <View className="gap-1.5 px-4 pb-3 pl-9">
          {details.title ? (
            <Text className="text-xs text-foreground-secondary" selectable>
              {details.title}
            </Text>
          ) : null}
          {details.facts.length > 0 ? (
            <Text className="text-2xs text-foreground-tertiary">{details.facts.join(" · ")}</Text>
          ) : null}
          {details.recentActivity.map((line) => (
            <Text
              key={`${line.at}\u0000${line.summary}`}
              className="font-mono text-2xs text-foreground-tertiary"
              numberOfLines={2}
            >
              {line.summary}
            </Text>
          ))}
          {details.outcome && details.outcome.text !== row.activity ? (
            <Text
              className={cn(
                "text-xs",
                details.outcome.failed ? "text-danger-foreground" : "text-foreground-muted",
              )}
              selectable
            >
              {details.outcome.text}
            </Text>
          ) : null}
        </View>
      ) : null}
      {row.stop ? (
        <View className="flex-row px-4 pb-3 pl-9">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Stop ${row.label}`}
            accessibilityHint="Stops this agent only. The task keeps running."
            disabled={props.stopping}
            onPress={props.onStop}
            className="flex-row items-center gap-1.5 rounded-full border border-border px-3 py-1 active:bg-subtle disabled:opacity-40"
          >
            <SymbolView
              name="stop.fill"
              size={10}
              tintColor={iconColor as string}
              type="monochrome"
            />
            <Text className="text-xs font-ryco-medium text-foreground">
              {props.stopping ? "Stopping…" : "Stop"}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function SectionView(props: {
  readonly section: ThreadAgentSection;
  readonly expandedKeys: ReadonlySet<string>;
  /** Whether a stop for the row's agent is on its way. */
  readonly isStopping: (row: ThreadAgentRow) => boolean;
  readonly onRowPress: (row: ThreadAgentRow) => void;
  readonly onStop: (row: ThreadAgentRow, stop: SubagentStopIdentity) => void;
}) {
  return (
    <View className="gap-2">
      <View className="flex-row items-baseline gap-2 px-1">
        <Text className="shrink text-sm font-ryco-medium text-foreground-muted" numberOfLines={1}>
          {props.section.title}
        </Text>
        {props.section.status ? (
          <Text className="text-xs text-foreground-tertiary">{props.section.status}</Text>
        ) : null}
      </View>
      <View className="overflow-hidden rounded-2xl bg-card">
        {props.section.rows.map((row, index) => (
          <ThreadAgentRowView
            key={row.key}
            row={row}
            divided={index > 0}
            expanded={props.expandedKeys.has(row.key)}
            stopping={props.isStopping(row)}
            onPress={() => props.onRowPress(row)}
            onStop={() => {
              if (row.stop) props.onStop(row, row.stop);
            }}
          />
        ))}
      </View>
    </View>
  );
}

/**
 * Everything a chat set working, behind one control under its context bar: provider subagents
 * (Claude subagents, Codex collaboration agents, workflow members) with live elapsed time and
 * status, and the Ryco tasks it delegated, which open their own thread (Back returns here).
 * Renders nothing while the chat set no agents working. Key it by thread: its sheet state
 * belongs to one chat.
 */
export function ThreadAgents(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly thread: Thread | undefined;
  readonly environment: InboxEnvironment | null;
  /** The node takes changes now: Stop is offered only then. */
  readonly stopReady: boolean;
  /** The screen shows a cached or degraded snapshot (its header reads Offline). */
  readonly offline: boolean;
  /** The chat's Agent Control proposals, which carry its delegated tasks' result returns. */
  readonly agentControlProposals: ReadonlyArray<AgentControlProposal>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const source = useThreadAgentsSource(props);
  const [sheet, setSheet] = useState(THREAD_AGENTS_SHEET_CLOSED);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const runtimeSessionId = props.thread?.session?.runtimeSessionId ?? null;
  const model = useMemo(
    () =>
      buildThreadAgentsSheetModel({
        ...source,
        environment: props.environment ?? undefined,
        runtimeSessionId,
        stopReady: props.stopReady,
        offline: props.offline,
        nowMs,
      }),
    [nowMs, props.environment, props.offline, props.stopReady, runtimeSessionId, source],
  );
  const entry = buildThreadAgentsEntry(model);
  const hasAgents = entry !== null;
  // A chat that runs out of agents closes the sheet, so its next agent never reopens it.
  useEffect(() => {
    if (!hasAgents) setSheet(closeThreadAgentsSheet);
  }, [hasAgents]);
  // The clock ticks only while the sheet shows it; offline, nothing is live, so it stays put.
  const ticking = sheet.open && model.live > 0;
  useEffect(() => {
    if (!ticking) return undefined;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  // A stop stays pending, across sheets and reopenings, until its agent settles or it times out.
  const threadRef = useMemo(
    () => scopeThreadRef(props.environmentId, props.threadId),
    [props.environmentId, props.threadId],
  );
  const stopKeys = model.sections
    .flatMap((section) => section.rows)
    .flatMap((row) => (row.stop ? [subagentStopKey(threadRef, row.stop)] : []));
  const shownStopKeys = sheet.open ? stopKeys.join("\n") : "";
  const pendingStopKeys = useSyncExternalStore(subagentStopRequests.subscribe, () =>
    stopKeys.filter((key) => subagentStopRequests.isPending(key)).join("\n"),
  );
  // A stop that times out is reported only while its Stop shows.
  useEffect(() => {
    if (shownStopKeys === "") return undefined;
    const unwatch = shownStopKeys.split("\n").map((key) => subagentStopRequests.watch(key));
    return () => {
      for (const stopWatching of unwatch) stopWatching();
    };
  }, [shownStopKeys]);

  if (!isThreadAgentsSheetMounted(sheet, hasAgents)) return null;

  const close = () => setSheet(closeThreadAgentsSheet);
  const onRowPress = (row: ThreadAgentRow) => {
    if (row.childThreadId !== null) {
      // iOS reports the sheet gone (`onDismiss`); the task opens then, not under its slide.
      const next = chooseThreadAgentsSheetTask(row.childThreadId, Platform.OS === "ios");
      setSheet(next.state);
      if (next.openNow !== null) props.onOpenThread(next.openNow);
      return;
    }
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (!next.delete(row.key)) next.add(row.key);
      return next;
    });
  };
  const onDismiss = () => {
    const next = threadAgentsSheetDismissed(sheet);
    setSheet(next.state);
    if (next.openNow !== null) props.onOpenThread(next.openNow);
  };
  const isStopping = (row: ThreadAgentRow) =>
    row.stop !== null && pendingStopKeys.split("\n").includes(subagentStopKey(threadRef, row.stop));
  const onStop = (_row: ThreadAgentRow, stop: SubagentStopIdentity) => {
    startSubagentStop({
      registry: subagentStopRequests,
      key: subagentStopKey(threadRef, stop),
      send: () =>
        stopThreadSubagent(ensureEnvironmentApi(props.environmentId), props.threadId, stop),
      alert: ({ title, message }) => Alert.alert(title, message),
    });
  };

  return (
    <>
      {entry ? (
        <ThreadAgentsButton
          entry={entry}
          onPress={() => {
            setNowMs(Date.now());
            setSheet(openThreadAgentsSheet());
          }}
        />
      ) : null}
      <Modal
        visible={sheet.open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={close}
        onDismiss={onDismiss}
      >
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1 bg-screen"
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingTop: 12,
            paddingBottom: 40,
            gap: 18,
          }}
        >
          <View className="flex-row items-center gap-3">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close agents"
              onPress={close}
              className="h-11 min-w-11 items-center justify-center rounded-full px-2 active:bg-subtle"
            >
              <Text className="text-base font-ryco-medium text-foreground">Done</Text>
            </Pressable>
            <Text className="flex-1 text-center text-lg font-ryco-bold text-foreground">
              Agents
            </Text>
            <View className="h-11 min-w-11" />
          </View>
          <Text className="px-1 text-xs text-foreground-tertiary">
            {threadAgentsSheetSummary(model)}
          </Text>
          {model.sections.map((section) => (
            <SectionView
              key={section.key}
              section={section}
              expandedKeys={expandedKeys}
              isStopping={isStopping}
              onRowPress={onRowPress}
              onStop={onStop}
            />
          ))}
        </ScrollView>
      </Modal>
    </>
  );
}
