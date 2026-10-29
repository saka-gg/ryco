import {
  USAGE_PROVIDERS,
  USAGE_PROVIDER_COLORS,
  USAGE_PROVIDER_LABELS,
  filterUsageImports,
  listUnpricedUsageModels,
  sumUsageCostBreakdown,
  sumUsageImports,
  usageCacheReadShare,
  type MergedUsageSummary,
  type UnpricedUsageModel,
  type UsageBreakdownRow,
  type UsageModelKey,
} from "@ryco/client-runtime/usage";
import type { EnvironmentId, UsageImportedMetric, UsageProviderKind } from "@ryco/contracts";
import {
  AlertCircleIcon,
  BrainCircuitIcon,
  CircleDollarSignIcon,
  DatabaseIcon,
  Layers3Icon,
  RefreshCwIcon,
  SparklesIcon,
  type LucideIcon,
} from "lucide-react";
import { useId, useMemo, useState } from "react";

import {
  requestUsagePriceRow,
  USAGE_PRICE_SECTION_TITLE,
} from "~/components/settings/usagePriceSettingsRequest";
import { requestSettingsReveal } from "~/components/settings/settingsSearchReveal";
import { Button } from "~/components/ui/button";
import { notifySurfaceLoadFailure } from "~/components/ui/surfaceLoadFailure";
import { preloadableLazy, useLazyComponentReady } from "~/lib/preloadableLazy";
import { cn } from "~/lib/utils";
import { useSettingsDialogStore } from "~/settingsDialogStore";
import {
  formatCost,
  formatDayLabel,
  formatInteger,
  formatModelLabel,
  formatProviderLabel,
  formatTimestamp,
  formatTokens,
} from "~/lib/statisticsFormat";

import { Panel, StatePanel, StatSkeleton } from "../../settings/statistics/parts";
import { EnvironmentSelect } from "../EnvironmentSelect";
import type { StatisticsSearch } from "../statisticsSearch";
import { useUsageSummary } from "../useUsageSummary";
import { CostByTypeBar } from "./CostByTypeBar";
import {
  buildUsageBreakdown,
  buildUsageDaySeries,
  filterUsageBuckets,
  sumUsageTotals,
} from "./selectors";
import { UsageMetricChart, type UsageChartMetric } from "./UsageMetricChart";

// Most visits never open a model, so its detail loads on the first open (warmed on intent).
const UsageModelDialog = preloadableLazy(() =>
  import("./UsageModelDialog").then((module) => module.UsageModelDialog),
);
const preloadUsageModelDialog = () => {
  void UsageModelDialog.preload();
};

