import type { GitActionProgressPhase, VcsStatusResult } from "@ryco/contracts";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import {
  createGitActionReporter,
  type GitActionNoticeKind,
  type GitActionReporter,
} from "~/gitActionNotices";
import { useEvent } from "~/hooks/useEvent";
import { formatCount } from "~/lib/formatCount";
import { randomUUID } from "~/lib/utils";
import {
  type GitShipStep,
  resolvePullAvailability,
  resolveShipPlan,
} from "../GitActionsControl.logic";
import type { CrownShipBinding, CrownShipPhase } from "../overview/crown/crownTypes";
import {
  GitDefaultBranchActionDialog,
  type GitActionRunnerInput,
  useGitActionRunner,
} from "../useGitActionRunner";

/** How long a click waits before shipping, so a second click or Escape can take it back. */
export const CROWN_SHIP_GRACE_MS = 1500;

const NO_STEPS: ReadonlyArray<GitShipStep> = [];

/** The server's stacked-action phases, as Ship steps (a new branch belongs to the commit). */
function stepForPhase(phase: GitActionProgressPhase): GitShipStep {
  return phase === "branch" ? "commit" : phase;
}

function shipStepDetails(status: VcsStatusResult | null): Readonly<Record<GitShipStep, string>> {
  return {
    pull: `${status?.behindCount ?? 0} incoming`,
    commit: formatCount(status?.workingTree.files.length ?? 0, "file"),
    push: status?.hasUpstream ? "to origin" : "new branch",
    pr: "for review",
  };
}

interface ShipRun {
  readonly phase: Exclude<CrownShipPhase, "idle">;
  readonly steps: ReadonlyArray<GitShipStep>;
  readonly activeStep: GitShipStep | null;
  readonly details: Readonly<Record<GitShipStep, string>>;
}

/**
 * The crown's Ship button for the thread's checkout. It runs the same git
 * actions as the split button (through {@link useGitActionRunner}), chained:
 * an optional pull, then the quick action's stacked commit / push / pull
 * request. The returned `dialog` asks before a run pushes to the default
 * branch; mount it next to the crown.
 */
