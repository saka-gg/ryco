import {
  deriveThreadAgentPanelModel,
  deriveThreadSubagents,
  isThreadAgentSessionLive,
} from "@ryco/client-runtime/state/session";
import type { SubagentStopIdentity } from "@ryco/client-runtime/state/session/subagentStop";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { useEffect, useMemo, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, View } from "react-native";
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
import {
  buildThreadAgentsEntry,
  buildThreadAgentsSheetModel,
  type ThreadAgentRow,
  type ThreadAgentsEntry,
  type ThreadAgentSection,
  type ThreadAgentsSheetInput,
  type ThreadAgentTone,
} from "./threadAgentsSheetModel";

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
}): Pick<ThreadAgentsSheetInput, "panel" | "delegatedChildren"> {
  const activities = input.thread?.activities;
  const session = input.thread?.session;
  const parentTurnState = input.thread?.latestTurn?.state ?? null;
  // The same fold-and-derive composition as web's Agents panel.
  const panel = useMemo(() => {
    const sessionLive = isThreadAgentSessionLive(session);
    return deriveThreadAgentPanelModel({
      activities: activities ?? [],
      transcriptSubagents: deriveThreadSubagents(activities ?? [], {
        sessionLive,
        parentTurnState,
      }),
      sessionLive,
    });
  }, [activities, parentTurnState, session]);
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
  return { panel, delegatedChildren };
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
                row.tone === "failed" ? "text-danger-foreground" : "text-foreground-muted",
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
  readonly stoppingKeys: ReadonlySet<string>;
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
            stopping={props.stoppingKeys.has(row.key)}
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
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const source = useThreadAgentsSource(props);
  const [visible, setVisible] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [stoppingKeys, setStoppingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const runtimeSessionId = props.thread?.session?.runtimeSessionId ?? null;
  const model = useMemo(
    () =>
      buildThreadAgentsSheetModel({
        ...source,
        environment: props.environment ?? undefined,
        runtimeSessionId,
        stopReady: props.stopReady,
        nowMs,
      }),
    [nowMs, props.environment, props.stopReady, runtimeSessionId, source],
  );
  const entry = buildThreadAgentsEntry(model);
  // The clock ticks only while the sheet shows it; the control reads counts alone.
  const ticking = visible && model.live > 0;
  useEffect(() => {
    if (!ticking) return undefined;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  if (entry === null) return null;

  const close = () => setVisible(false);
  const onRowPress = (row: ThreadAgentRow) => {
    if (row.childThreadId !== null) {
      close();
      props.onOpenThread(row.childThreadId);
      return;
    }
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (!next.delete(row.key)) next.add(row.key);
      return next;
    });
  };
  const onStop = (row: ThreadAgentRow, stop: SubagentStopIdentity) => {
    setStoppingKeys((current) => new Set(current).add(row.key));
    // A promise chain, not try/finally: React Compiler cannot compile a finally clause.
    void Promise.resolve()
      .then(() =>
        stopThreadSubagent(ensureEnvironmentApi(props.environmentId), props.threadId, stop),
      )
      .catch((error: unknown) => {
        Alert.alert(
          "Could not stop the agent",
          error instanceof Error ? error.message : "The request failed.",
        );
      })
      .then(() => {
        // The row itself settles once the provider reports the task stopped.
        setStoppingKeys((current) => {
          const next = new Set(current);
          next.delete(row.key);
          return next;
        });
      });
  };

  return (
    <>
      <ThreadAgentsButton
        entry={entry}
        onPress={() => {
          setNowMs(Date.now());
          setVisible(true);
        }}
      />
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={close}
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
            {model.live > 0
              ? `${model.live} active · ${model.total} in all`
              : `${model.total} in all`}
          </Text>
          {model.sections.map((section) => (
            <SectionView
              key={section.key}
              section={section}
              expandedKeys={expandedKeys}
              stoppingKeys={stoppingKeys}
              onRowPress={onRowPress}
              onStop={onStop}
            />
          ))}
        </ScrollView>
      </Modal>
    </>
  );
}
