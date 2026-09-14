import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../../components/AppText";
import {
  IconActivity,
  IconClock,
  IconMessages,
  IconTool,
  IconFileDiff,
  IconGitPullRequest,
} from "@tabler/icons-react-native";
import { StatisticsChart } from "./StatisticsCharts";
import type { StatisticsSnapshot } from "@ryco/contracts";
import {
  aggregateByProject,
  buildProjectTitleMap,
  buildTimeSeries,
  filterBuckets,
  sumTotals,
  type StatRange,
} from "@ryco/client-runtime/usage";
import { ActivityHeatmap } from "./ActivityHeatmap";
import {
  Choice,
  MiniMetric,
  Toggle,
  integer,
  useStatisticsPalette,
  Note,
  Panel,
  compact,
  duration,
} from "./StatisticsParts";

export function ActivityStatistics({
  snapshot,
  range,
}: {
  snapshot: StatisticsSnapshot;
  range: StatRange;
}) {
  const colors = useStatisticsPalette();
  const [projectId, setProjectId] = useState("all");
  const [modelKey, setModelKey] = useState("all");
  const [metric, setMetric] = useState("turns");
  const models = [
    ...new Map(
      snapshot.dailyBuckets.map((bucket) => [
        JSON.stringify([bucket.model, bucket.provider ?? null]),
        { model: bucket.model, provider: bucket.provider },
      ]),
    ).entries(),
  ];
  const selectedModel = models.find(([key]) => key === modelKey)?.[1];
  const buckets = filterBuckets(snapshot, {
    range,
    projectId: projectId === "all" ? null : projectId,
    model: selectedModel?.model ?? null,
    provider: selectedModel?.provider ?? null,
  });
  const totals = sumTotals(buckets);
  const days = buildTimeSeries(snapshot, buckets, range);
  const projects = aggregateByProject(buckets, buildProjectTitleMap(snapshot)).toSorted(
    (a, b) => b.activeMs - a.activeMs,
  );
  const valueForDay = (day: (typeof days)[number]) =>
    metric === "turns" ? day.turns : metric === "files" ? day.filesChanged : day.activeMs;
  const activeDays = days.filter((day) => valueForDay(day) > 0).length;
  let streak = 0;
  for (const day of days.toReversed()) {
    if (valueForDay(day) > 0) streak++;
    else break;
  }
  const busiest = days.toSorted((a, b) => valueForDay(b) - valueForDay(a))[0];
  return (
    <View style={{ gap: 32 }}>
      <View className="gap-2">
        <Choice
          label="Project"
          value={projectId}
          onChange={setProjectId}
          options={[
            { value: "all", label: "All projects" },
            ...snapshot.projects.map((project) => ({ value: project.id, label: project.title })),
          ]}
        />
        <Choice
          label="Model"
          value={modelKey}
          onChange={setModelKey}
          options={[
            { value: "all", label: "All models" },
            ...models.map(([value, model]) => ({
              value,
              label: `${model.model}${model.provider ? ` · ${model.provider}` : ""}`,
            })),
          ]}
        />
      </View>
      <Note>
        Work observed by Ryco on this device. Activity uses UTC days; external CLI sessions appear
        in Usage.
      </Note>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        {[
          {
            label: "Active time",
            value: duration(totals.activeMs),
            sub: `${compact(totals.totalTokens)} observed tokens`,
            icon: IconClock,
          },
          {
            label: "Turns",
            value: integer(totals.turns),
            sub: "Completed agent turns",
            icon: IconActivity,
          },
          {
            label: "Chats",
            value: integer(totals.threadsCreated),
            sub: "Conversations started",
            icon: IconMessages,
          },
          {
            label: "Tool uses",
            value: integer(totals.toolUses),
            sub: "Observed invocations",
            icon: IconTool,
          },
          {
            label: "Files changed",
            value: integer(totals.filesChanged),
            sub: `+${integer(totals.additions)} / −${integer(totals.deletions)} lines`,
            icon: IconFileDiff,
          },
        ].map((item) => (
          <View
            key={item.label}
            style={{
              width: "48%",
              flexGrow: 1,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.card,
              borderRadius: 12,
              padding: 16,
              gap: 8,
            }}
          >
            <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
              <item.icon size={14} color={colors.muted} />
              <Text
                style={{
                  fontSize: 11,
                  letterSpacing: 0.66,
                  textTransform: "uppercase",
                  color: colors.muted,
                }}
              >
                {item.label}
              </Text>
            </View>
            <Text
              className="font-ryco-bold"
              numberOfLines={1}
              adjustsFontSizeToFit
              style={{ fontSize: 24 }}
            >
              {item.value}
            </Text>
            <Note>{item.sub}</Note>
          </View>
        ))}
      </View>
      <Panel
        title="Activity rhythm"
        icon={<IconActivity size={14} color={colors.muted} />}
        action={
          <Toggle
            label="Activity metric"
            value={metric}
            onChange={setMetric}
            options={[
              { value: "turns", label: "Turns" },
              { value: "activeMs", label: "Time" },
              { value: "files", label: "Files" },
            ]}
          />
        }
      >
        <ActivityHeatmap
          points={days.map((day) => ({ date: day.date, first: valueForDay(day) }))}
          format={metric === "activeMs" ? duration : integer}
        />
        <View
          style={{
            flexDirection: "row",
            gap: 12,
            borderTopWidth: 1,
            borderColor: colors.border,
            paddingTop: 16,
          }}
        >
          <MiniMetric label="Active days" value={integer(activeDays)} />
          <MiniMetric label="Current streak" value={`${streak}d`} />
          <MiniMetric
            label="Busiest UTC day"
            value={
              busiest && valueForDay(busiest) > 0
                ? `${busiest.date.slice(5)} · ${metric === "activeMs" ? duration(valueForDay(busiest)) : integer(valueForDay(busiest))}`
                : "—"
            }
          />
        </View>
      </Panel>
      <Panel title="Projects" icon={<IconActivity size={14} color={colors.muted} />}>
        <ProjectBars projects={projects} metric={metric} />
      </Panel>
      <Panel title="Code changes" icon={<IconFileDiff size={14} color={colors.muted} />}>
        <View style={{ flexDirection: "row", gap: 16 }}>
          <MiniMetric label="Files" value={integer(totals.filesChanged)} />
          <MiniMetric label="Added" value={`+${integer(totals.additions)}`} tone="positive" />
          <MiniMetric label="Removed" value={`−${integer(totals.deletions)}`} tone="negative" />
        </View>
        <StatisticsChart
          kind="changes"
          points={days.map((day) => ({
            date: day.date,
            first: day.additions,
            second: day.deletions,
          }))}
          format={integer}
        />
      </Panel>
      <Panel
        title="Source control · all time"
        icon={<IconGitPullRequest size={14} color={colors.muted} />}
        flush
      >
        <View
          style={{
            flexDirection: "row",
            gap: 12,
            padding: 16,
            borderBottomWidth: 1,
            borderColor: colors.border,
          }}
        >
          {[
            ["Active", snapshot.worktrees.active],
            ["Created", snapshot.worktrees.created],
            ["Archived", snapshot.worktrees.archived],
            ["Open PRs", snapshot.worktrees.openPrs],
          ].map(([label, value]) => (
            <MiniMetric key={label} label={String(label)} value={integer(Number(value))} />
          ))}
        </View>
        {!snapshot.recentPullRequests.length ? (
          <View style={{ padding: 32, alignItems: "center" }}>
            <Note>No projected pull requests yet.</Note>
          </View>
        ) : (
          snapshot.recentPullRequests.slice(0, 6).map((pr) => (
            <View
              key={pr.worktreeId}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                padding: 16,
                borderBottomWidth: 1,
                borderColor: colors.border,
              }}
            >
              <IconGitPullRequest size={16} color={colors.muted} />
              <View style={{ flex: 1 }}>
                <Text className="font-ryco-medium" numberOfLines={1} style={{ fontSize: 14 }}>
                  {pr.prTitle || pr.worktreeTitle || pr.branch}
                </Text>
                <Text numberOfLines={1} style={{ fontSize: 11, color: colors.muted, marginTop: 2 }}>
                  {pr.projectTitle} · #{pr.prNumber} · {new Date(pr.updatedAt).toLocaleDateString()}
                </Text>
              </View>
              <Text
                style={{
                  fontSize: 11,
                  borderRadius: 6,
                  paddingHorizontal: 6,
                  paddingVertical: 3,
                  backgroundColor: colors.accent,
                  color: pr.prState === "merged" ? colors.success : colors.muted,
                }}
              >
                {pr.prIsDraft ? "Draft" : (pr.prState ?? (pr.active ? "Open" : "Archived"))}
              </Text>
            </View>
          ))
        )}
      </Panel>
    </View>
  );
}
function ProjectBars({
  projects,
  metric,
}: {
  projects: ReturnType<typeof aggregateByProject>;
  metric: string;
}) {
  const colors = useStatisticsPalette();
  const [selected, setSelected] = useState<string | null>(null);
  const valueOf = (project: (typeof projects)[number]) =>
    metric === "turns"
      ? project.turns
      : metric === "activeMs"
        ? project.activeMs
        : project.filesChanged;
  const rows = projects.toSorted((a, b) => valueOf(b) - valueOf(a)).slice(0, 6);
  const max = Math.max(1, ...rows.map(valueOf));
  return (
    <View style={{ height: 220, justifyContent: "space-evenly" }}>
      {rows.length ? (
        rows.map((project, index) => (
          <Pressable
            key={project.projectId}
            accessibilityLabel={`${project.title}: ${metric === "activeMs" ? duration(valueOf(project)) : integer(valueOf(project))}`}
            onPress={() => setSelected(project.projectId === selected ? null : project.projectId)}
            style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 30 }}
          >
            <Text
              numberOfLines={1}
              style={{ width: 86, textAlign: "right", fontSize: 11, color: colors.muted }}
            >
              {project.title.length > 14 ? `${project.title.slice(0, 13)}…` : project.title}
            </Text>
            <View style={{ flex: 1 }}>
              <View
                style={{
                  height: 26,
                  width: `${(valueOf(project) / max) * 100}%`,
                  backgroundColor: [
                    "#497ef7",
                    "#00b5b5",
                    "#e99b2a",
                    "#f4455d",
                    "#4ac06c",
                    "#9b61ea",
                  ][index],
                  borderTopRightRadius: 4,
                  borderBottomRightRadius: 4,
                }}
              />
              {selected === project.projectId ? (
                <Text
                  style={{
                    position: "absolute",
                    right: 4,
                    top: 4,
                    fontSize: 11,
                    backgroundColor: colors.card,
                    color: colors.foreground,
                  }}
                >
                  {metric === "activeMs" ? duration(valueOf(project)) : integer(valueOf(project))}
                </Text>
              ) : null}
            </View>
          </Pressable>
        ))
      ) : (
        <Note>No project activity yet.</Note>
      )}
    </View>
  );
}
