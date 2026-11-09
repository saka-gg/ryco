import {
  buildUsageLimitResumeDispatch,
  captureReviewedSendReadiness,
  commitSendTurnDispatch,
  type UsageLimitResumeThread,
} from "@ryco/client-runtime/state/composer";
import {
  deriveUsageLimitBanner,
  usageLimitBannerDescription,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ThreadUsageLimit } from "@ryco/contracts";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { createMobileConnectionRegistry } from "../../runtime/bootstrap";
import { readEnvironmentApi } from "../../connection/environmentApi";
import { newCommandId } from "../../lib/ids";
import { useThemeColor } from "../../lib/useThemeColor";
import { useEnvironmentServerConfigs } from "../../state/environmentServerConfigs";
import { isClaudeResumeReviewEnabled } from "../../state/preferencesStore";
import { mobileClaudeCacheReview } from "./claudeCacheReview";

/** setTimeout's largest delay; a later reset re-arms after the next render. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

type PendingAction = "resume" | "configure" | "snooze";

export type UsageLimitBannerThread = Omit<UsageLimitResumeThread, "usageLimit"> & {
  readonly usageLimit?: ThreadUsageLimit | null | undefined;
  readonly snoozedUntil?: string | null | undefined;
};

/**
 * A usage-limited chat, over the composer: when the limit resets, Resume now (the same turn the
 * node's auto-resume would send), Resume at reset / Cancel auto-resume, and Snooze until reset.
 * The rules are web's (`deriveUsageLimitBanner`); key it by thread so a switch starts clean.
 */
export function ThreadUsageLimitBanner(props: {
  readonly environmentId: EnvironmentId;
  readonly thread: UsageLimitBannerThread;
  readonly dispatchAllowed: boolean;
  readonly canSnooze: boolean;
}) {
  const { environmentId, thread } = props;
  const serverConfig = useEnvironmentServerConfigs().get(environmentId) ?? null;
  const warningColor = useThemeColor("--color-warning") as string;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [error, setError] = useState<{ readonly limitId: string; readonly message: string } | null>(
    null,
  );

  const model = deriveUsageLimitBanner({
    thread,
    nodeAutoResume: serverConfig?.settings.autoResumeLimitedThreads ?? null,
    recoverySupported: serverConfig?.environment.capabilities.usageLimitRecovery === true,
    snoozeEligibility: { canSnooze: props.canSnooze },
    snoozeSupported: serverConfig?.environment.capabilities.threadSnooze === true,
    dispatchAllowed: props.dispatchAllowed,
    nowMs,
  });

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

  if (!model) return null;
  const limitId = model.limit.limitId;
  const resetAt = model.resetAt;
  // An error speaks for the limit it was raised under, not a newer one on the same chat.
  const visibleError = error?.limitId === limitId ? error.message : null;
  const autoResume = model.actions.autoResume;

  const run = (action: PendingAction, task: () => Promise<unknown>) => {
    setPending(action);
    setError(null);
    void runUsageLimitAction(task).then((failure) => {
      setError(failure === null ? null : { limitId, message: failure });
      setPending(null);
      setNowMs(Date.now());
    });
  };
  const resumeNow = () =>
    run("resume", async () => {
      const dispatch = buildUsageLimitResumeDispatch({
        api: requireApi(environmentId),
        thread,
        claudeCacheReview: mobileClaudeCacheReview,
        skipClaudeResumeReview: () => !isClaudeResumeReviewEnabled(),
        assertMutationReady: captureReviewedSendReadiness(environmentId, () =>
          createMobileConnectionRegistry().driver.supervisor.read(environmentId),
        ),
        createdAt: new Date().toISOString(),
        newCommandId,
      });
      if (dispatch) await commitSendTurnDispatch(dispatch);
    });
  const configure = (next: boolean) =>
    run("configure", () =>
      requireApi(environmentId).orchestration.dispatchCommand({
        type: "thread.usage-limit.configure",
        commandId: newCommandId(),
        threadId: thread.id,
        limitId,
        autoResume: next,
        createdAt: new Date().toISOString(),
      }),
    );
  const snooze = () =>
    run("snooze", () =>
      resetAt === null
        ? Promise.resolve()
        : requireApi(environmentId).orchestration.dispatchCommand({
            type: "thread.snooze",
            commandId: newCommandId(),
            threadId: thread.id,
            snoozedUntil: resetAt,
          }),
    );

  return (
    <View className="mx-3 mb-2 gap-2 rounded-2xl border border-border bg-card px-3.5 py-3">
      <View className="flex-row items-start gap-2.5">
        <SymbolView name="gauge.with.dots.needle.67percent" size={16} tintColor={warningColor} />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-sm font-ryco-bold text-foreground">{model.title}</Text>
          <Text className="text-xs text-foreground-muted">
            {usageLimitBannerDescription(model)}
          </Text>
          {visibleError ? (
            <Text className="text-xs text-danger-foreground">{visibleError}</Text>
          ) : null}
        </View>
      </View>
      {model.actions.resumeNow || autoResume || model.actions.snoozeUntilReset ? (
        <View className="flex-row flex-wrap gap-2 pl-6">
          {model.actions.resumeNow ? (
            <BannerButton
              primary
              label={pending === "resume" ? "Resuming…" : "Resume now"}
              disabled={pending !== null}
              onPress={resumeNow}
            />
          ) : null}
          {autoResume ? (
            <BannerButton
              label={autoResume.scheduled ? "Cancel auto-resume" : "Resume at reset"}
              disabled={pending !== null}
              onPress={() => configure(!autoResume.scheduled)}
            />
          ) : null}
          {model.actions.snoozeUntilReset ? (
            <BannerButton label="Snooze until reset" disabled={pending !== null} onPress={snooze} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function requireApi(environmentId: EnvironmentId) {
  const api = readEnvironmentApi(environmentId);
  if (!api) throw new Error("The owning machine is not connected.");
  return api;
}

/** Runs one banner action; resolves to its failure text, or null when it went through. */
async function runUsageLimitAction(task: () => Promise<unknown>): Promise<string | null> {
  try {
    await task();
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : "The request failed.";
  }
}

function BannerButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled: boolean;
  readonly primary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className={`h-8 justify-center rounded-full px-3 active:opacity-70 disabled:opacity-40 ${
        props.primary ? "bg-primary" : "bg-subtle"
      }`}
    >
      <Text
        className={`text-xs font-ryco-medium ${
          props.primary ? "text-primary-foreground" : "text-foreground"
        }`}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
