import { resolveActivityChangedFiles } from "@ryco/client-runtime/state/session";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import type { SFSymbol } from "expo-symbols";
import { Fragment, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { useActivityPayloadOutput } from "../../rpc/useActivityPayloadOutput";
import type {
  ActivityFold,
  ActivityFoldThought,
  ActivityRow,
  ActivityTone,
} from "./threadActivityFold";

const TONE_ICON: Readonly<Record<ActivityTone, SFSymbol>> = {
  thinking: "text.bubble",
  tool: "terminal",
  info: "info.circle",
  error: "exclamationmark.triangle",
};

const TONE_TEXT: Readonly<Record<ActivityTone, string>> = {
  thinking: "text-foreground-muted",
  tool: "text-foreground-secondary",
  info: "text-foreground-muted",
  error: "text-danger-foreground",
};

function ToolRow(props: {
  readonly row: ActivityRow;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const [open, setOpen] = useState(false);
  const iconColor = useThemeColor("--color-icon-muted");
  const { row } = props;
  // The window sent a preview of this payload: read the full one while open.
  const fullOutput = useActivityPayloadOutput({
    environmentId: props.environmentId,
    threadId: props.threadId,
    activityId: open ? row.outputPreviewActivityId : null,
    payloadBytes: row.outputPreviewBytes,
  });
  const output =
    fullOutput.status === "loaded" ? fullOutput.output?.trim() || row.output : row.output;
  const exitCode =
    fullOutput.status === "loaded" ? (fullOutput.exitCode ?? row.exitCode) : row.exitCode;
  // A preview of a large edit lists only its first few files: the full payload completes them.
  const changedFiles = resolveActivityChangedFiles(row.changedFiles, fullOutput);
  const expandable = row.output !== null || row.changedFiles.length > 0;
  // Exit code 0 is falsy but meaningful — only a non-zero code is a failure.
  const failed = exitCode !== null && exitCode !== 0;

  return (
    <View className="gap-1">
      <Pressable
        accessibilityRole={expandable ? "button" : "text"}
        accessibilityLabel={
          expandable ? `${row.heading}. ${open ? "Hide" : "Show"} output.` : row.heading
        }
        accessibilityState={expandable ? { expanded: open } : undefined}
        disabled={!expandable}
        onPress={() => setOpen((current) => !current)}
        className="flex-row items-start gap-2 py-1 active:opacity-70"
      >
        <View className="mt-0.5 h-3.5 w-3.5 items-center justify-center">
          <SymbolView
            name={TONE_ICON[row.tone]}
            size={12}
            tintColor={iconColor as string}
            type="monochrome"
          />
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <View className="flex-row items-center gap-2">
            <Text
              className={cn("shrink text-xs font-ryco-medium", TONE_TEXT[row.tone])}
              numberOfLines={1}
            >
              {row.heading}
            </Text>
            {!row.completed ? (
              <Text className="text-2xs font-ryco-medium text-accent-strong">running</Text>
            ) : failed ? (
              <Text className="text-2xs font-ryco-bold text-danger-foreground">
                exit {exitCode}
              </Text>
            ) : null}
          </View>
          {row.command ? (
            <Text className="font-mono text-2xs text-foreground-tertiary" numberOfLines={1}>
              {row.command}
            </Text>
          ) : row.detail ? (
            <Text className="text-2xs text-foreground-tertiary" numberOfLines={1}>
              {row.detail}
            </Text>
          ) : null}
        </View>
        {expandable ? (
          <SymbolView
            name={open ? "chevron.up" : "chevron.down"}
            size={10}
            tintColor={iconColor as string}
            type="monochrome"
          />
        ) : null}
      </Pressable>

      {open && output ? (
        <View className="ml-5 gap-1 rounded-lg bg-subtle px-2.5 py-2">
          <Text className="font-mono text-2xs text-foreground-muted" selectable>
            {output}
          </Text>
          {fullOutput.status === "loading" ? (
            <Text className="text-2xs text-foreground-tertiary">Loading full output…</Text>
          ) : fullOutput.status === "error" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry loading the full output"
              onPress={fullOutput.retry}
              className="active:opacity-70"
            >
              <Text className="text-2xs text-danger-foreground">
                Couldn't load the full output. Tap to retry.
              </Text>
            </Pressable>
          ) : fullOutput.truncated ? (
            <Text className="text-2xs text-foreground-tertiary">
              Output is too large to show in full.
            </Text>
          ) : null}
        </View>
      ) : null}
      {open && changedFiles.length > 0 ? (
        <View className="ml-5 gap-0.5">
          {changedFiles.map((file) => (
            <Text
              key={file}
              className="font-mono text-2xs text-foreground-tertiary"
              numberOfLines={1}
            >
              {file}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** The agent's latest thought, a quiet gray line above the step it is on. */
function ThoughtRow(props: { readonly thought: ActivityFoldThought }) {
  return (
    <View
      accessible
      accessibilityLabel={`Thinking: ${props.thought.text}`}
      className="flex-row items-start gap-2 py-1"
    >
      <View className="h-3.5 w-3.5" />
      <Text className="min-w-0 flex-1 text-xs text-foreground-tertiary" numberOfLines={2}>
        {props.thought.text}
      </Text>
    </View>
  );
}

export function ThreadActivityFoldRow(props: {
  readonly fold: ActivityFold;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onToggle: () => void;
}) {
  const iconColor = useThemeColor("--color-icon-muted");
  const { fold } = props;

  // A recap already says what the steps were; only "Working…" and "Worked for" need a count.
  const stepCount =
    fold.durationLabel === null
      ? `${fold.rows.length} ${fold.rows.length === 1 ? "step" : "steps"}`
      : null;

  return (
    <View className="mx-4 my-0.5">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${fold.label}. ${fold.rows.length} ${
          fold.rows.length === 1 ? "step" : "steps"
        }. ${fold.expanded ? "Collapse" : "Expand"}.`}
        accessibilityState={{ expanded: fold.expanded }}
        onPress={props.onToggle}
        hitSlop={{ top: 4, bottom: 4 }}
        className="min-h-8 flex-row items-center gap-1.5 rounded-lg py-1 pr-2 active:opacity-60"
      >
        <SymbolView
          name={fold.expanded ? "chevron.down" : "chevron.right"}
          size={9}
          tintColor={iconColor as string}
          type="monochrome"
        />
        <Text className="shrink text-xs text-foreground-muted" numberOfLines={1}>
          {fold.label}
        </Text>
        {fold.durationLabel !== null || stepCount !== null ? (
          <Text className="text-2xs text-foreground-tertiary">
            {fold.durationLabel ?? stepCount}
          </Text>
        ) : null}
      </Pressable>
      {fold.expanded ? (
        <View className="mb-1 ml-1 gap-0.5 pl-3">
          {fold.rows.map((row) => (
            <Fragment key={row.id}>
              {fold.liveThought?.beforeRowId === row.id ? (
                <ThoughtRow thought={fold.liveThought} />
              ) : null}
              <ToolRow row={row} environmentId={props.environmentId} threadId={props.threadId} />
            </Fragment>
          ))}
          {fold.liveThought && fold.liveThought.beforeRowId === null ? (
            <ThoughtRow thought={fold.liveThought} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