export function useCrownShipBinding(input: GitActionRunnerInput & { readonly enabled: boolean }): {
  readonly ship: CrownShipBinding | undefined;
  readonly dialog: ReactNode;
} {
  const runner = useGitActionRunner(input);
  const {
    activeEnvironmentId,
    threadToastData,
    gitStatusForActions,
    isGitActionRunning,
    isDefaultRef,
    hasPrimaryRemote,
    changeRequestTerminology,
  } = runner;
  const { runGitActionWithToast, runPull, openExistingPr } = runner;
  const { gitCwd, enabled } = input;

  const plan = useMemo(
    () => resolveShipPlan(gitStatusForActions, isGitActionRunning, isDefaultRef, hasPrimaryRemote),
    [gitStatusForActions, hasPrimaryRemote, isDefaultRef, isGitActionRunning],
  );
  const pullAvailability = resolvePullAvailability(gitStatusForActions, isGitActionRunning);
  const stepDetails = useMemo(() => shipStepDetails(gitStatusForActions), [gitStatusForActions]);
  const diverged =
    (gitStatusForActions?.aheadCount ?? 0) > 0 && (gitStatusForActions?.behindCount ?? 0) > 0;

  const [run, setRun] = useState<ShipRun | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const armRef = useRef<{ readonly reporter: GitActionReporter; readonly timer: number } | null>(
    null,
  );

  const cancel = useEvent(() => {
    const arm = armRef.current;
    if (!arm) return;
    armRef.current = null;
    window.clearTimeout(arm.timer);
    arm.reporter.cancelled({ title: "Ship cancelled", description: "Nothing was changed." });
    setRun(null);
  });

  const start = useEvent(async () => {
    const arm = armRef.current;
    if (!arm) return;
    armRef.current = null;
    // The checkout may have moved during the grace: run what is left now.
    if (plan.steps.length === 0) {
      arm.reporter.cancelled({ title: "Nothing to ship", description: plan.disabledReason ?? "" });
      setRun(null);
      return;
    }
    // Each step reports itself from here on, replacing the "in a moment" notice.
    arm.reporter.dismiss();
    const { steps, action } = plan;
    const message = steps.includes("commit") ? commitMessage.trim() : "";
    if (message) setCommitMessage("");
    setRun({ phase: "running", steps, activeStep: steps[0] ?? null, details: stepDetails });
    try {
      if (steps[0] === "pull") {
        const pulled = await runPull();
        if (!pulled) return;
      }
      if (action) {
        const firstAfterPull = steps.find((step) => step !== "pull") ?? null;
        setRun((current) => current && { ...current, activeStep: firstAfterPull });
        await runGitActionWithToast({
          action,
          ...(message ? { commitMessage: message } : {}),
          onProgressPhase: (phase) =>
            setRun((current) => current && { ...current, activeStep: stepForPhase(phase) }),
        });
      }
    } finally {
      setRun(null);
    }
  });

  const ship = useEvent(() => {
    if (armRef.current) {
      cancel();
      return;
    }
    if (run) return;
    if (plan.opensPullRequest) {
      void openExistingPr();
      return;
    }
    if (plan.steps.length === 0) return;
    // The waiting notice belongs to the Ship button (the branch section), whatever runs last.
    const kind: GitActionNoticeKind = plan.steps.every((step) => step === "pull") ? "pull" : "push";
    const reporter = createGitActionReporter({
      id: randomUUID(),
      kind,
      environmentId: activeEnvironmentId,
      cwd: gitCwd,
      toastData: threadToastData,
    });
    reporter.running("Shipping in a moment…", `${plan.label} · click again or Esc to cancel`);
    armRef.current = {
      reporter,
      timer: window.setTimeout(() => void start(), CROWN_SHIP_GRACE_MS),
    };
    setRun({ phase: "arming", steps: plan.steps, activeStep: null, details: stepDetails });
  });

  // Escape takes an armed click back; leaving the thread cancels it too.
  const arming = run?.phase === "arming";
  useEffect(() => {
    if (!arming) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [arming, cancel]);
  useEffect(() => {
    if (!gitCwd) return;
    return () => cancel();
  }, [cancel, gitCwd]);

  const commitOnly = useEvent(() => {
    const message = commitMessage.trim();
    if (message) setCommitMessage("");
    void runGitActionWithToast({
      action: "commit",
      ...(message ? { commitMessage: message } : {}),
    });
  });

  const hasChanges = gitStatusForActions?.hasWorkingTreeChanges ?? false;
  const hasOpenPr = gitStatusForActions?.pr?.state === "open";
  const idle = run === null && !isGitActionRunning;

  const binding = useMemo<CrownShipBinding>(
    () => ({
      steps: plan.steps,
      label: plan.label,
      disabledReason: plan.disabledReason,
      changeRequestLabel: changeRequestTerminology.shortLabel,
      phase: run?.phase ?? "idle",
      runSteps: run?.steps ?? NO_STEPS,
      activeStep: run?.activeStep ?? null,
      stepDetails: run?.details ?? stepDetails,
      ship,
      commitMessage,
      setCommitMessage,
      commitOnly: idle && hasChanges ? commitOnly : null,
      pull: idle && !diverged && pullAvailability.disabledReason === null ? runPull : null,
      openPullRequest: hasOpenPr ? () => void openExistingPr() : null,
    }),
    [
      plan,
      changeRequestTerminology.shortLabel,
      run,
      stepDetails,
      ship,
      commitMessage,
      idle,
      commitOnly,
      hasChanges,
      diverged,
      pullAvailability.disabledReason,
      hasOpenPr,
      runPull,
      openExistingPr,
    ],
  );

  return {
    ship: enabled && gitCwd ? binding : undefined,
    dialog: <GitDefaultBranchActionDialog runner={runner} />,
  };
}