export function UsageView({
  search,
  onSearchChange,
}: {
  readonly search: StatisticsSearch;
  readonly onSearchChange: (next: StatisticsSearch) => void;
}) {
  const result = useUsageSummary({
    range: search.range,
    environmentIds: search.environmentIds,
  });
  const { merged } = result;
  // Kept through the close animation; cleared once it ends.
  const [modelDetail, setModelDetail] = useState<{
    readonly target: UsageModelKey;
    readonly open: boolean;
  } | null>(null);
  const modelDialogReady = useLazyComponentReady(UsageModelDialog, modelDetail !== null, {
    onLoadError: (error) => {
      const target = modelDetail?.target;
      setModelDetail(null);
      notifySurfaceLoadFailure("model details", error, () => {
        if (target) setModelDetail({ target, open: true });
      });
    },
  });
  const derived = useMemo(() => {
    if (!merged) return null;
    const buckets = filterUsageBuckets(merged, search.providers);
    return {
      buckets,
      imports: filterUsageImports(merged, search.providers),
      totals: sumUsageTotals(merged, buckets),
      costByType: sumUsageCostBreakdown(buckets),
      days: buildUsageDaySeries(merged, buckets),
      breakdown: buildUsageBreakdown(buckets, search.usageBreakdown),
      unpriced: listUnpricedUsageModels(merged, buckets),
    };
  }, [merged, search.providers, search.usageBreakdown]);

  // While this app's own node is still connecting there is nothing to ask yet:
  // that is a loading state, not "no environments".
  if ((result.loading || result.connecting) && !merged) return <StatSkeleton />;
  if (!merged || !derived) {
    const failed = result.environments.filter(
      (environment) =>
        environment.status === "failed" ||
        environment.status === "unavailable" ||
        environment.status === "stale-contract",
    );
    return (
      <StatePanel
        icon={failed.length > 0 ? AlertCircleIcon : DatabaseIcon}
        title={failed.length > 0 ? "Couldn’t load usage" : "No usage environments are connected"}
        description={
          failed.length > 0
            ? `Usage failed for ${failed.map((environment) => environment.label).join(", ")}. ${failed[0]?.message ?? "Retry after checking the environment connection."}`
            : "Connect an environment with supported provider histories, then refresh this view."
        }
        action={
          <Button size="sm" variant="outline" onClick={result.refresh}>
            <RefreshCwIcon /> Refresh
          </Button>
        }
      />
    );
  }

  const { totals, costByType, days, breakdown } = derived;
  const pricedShare =
    totals.pricedTokenCount + totals.unpricedTokenCount > 0
      ? totals.pricedTokenCount / (totals.pricedTokenCount + totals.unpricedTokenCount)
      : 0;
  const cacheShare = usageCacheReadShare(totals) ?? 0;
  const pendingLabels = result.pendingEnvironmentIds.flatMap((environmentId) => {
    const label = result.availableEnvironments.find(
      (environment) => environment.environmentId === environmentId,
    )?.label;
    return label === undefined ? [] : [label];
  });
  const foundTranscriptSource = merged.sources.some(
    (source) => source.included && (source.status === "complete" || source.status === "partial"),
  );

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <RangeControl search={search} onSearchChange={onSearchChange} />
          <EnvironmentSelect
            search={search}
            onSearchChange={onSearchChange}
            environments={result.availableEnvironments}
            ariaLabel="Usage environment"
          />
          <ProviderControl search={search} onSearchChange={onSearchChange} />
        </div>
        <Button size="sm" variant="outline" onClick={result.refresh} disabled={result.refreshing}>
          <RefreshCwIcon className={result.refreshing ? "animate-spin" : undefined} />
          {result.refreshing ? "Refreshing" : "Refresh"}
        </Button>
      </div>

      <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
        Provider-recorded usage from supported local histories on the selected machines. This
        includes sessions run outside Ryco and is intentionally not attributed to projects.
      </p>
      {pendingLabels.length > 0 ? (
        <p className="-mt-5 text-xs text-muted-foreground" aria-live="polite">
          Updating {pendingLabels.join(", ")}…
        </p>
      ) : null}

      {derived.imports.length > 0 ? <ImportedCursorUsage rows={derived.imports} /> : null}
      {derived.buckets.length === 0 ? (
        <StatePanel
          icon={Layers3Icon}
          title={foundTranscriptSource ? "No usage in this range" : "No transcript sources found"}
          description={
            foundTranscriptSource
              ? "The transcript sources were found, but no provider-recorded usage matched these filters."
              : "No supported provider history was found on the selected environments. See source coverage below."
          }
        />
      ) : (
        <>
          <section className="grid overflow-hidden rounded-2xl border border-border/75 bg-card shadow-sm/5 lg:grid-cols-[minmax(18rem,0.72fr)_minmax(0,1.55fr)]">
            <div className="flex min-h-80 flex-col justify-between border-b border-border/70 p-6 lg:border-r lg:border-b-0 lg:p-8">
              <div>
                <div className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                  <CircleDollarSignIcon className="size-3.5" /> Raw API-equivalent cost
                </div>
                <div className="mt-5 text-4xl font-semibold tracking-[-0.045em] tabular-nums sm:text-5xl">
                  {formatCost(totals.estimatedCostUsd)}
                </div>
                <p className="mt-3 max-w-sm text-xs leading-relaxed text-muted-foreground">
                  Estimate based on published API rates and recorded billing speed. Subscription,
                  credits, batch, negotiated, and provider billing may differ.
                </p>
              </div>
              <div className="space-y-4 border-t border-border/65 pt-5">
                <SummaryLine
                  label="Priced coverage"
                  value={`${Math.round(pricedShare * 100)}% of tokens`}
                />
                <SummaryLine
                  label="Estimated cache savings"
                  value={formatCost(totals.estimatedCacheSavingsUsd)}
                />
                <SummaryLine
                  label="Provider-recorded tokens"
                  value={formatInteger(totals.totalTokens)}
                />
                {costByType === null ? null : (
                  <CostByTypeBar totals={costByType} className="border-t border-border/65 pt-4" />
                )}
              </div>
            </div>
            {/* The chart fills what the cost column's breakdown adds to the card's height. */}
            <div className="flex min-w-0 flex-col p-4 sm:p-6">
              <div className="mb-2 flex items-center justify-between gap-3 px-1">
                <div>
                  <h2 className="text-sm font-semibold">Usage over time</h2>
                  <p className="text-xs text-muted-foreground">Daily values in {merged.timeZone}</p>
                </div>
                <MetricToggle search={search} onSearchChange={onSearchChange} />
              </div>
              <UsageAreaChart data={days} metric={search.usageMetric} />
              <div className="flex items-center justify-end gap-4 px-2 text-[11px] text-muted-foreground">
                {USAGE_PROVIDERS.map((provider) => (
                  <LegendDot
                    key={provider}
                    color={USAGE_PROVIDER_COLORS[provider]}
                    label={USAGE_PROVIDER_LABELS[provider]}
                  />
                ))}
              </div>
            </div>
          </section>

          <div className="grid grid-cols-2 border-y border-border/65 md:grid-cols-5">
            <MetricRail label="Total tokens" value={formatTokens(totals.totalTokens)} />
            <MetricRail label="Sessions" value={formatInteger(totals.distinctSessionCount)} />
            <MetricRail label="Responses" value={formatInteger(totals.responseCount)} />
            <MetricRail label="Cache read" value={`${Math.round(cacheShare * 100)}%`} />
            <MetricRail
              label="Reasoning"
              value={
                totals.reasoningTokens === null
                  ? "Unavailable"
                  : formatTokens(totals.reasoningTokens)
              }
              detail="included in output"
            />
          </div>

          <Panel
            title="Breakdown"
            icon={Layers3Icon}
            action={<BreakdownToggle search={search} onSearchChange={onSearchChange} />}
            bodyClassName="overflow-hidden"
          >
            <div className="divide-y divide-border/60">
              {breakdown.slice(0, 20).map((row) => (
                <BreakdownRow
                  key={row.key}
                  row={row}
                  dimension={search.usageBreakdown}
                  onOpenModel={(target) => setModelDetail({ target, open: true })}
                />
              ))}
            </div>
          </Panel>
          {modelDetail !== null && modelDialogReady ? (
            <UsageModelDialog
              target={modelDetail.target}
              open={modelDetail.open}
              onOpenChange={(open) =>
                setModelDetail((current) => (current === null ? null : { ...current, open }))
              }
              onClosed={() => setModelDetail(null)}
              summary={merged}
              buckets={derived.buckets}
              metric={search.usageMetric}
            />
          ) : null}
        </>
      )}
      <Coverage
        summary={{
          ...merged,
          sources: merged.sources.filter(
            (source) =>
              search.providers === undefined || search.providers.includes(source.provider),
          ),
        }}
        unpriced={derived.unpriced}
      />
    </div>
  );
}

