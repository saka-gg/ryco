import type { StatRange } from "@ryco/client-runtime/usage";
import type { EnvironmentId } from "@ryco/contracts";
import { CliProxyHubSnapshot } from "@ryco/contracts/cli-proxy";
import { ServerProviders } from "@ryco/contracts/server";
import { StatisticsSnapshot } from "@ryco/contracts/statistics";
import { UsageSummary } from "@ryco/contracts/usage";
import * as Schema from "effect/Schema";

import { awaitSavedQueryStore } from "../../../rpc/savedQueries";
import { schemaSavedQueryCodec } from "../../../rpc/savedQueryCodec";
import type { InboxEnvironment } from "../../inbox/inboxModel";
import type { StatisticsTab } from "./statisticsRoute";

/**
 * Each device's last usable Usage, Activity and Limits answer, kept on the
 * device through the saved query store (its rules: the device setting, the
 * environment purge, the byte caps), so the screen shows it at once on the
 * next open — also before the device connects — while the device is asked
 * again. Only answers with data are kept; the device and its label are
 * whatever the screen has now.
 */
const SavedNodeStatistics = Schema.Struct({
  activity: Schema.optionalKey(StatisticsSnapshot),
  usage: Schema.optionalKey(
    Schema.Struct({
      status: Schema.Literals(["complete", "partial"]),
      summary: Schema.optionalKey(UsageSummary),
      message: Schema.optionalKey(Schema.String),
    }),
  ),
  providers: Schema.optionalKey(ServerProviders),
  hubs: Schema.optionalKey(
    Schema.Struct({
      status: Schema.Literals(["ok", "failed", "unsupported"]),
      hubs: Schema.Array(CliProxyHubSnapshot),
      message: Schema.optionalKey(Schema.String),
      receivedAtMs: Schema.Number,
    }),
  ),
});
type SavedNodeStatistics = typeof SavedNodeStatistics.Type;

const SAVED = schemaSavedQueryCodec(SavedNodeStatistics, 1);

/** What one saved answer is for: Usage per date range, Activity and Limits per device. */
export function savedStatisticsScope(tab: StatisticsTab, range: StatRange): string {
  return tab === "usage" ? `usage:${range}` : tab;
}

function savedKey(scope: string): string {
  return `statistics\u0000${scope}`;
}

/** The parts of an answer worth keeping, or null when it carries no data. */
export function savedStatisticsOf(node: {
  readonly activity?: SavedNodeStatistics["activity"];
  readonly usage?: {
    readonly status: string;
    readonly summary?: unknown;
    readonly message?: string;
  };
  readonly providers?: SavedNodeStatistics["providers"];
  readonly hubs?: SavedNodeStatistics["hubs"];
  readonly error?: string;
}): SavedNodeStatistics | null {
  if (node.error !== undefined) return null;
  const usage =
    node.usage && (node.usage.status === "complete" || node.usage.status === "partial")
      ? (node.usage as SavedNodeStatistics["usage"])
      : undefined;
  if (node.activity === undefined && usage === undefined && node.providers === undefined) {
    return null;
  }
  return {
    ...(node.activity !== undefined ? { activity: node.activity } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(node.providers !== undefined ? { providers: node.providers } : {}),
    ...(node.hubs !== undefined ? { hubs: node.hubs } : {}),
  };
}

export function saveNodeStatistics(
  environmentId: EnvironmentId,
  scope: string,
  saved: SavedNodeStatistics,
): void {
  void awaitSavedQueryStore().then((store) =>
    store?.save(environmentId, savedKey(scope), SAVED.version, () => SAVED.encode(saved)),
  );
}

/** One device's saved answer as the screen reads answers, or null when none is kept. */
export async function loadSavedNodeStatistics(environment: InboxEnvironment, scope: string) {
  const store = await awaitSavedQueryStore();
  const read = await store?.load(environment.environmentId, savedKey(scope), SAVED.version);
  const saved = read ? SAVED.decode(read.payload) : null;
  if (!saved) return null;
  // Only an answer of the view it is kept for.
  const fits = scope.startsWith("usage:")
    ? saved.usage !== undefined
    : scope === "activity"
      ? saved.activity !== undefined
      : saved.providers !== undefined;
  if (!fits) return null;
  return {
    environment,
    ...(saved.activity !== undefined ? { activity: saved.activity } : {}),
    ...(saved.usage !== undefined
      ? {
          usage: {
            ...saved.usage,
            environmentId: environment.environmentId,
            label: environment.label,
          },
        }
      : {}),
    ...(saved.providers !== undefined ? { providers: saved.providers } : {}),
    ...(saved.hubs !== undefined ? { hubs: saved.hubs } : {}),
  };
}
