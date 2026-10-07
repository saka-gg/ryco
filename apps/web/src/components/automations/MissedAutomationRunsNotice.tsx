/**
 * Tells the user when a device's scheduler caught up on runs that came due
 * while its server was not running — this app's own server after a launch,
 * or a saved / Hub device once it is reachable again. One notice per device,
 * shown once per run: answering or dismissing it remembers the runs.
 */
import {
  AGENT_CONTROL_WS_METHODS,
  type AgentControlAutomationRunId,
  type AgentControlProposal,
  type EnvironmentId,
} from "@ryco/contracts";
import {
  collectMissedAutomationRuns,
  missedAutomationRunOf,
  useAgentControlStore,
  type MissedAutomationRun,
} from "@ryco/client-runtime/state/agentControl";
import { CalendarClockIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import { readEnvironmentApi } from "../../environmentApi";
import { readEnvironmentConnection } from "../../environments/runtime";
import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { openAutomationsDialog } from "./automationsDialogStore";
import { useAutomationProposalSync } from "./data/useAutomationProposalSync";
import { useConnectedEnvironmentIds } from "./data/useConnectedEnvironmentIds";
import { missedRunsNoticeView, type MissedRunsNoticeView } from "./missedRunsNotice.logic";

const NOTICED_STORAGE_KEY = "ryco:missed-automation-runs:v1";
/** Runs remembered as noticed; the oldest are let go well after their notice window. */
const NOTICED_LIMIT = 200;
const Noticed = Schema.Array(Schema.String);

const noticedKey = (environmentId: EnvironmentId, runId: AgentControlAutomationRunId) =>
  `${environmentId}:${runId}`;

function restoreNoticed(): readonly string[] {
  try {
    return getLocalStorageItem(NOTICED_STORAGE_KEY, Noticed) ?? [];
  } catch {
    return [];
  }
}

/** Runs whose notice was answered or dismissed, oldest first (persisted). */
const useNoticedStore = create<{ readonly keys: readonly string[] }>()(() => ({
  keys: restoreNoticed(),
}));

function markNoticed(environmentId: EnvironmentId, runs: readonly MissedAutomationRun[]): void {
  const { keys } = useNoticedStore.getState();
  const added = runs
    .map((run) => noticedKey(environmentId, run.runId))
    .filter((key) => !keys.includes(key));
  if (added.length === 0) return;
  const next = [...keys, ...added].slice(-NOTICED_LIMIT);
  useNoticedStore.setState({ keys: next });
  try {
    setLocalStorageItem(NOTICED_STORAGE_KEY, next, Noticed);
  } catch {
    // Best-effort: a full or unavailable storage keeps it for this session.
  }
}

/** Test-only: nothing noticed yet. */
export function resetNoticedMissedRunsForTests(): void {
  useNoticedStore.setState({ keys: [] });
}

const NO_PROPOSALS: readonly AgentControlProposal[] = [];
const NO_RUNS: readonly MissedAutomationRun[] = [];

type ToastId = ReturnType<typeof toastManager.add>;

function MissedAutomationRunsNoticeForEnvironment({
  environmentId,
  canDecide,
}: {
  readonly environmentId: EnvironmentId;
  readonly canDecide: boolean;
}) {
  // The notice window counts back from launch; catch-ups proposed since are always news.
  const [mountedAtMs] = useState(() => Date.now());
  // The catch-up proposals alone, so other traffic on the device's queue leaves them be.
  const proposals = useAgentControlStore(
    useShallow((state) => {
      const queue = state.queueByEnvironmentId[environmentId];
      if (!queue?.hydrated) return NO_PROPOSALS;
      return Object.values(queue.proposalsById).filter(
        (proposal) => missedAutomationRunOf(proposal, mountedAtMs) !== null,
      );
    }),
  );
  const noticed = useNoticedStore((state) => state.keys);
  const runs = useMemo(() => {
    const seen = new Set(noticed);
    const fresh = collectMissedAutomationRuns(proposals, mountedAtMs).filter(
      (run) => !seen.has(noticedKey(environmentId, run.runId)),
    );
    return fresh.length > 0 ? fresh : NO_RUNS;
  }, [environmentId, mountedAtMs, noticed, proposals]);

  /* The notice on screen and the runs it names; actions read the latest. */
  const toastRef = useRef<ToastId | null>(null);
  const runsRef = useRef(runs);

  useEffect(() => {
    runsRef.current = runs;
    const toastId = toastRef.current;
    if (runs.length === 0) {
      // Answered elsewhere (approved, rejected) or noticed: nothing left to say.
      if (toastId !== null) toastManager.close(toastId);
      toastRef.current = null;
      return;
    }
    const connection = readEnvironmentConnection(environmentId);
    const view = missedRunsNoticeView(runs, {
      deviceLabel: connection?.kind === "saved" ? connection.knownEnvironment.label : null,
      nowMs: Date.now(),
    });

    const settle = () => {
      markNoticed(environmentId, runsRef.current);
      if (toastRef.current !== null) toastManager.close(toastRef.current);
      toastRef.current = null;
    };
    const openRun = (run: MissedAutomationRun) =>
      openAutomationsDialog({
        environmentId,
        projectId: run.projectId,
        automationId: run.automationId,
      });
    const review = () => {
      const [first] = runsRef.current;
      settle();
      if (first) openRun(first);
    };
    const runNow = () => {
      const [only] = runsRef.current;
      settle();
      const api = readEnvironmentApi(environmentId)?.agentControl;
      if (!only || !api) return;
      api.acceptProposal({ proposalId: only.proposalId }).catch((error: unknown) => {
        const failureId = toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Couldn't start ${only.title}`,
            description:
              error instanceof Error && error.message.length > 0
                ? error.message
                : "The run could not be approved. Review it in Automations.",
            actionProps: {
              children: "Review",
              onClick: () => {
                toastManager.close(failureId);
                openRun(only);
              },
            },
          }),
        );
      });
    };

    const toast = noticeToast(view, {
      runNow: view.canRunNow && canDecide ? runNow : null,
      review,
      dismiss: () => {
        markNoticed(environmentId, runsRef.current);
        toastRef.current = null;
      },
    });
    if (toastId === null) toastRef.current = toastManager.add(toast);
    else toastManager.update(toastId, toast);
  }, [canDecide, environmentId, runs]);

  // A device that disconnects takes its notice along; it returns, unnoticed, with the device.
  useEffect(
    () => () => {
      if (toastRef.current !== null) toastManager.close(toastRef.current);
      toastRef.current = null;
    },
    [],
  );

  return null;
}