function RangeControl({ search, onSearchChange }: SearchControlProps) {
  return (
    <div className="inline-flex rounded-lg border bg-card p-0.5">
      {(["7d", "30d", "90d", "all"] as const).map((range) => (
        <button
          key={range}
          type="button"
          onClick={() => onSearchChange({ ...search, range })}
          className={cn(
            "h-7 rounded-md px-2.5 text-xs font-medium transition-colors",
            search.range === range
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {range === "all" ? "All" : range.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

interface SearchControlProps {
  readonly search: StatisticsSearch;
  readonly onSearchChange: (next: StatisticsSearch) => void;
}

function ProviderControl({ search, onSearchChange }: SearchControlProps) {
  const selected = new Set<UsageProviderKind>(search.providers ?? USAGE_PROVIDERS);
  return (
    <div className="inline-flex rounded-lg border bg-card p-0.5">
      {USAGE_PROVIDERS.map((provider) => (
        <button
          key={provider}
          type="button"
          aria-pressed={selected.has(provider)}
          onClick={() => {
            const next = new Set(selected);
            if (next.has(provider) && next.size > 1) next.delete(provider);
            else next.add(provider);
            const providers = [...next].toSorted();
            onSearchChange({
              ...search,
              ...(providers.length === USAGE_PROVIDERS.length
                ? { providers: undefined }
                : { providers }),
            });
          }}
          className={cn(
            "inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium capitalize transition-colors",
            selected.has(provider)
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <span
            aria-hidden
            className="mr-1.5 inline-block size-1.5 rounded-full"
            style={{ backgroundColor: USAGE_PROVIDER_COLORS[provider] }}
          />
          {USAGE_PROVIDER_LABELS[provider]}
        </button>
      ))}
    </div>
  );
}

function MetricToggle({ search, onSearchChange }: SearchControlProps) {
  return (
    <div className="inline-flex rounded-md bg-muted p-0.5">
      {(["cost", "tokens"] as const).map((metric) => (
        <button
          key={metric}
          type="button"
          onClick={() => onSearchChange({ ...search, usageMetric: metric })}
          className={cn(
            "h-6 rounded-sm px-2 text-[11px] font-medium capitalize",
            search.usageMetric === metric
              ? "bg-background text-foreground shadow-xs"
              : "text-muted-foreground",
          )}
        >
          {metric}
        </button>
      ))}
    </div>
  );
}

function BreakdownToggle({ search, onSearchChange }: SearchControlProps) {
  return (
    <div className="inline-flex items-center gap-1 text-[11px]">
      {(["model", "day"] as const).map((dimension) => (
        <button
          key={dimension}
          type="button"
          onClick={() => onSearchChange({ ...search, usageBreakdown: dimension })}
          className={cn(
            "rounded-md px-2 py-1 capitalize",
            search.usageBreakdown === dimension
              ? "bg-accent text-foreground"
              : "text-muted-foreground",
          )}
        >
          {dimension}
        </button>
      ))}
    </div>
  );
}

/** A model row opens that model's detail; a day row only reads. */
function BreakdownRow({
  row,
  dimension,
  onOpenModel,
}: {
  readonly row: UsageBreakdownRow;
  readonly dimension: StatisticsSearch["usageBreakdown"];
  readonly onOpenModel: (target: UsageModelKey) => void;
}) {
  const id = useId();
  const layout = "grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-5 px-4 py-3.5 sm:px-5";
  // Spans, not paragraphs: a model row is a button, which takes phrasing content only.
  const content = (
    <>
      <span className="block min-w-0">
        <span id={`${id}-label`} className="block truncate text-sm font-medium">
          {dimension === "model" ? formatModelLabel(row.label) : formatDayLabel(row.label)}
        </span>
        <span id={`${id}-source`} className="mt-0.5 block text-[11px] text-muted-foreground">
          {row.provider ? formatProviderLabel(row.provider) : `${row.responses} responses`}
        </span>
      </span>
      <span id={`${id}-tokens`} className="block text-right">
        <span className="block text-sm font-medium tabular-nums">{formatTokens(row.tokens)}</span>
        <span className="block text-[11px] text-muted-foreground">tokens</span>
      </span>
      <span id={`${id}-cost`} className="block w-24 text-right">
        <span className="block text-sm font-medium tabular-nums">{formatCost(row.costUsd)}</span>
        <span className="block text-[11px] text-muted-foreground">
          {row.unpricedTokens > 0
            ? `${formatTokens(row.unpricedTokens)} unpriced`
            : row.customPricedTokens > 0
              ? "custom price"
              : "estimated"}
        </span>
      </span>
    </>
  );
  const provider = row.provider;
  if (dimension !== "model" || provider === undefined) {
    return <div className={layout}>{content}</div>;
  }
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      // Named by model and provider (one model ID can run through several providers).
      aria-labelledby={`${id}-label ${id}-source`}
      aria-describedby={`${id}-tokens ${id}-cost`}
      onClick={() => onOpenModel({ provider, model: row.label })}
      onPointerEnter={preloadUsageModelDialog}
      onFocus={preloadUsageModelDialog}
      className={cn(
        layout,
        "w-full text-left outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
      )}
    >
      {content}
    </button>
  );
}

function UsageAreaChart({
  data,
  metric,
}: {
  readonly data: ReturnType<typeof buildUsageDaySeries>;
  readonly metric: UsageChartMetric;
}) {
  const dates = useMemo(() => data.map((point) => point.date), [data]);
  const series = useMemo(
    () =>
      USAGE_PROVIDERS.map((provider) => ({
        key: provider,
        label: formatProviderLabel(provider),
        color: USAGE_PROVIDER_COLORS[provider],
        values: data.map((point) => point[`${provider}${metric === "cost" ? "Cost" : "Tokens"}`]),
      })),
    [data, metric],
  );
  return (
    <UsageMetricChart
      className="min-h-[300px] flex-1"
      label="Usage over time"
      dates={dates}
      series={series}
      metric={metric}
    />
  );
}

function SummaryLine({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

function MetricRail({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
}) {
  return (
    <div className="border-r border-border/60 px-4 py-5 last:border-r-0">
      <p className="text-[10px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
        {label}
      </p>
      <p className="mt-2 text-xl font-semibold tracking-tight tabular-nums">{value}</p>
      {detail ? <p className="mt-1 text-[10px] text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

function LegendDot({ color, label }: { readonly color: string; readonly label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-2 rounded-sm" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

/** Open the node's model price editor with a row for `model`. */
function setModelPrices(environmentId: EnvironmentId, model: string) {
  requestUsagePriceRow(environmentId, model);
  useSettingsDialogStore.getState().openSettings("general", environmentId);
  requestSettingsReveal(USAGE_PRICE_SECTION_TITLE);
}

function Coverage({
  summary,
  unpriced,
}: {
  readonly summary: MergedUsageSummary;
  readonly unpriced: readonly UnpricedUsageModel[];
}) {
  const included = summary.sources.filter((source) => source.included);
  const issues = included.filter((source) => source.status !== "complete");
  const failedEnvironments = summary.environments.filter(
    (environment) =>
      environment.status === "failed" ||
      environment.status === "unavailable" ||
      environment.status === "stale-contract",
  );
  const pricingStates = summary.environments.flatMap((environment) =>
    environment.summary === undefined ? [] : [environment.summary.pricing.state],
  );
  const pricingState =
    pricingStates.length === 0
      ? "Unavailable"
      : pricingStates.every((state) => state === "live")
        ? "Live"
        : pricingStates.every((state) => state === "cached")
          ? "Cached"
          : pricingStates.every((state) => state === "unavailable")
            ? "Unavailable"
            : "Mixed";
  const pricingFetch = summary.environments
    .flatMap((environment) => {
      const fetchedAt = environment.summary?.pricing.fetchedAt;
      return fetchedAt === undefined ? [] : [fetchedAt];
    })
    .toSorted()
    .at(-1);
  let customPriceCount = 0;
  let mappedModelCount = 0;
  for (const environment of summary.environments) {
    customPriceCount += environment.summary?.pricing.customPriceCount ?? 0;
    mappedModelCount += environment.summary?.pricing.mappedModelCount ?? 0;
  }
  const customPricing = [
    customPriceCount > 0 ? plural(customPriceCount, "custom price") : null,
    mappedModelCount > 0 ? plural(mappedModelCount, "mapped model") : null,
  ].filter((part) => part !== null);
  const latestScan = included
    .map((source) => source.scanFinishedAt)
    .toSorted()
    .at(-1);
  return (
    <Panel title="Coverage & estimates" icon={BrainCircuitIcon} bodyClassName="p-5">
      {failedEnvironments.length > 0 ? (
        <div className="mb-5 flex gap-2 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2.5 text-xs text-muted-foreground">
          <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>
            No usage was included from{" "}
            {failedEnvironments.map((environment) => environment.label).join(", ")}.
          </span>
        </div>
      ) : null}
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
        <CoverageItem
          icon={DatabaseIcon}
          label="Transcript sources"
          value={`${included.length} included`}
          detail={
            summary.duplicateSourceCount > 0
              ? `${summary.duplicateSourceCount} duplicate source excluded`
              : "No physical duplicates detected"
          }
        />
        <CoverageItem
          icon={SparklesIcon}
          label="Last scan"
          value={latestScan ? formatTimestamp(latestScan) : "Not scanned"}
          detail={`${included.reduce((sum, source) => sum + source.reusedCacheFileCount, 0)} cached files reused`}
        />
        <CoverageItem
          icon={CircleDollarSignIcon}
          label="Pricing"
          value={pricingState}
          detail={[
            pricingFetch
              ? `Rates fetched ${formatTimestamp(pricingFetch)}`
              : "Token totals remain available without rates",
            ...customPricing,
          ].join(" · ")}
        />
        <CoverageItem
          icon={AlertCircleIcon}
          label="Coverage state"
          value={
            issues.length === 0
              ? "Complete"
              : `${issues.length} source notice${issues.length === 1 ? "" : "s"}`
          }
          detail={
            summary.environmentOnlyDeduplicationWarning
              ? "Some sources could only be scoped per environment"
              : `${included.reduce((sum, source) => sum + source.malformedLineCount, 0)} malformed lines skipped`
          }
        />
      </div>
      {unpriced.length > 0 ? (
        <UnpricedModels unpriced={unpriced} environments={summary.environments} />
      ) : null}
      {issues.map((source) => (
        <p
          key={`${source.environmentId}:${source.sourceId}`}
          className="mt-3 text-xs text-muted-foreground"
        >
          {formatProviderLabel(source.provider)} · {source.environmentLabel}:{" "}
          {source.message ?? source.diagnosticCode ?? source.status}
        </p>
      ))}
    </Panel>
  );
}

function plural(count: number, noun: string): string {
  return `${formatInteger(count)} ${noun}${count === 1 ? "" : "s"}`;
}

const UNPRICED_MODEL_LIMIT = 8;

function UnpricedModels({
  unpriced,
  environments,
}: {
  readonly unpriced: readonly UnpricedUsageModel[];
  readonly environments: MergedUsageSummary["environments"];
}) {
  const labels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );
  const hidden = unpriced.length - UNPRICED_MODEL_LIMIT;
  return (
    <div className="mt-5 border-t border-border/60 pt-4">
      <p className="text-xs font-medium">Unpriced models</p>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        No published rate covers these model IDs. Set a price for them, or map them to a priced
        model, on the machine that recorded them.
      </p>
      <ul aria-label="Unpriced models" className="mt-2 divide-y divide-border/60">
        {unpriced.slice(0, UNPRICED_MODEL_LIMIT).map((entry) => (
          <li
            key={`${entry.provider}:${entry.model}`}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-2 text-xs"
          >
            <span className="min-w-0">
              <span className="font-mono break-all">{entry.model}</span>
              <span className="text-muted-foreground">
                {" "}
                · {formatProviderLabel(entry.provider)} · {formatTokens(entry.unpricedTokens)}{" "}
                tokens
              </span>
            </span>
            <span className="flex flex-wrap gap-1.5">
              {entry.environmentIds.map((environmentId) => {
                const label = labels.get(environmentId) ?? "this machine";
                const several = entry.environmentIds.length > 1;
                return (
                  <Button
                    key={environmentId}
                    size="xs"
                    variant="outline"
                    aria-label={`Set prices for ${entry.model}${several ? ` on ${label}` : ""}`}
                    onClick={() => setModelPrices(environmentId, entry.model)}
                  >
                    {several ? `Set prices on ${label}` : "Set prices"}
                  </Button>
                );
              })}
            </span>
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {plural(hidden, "more unpriced model")}
        </p>
      ) : null}
    </div>
  );
}

function CoverageItem({
  icon: Icon,
  label,
  value,
  detail,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}) {
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </div>
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-sm font-medium">{value}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

function ImportedCursorUsage({ rows }: { readonly rows: readonly UsageImportedMetric[] }) {
  const [page, setPage] = useState(0);
  const totals = sumUsageImports(rows);
  const pages = Math.ceil(rows.length / 20),
    current = Math.min(page, pages - 1);
  const ordered = [...rows].toSorted(
    (left, right) => right.date.localeCompare(left.date) || left.metric.localeCompare(right.metric),
  );
  return (
    <Panel title="Cursor exported events and billed cost">
      <p className="text-sm text-muted-foreground">
        Saved Cursor Admin API exports. Billed costs include Cursor fees and remain separate from
        model cost. Exported events without token fields do not contribute token totals.
      </p>
      <p className="mt-3 text-sm">
        {totals.requests === null
          ? "Requests unavailable"
          : `${formatInteger(totals.requests)} exported events`}
        {totals.costs
          .map((cost) => ` · ${cost.value.toLocaleString()} ${cost.currency} billed cost`)
          .join("")}
      </p>
      <div className="mt-4 divide-y">
        {ordered.slice(current * 20, (current + 1) * 20).map((row) => (
          <div
            key={row.recordId}
            className="flex flex-wrap items-center justify-between gap-3 py-2 text-xs"
          >
            <span>
              {formatDayLabel(row.date)}
              {row.model ? ` · ${formatModelLabel(row.model)}` : ""}
            </span>
            <span>
              {row.metric === "requests"
                ? `${formatInteger(row.value)} events`
                : `${row.value.toLocaleString()} ${row.currency}`}
            </span>
          </div>
        ))}
      </div>
      {pages > 1 ? (
        <div className="mt-3 flex items-center gap-3">
          <Button size="sm" disabled={current === 0} onClick={() => setPage(current - 1)}>
            Previous
          </Button>
          <span className="text-xs">
            {current + 1} / {pages}
          </span>
          <Button size="sm" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
            Next
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}
