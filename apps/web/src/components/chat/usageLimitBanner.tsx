import {
  buildUsageLimitResumeDispatch,
  captureReviewedSendReadiness,
  commitSendTurnDispatch,
  type UsageLimitResumeThread,
} from "@ryco/client-runtime/state/composer";
import {
  deriveUsageLimitBanner,
  formatUsageLimitReset,
  type UsageLimitBannerModel,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ServerConfig, ThreadUsageLimit } from "@ryco/contracts";
import { GaugeIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { readEnvironmentConnection } from "../../environments/runtime";
import { newCommandId } from "../../lib/utils";
import { Button } from "../ui/button";
import { claudeCacheReviewPresentation } from "./ClaudeCacheReview";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** setTimeout's largest delay; a later reset re-arms after the next render. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export type UsageLimitBannerThread = Omit<UsageLimitResumeThread, "usageLimit"> & {
  readonly usageLimit?: ThreadUsageLimit | null | undefined;
  readonly snoozedUntil?: string | null | undefined;
};

type PendingAction = "resume" | "configure" | "snooze";

export function usageLimitBannerDescription(model: UsageLimitBannerModel): string {
  const resets = model.resetAt ? `Resets ${formatUsageLimitReset(model.resetAt)}` : null;
  switch (model.description) {
    case "resets-at":
      return resets ?? "Resume when your limit resets.";
    case "resuming-at-reset":
      return `${resets ?? "Resets soon"} · resumes automatically`;
    case "unknown-reset":
      return "Reset time unknown. Resume when your limit resets.";
    case "reset-passed":
      return "Resume to continue this thread.";
  }
}

/**
 * The composer banner for a usage-limited thread: Resume now (through the shared send
 * engine, so the Claude cache review and readiness checks apply), Resume at reset /
 * Cancel auto-resume, and Snooze until reset. Returns null when the thread is not
 * limited. Only new servers project `usageLimit`, so the banner gates itself.
 */
export function useUsageLimitBannerItem(input: {
  readonly thread: UsageLimitBannerThread | null;
  readonly environmentId: EnvironmentId | null;
  readonly serverConfig: ServerConfig | null;
  readonly dispatchAllowed: boolean;
  readonly snoozeEligibility: { readonly canSnooze: boolean };
}): ComposerBannerStackItem | null {
  const { thread, environmentId, serverConfig, dispatchAllowed, snoozeEligibility } = input;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [error, setError] = useState<{ readonly limitId: string; readonly message: string } | null>(
    null,
  );

  const model = useMemo(
    () =>
      thread
        ? deriveUsageLimitBanner({
            thread,
            nodeAutoResume: serverConfig?.settings.autoResumeLimitedThreads ?? null,
            recoverySupported: serverConfig?.environment.capabilities.usageLimitRecovery === true,
            snoozeEligibility,
            snoozeSupported: serverConfig?.environment.capabilities.threadSnooze === true,
            dispatchAllowed: dispatchAllowed && environmentId !== null,
            nowMs,
          })
        : null,
    [dispatchAllowed, environmentId, nowMs, serverConfig, snoozeEligibility, thread],
  );

  // Re-render at the reset: the copy and the offered actions change then.
  const refreshAtMs = model?.refreshAtMs ?? null;
  useEffect(() => {
    if (refreshAtMs === null) return;
    const timer = setTimeout(
      () => setNowMs(Date.now()),
      Math.min(Math.max(0, refreshAtMs - Date.now()), MAX_TIMER_DELAY_MS),
    );
    return () => clearTimeout(timer);
  }, [refreshAtMs]);

  if (!model || !thread || environmentId === null) return null;
  const limitId = model.limit.limitId;

  const run = async (action: PendingAction, task: () => Promise<unknown>) => {
    setPending(action);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError({
        limitId,
        message: cause instanceof Error ? cause.message : "The request failed.",
      });
    } finally {
      setPending(null);
      setNowMs(Date.now());
    }
  };
  const requireApi = () => {
    const api = readEnvironmentApi(environmentId);
    if (!api) throw new Error("The owning machine is not connected.");
    return api;
  };
  const resumeNow = () =>
    run("resume", async () => {
      const dispatch = buildUsageLimitResumeDispatch({
        api: requireApi(),
        thread,
        claudeCacheReview: claudeCacheReviewPresentation,
        assertMutationReady: captureReviewedSendReadiness(environmentId, () =>
          readEnvironmentConnection(environmentId),
        ),
        createdAt: new Date().toISOString(),
        newCommandId,
      });
      if (dispatch) await commitSendTurnDispatch(dispatch);
    });
  const autoResume = model.actions.autoResume;
  const configure = (next: boolean) =>
    run("configure", () =>
      requireApi().orchestration.dispatchCommand({
        type: "thread.usage-limit.configure",
        commandId: newCommandId(),
        threadId: thread.id,
        limitId,
        autoResume: next,
        createdAt: new Date().toISOString(),
      }),
    );
  const resetAt = model.resetAt;
  const snooze = () =>
    run("snooze", () =>
      resetAt === null
        ? Promise.resolve()
        : requireApi().orchestration.dispatchCommand({
            type: "thread.snooze",
            commandId: newCommandId(),
            threadId: thread.id,
            snoozedUntil: resetAt,
          }),
    );

  const visibleError = error?.limitId === limitId ? error.message : null;
  return {
    id: `usage-limit:${limitId}`,
    variant: "warning",
    icon: <GaugeIcon />,
    title: model.title,
    description: (
      <>
        {usageLimitBannerDescription(model)}
        {visibleError ? (
          <span role="alert" className="mt-1 block text-destructive">
            {visibleError}
          </span>
        ) : null}
      </>
    ),
    actions:
      model.actions.resumeNow || autoResume || model.actions.snoozeUntilReset ? (
        <>
          {model.actions.resumeNow ? (
            <Button size="xs" disabled={pending !== null} onClick={() => void resumeNow()}>
              {pending === "resume" ? "Resuming…" : "Resume now"}
            </Button>
          ) : null}
          {autoResume ? (
            <Button
              size="xs"
              variant="outline"
              disabled={pending !== null}
              onClick={() => void configure(!autoResume.scheduled)}
            >
              {autoResume.scheduled ? "Cancel auto-resume" : "Resume at reset"}
            </Button>
          ) : null}
          {model.actions.snoozeUntilReset ? (
            <Button
              size="xs"
              variant="outline"
              disabled={pending !== null}
              onClick={() => void snooze()}
            >
              Snooze until reset
            </Button>
          ) : null}
        </>
      ) : undefined,
  };
}