function noticeToast(
  view: MissedRunsNoticeView,
  actions: {
    readonly runNow: (() => void) | null;
    readonly review: () => void;
    readonly dismiss: () => void;
  },
) {
  return stackedThreadToast({
    type: "info",
    title: view.title,
    description: view.description,
    timeout: 0,
    actionProps: actions.runNow
      ? { children: "Run now", onClick: actions.runNow }
      : { children: "Review", onClick: actions.review },
    actionVariant: actions.runNow ? "default" : "outline",
    // A fresh `data` on every update, so a notice that loses "Run now" loses its second action too.
    data: {
      leadingIcon: <CalendarClockIcon className="size-4" />,
      hideCopyButton: true,
      onClose: actions.dismiss,
      ...(actions.runNow
        ? {
            secondaryActionProps: { children: "Review", onClick: actions.review },
            secondaryActionVariant: "outline" as const,
          }
        : {}),
    },
  });
}

/**
 * Missed-run notices for every connected device. Off where automations are
 * (a hosted role without the automation centre, the frozen phone tier).
 */
export function MissedAutomationRunsNotice() {
  const capability = useHostedRpcCapability(AGENT_CONTROL_WS_METHODS.automationCentre);
  const phone = usePresentationTier() === "phone";
  if (!capability.allowed || phone) return null;
  return <MissedAutomationRunsNotices />;
}

function MissedAutomationRunsNotices() {
  const decision = useHostedRpcCapability(AGENT_CONTROL_WS_METHODS.acceptProposal);
  const environmentIds = useConnectedEnvironmentIds();
  useAutomationProposalSync(environmentIds);
  return environmentIds.map((environmentId) => (
    <MissedAutomationRunsNoticeForEnvironment
      key={environmentId}
      environmentId={environmentId}
      canDecide={decision.allowed}
    />
  ));
}
