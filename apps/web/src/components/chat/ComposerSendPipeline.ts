import type { SessionPhase } from "../../types";
import { deriveComposerSendState } from "../ChatView.logic";

export { deriveComposerSendState };

/**
 * Whether the collapsed (mobile) composer's primary send action should be
 * disabled. Pure mirror of the inline guard used by the collapsed prompt row.
 */
export function isComposerPrimaryActionDisabled(options: {
  phase: SessionPhase;
  isSendBusy: boolean;
  isConnecting: boolean;
  hasSendableContent: boolean;
}): boolean {
  return (
    options.phase === "running" ||
    options.isSendBusy ||
    options.isConnecting ||
    !options.hasSendableContent
  );
}

/**
 * Whether submitting the composer should blur/collapse the mobile composer.
 * Mirrors the inline `shouldBlurMobileComposerOnSubmit` logic so it can be
 * unit-tested without React.
 */
export function shouldBlurComposerOnSubmit(options: {
  isMobileViewport: boolean;
  isSendBusy: boolean;
  isConnecting: boolean;
  phase: SessionPhase;
  pendingProgress: { isLastQuestion: boolean } | null;
  hasResolvedAnswers: boolean;
  showPlanFollowUpPrompt: boolean;
  hasSendableContent: boolean;
}): boolean {
  if (!options.isMobileViewport) return false;
  if (options.isSendBusy || options.isConnecting || options.phase === "running") return false;
  if (options.pendingProgress) {
    return options.pendingProgress.isLastQuestion && options.hasResolvedAnswers;
  }
  return options.showPlanFollowUpPrompt || options.hasSendableContent;
}

/**
 * Stable key describing the current footer action layout. Used to retrigger
 * footer compactness remeasurement when the visible action set changes.
 */
export function deriveComposerFooterActionLayoutKey(options: {
  pendingProgress: { questionIndex: number; isLastQuestion: boolean } | null;
  pendingIsResponding: boolean;
  phase: SessionPhase;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  hasSendableContent: boolean;
  isSendBusy: boolean;
  isConnecting: boolean;
  isPreparingWorktree: boolean;
}): string {
  if (options.pendingProgress) {
    return `pending:${options.pendingProgress.questionIndex}:${options.pendingProgress.isLastQuestion}:${options.pendingIsResponding}`;
  }
  if (options.phase === "running") {
    return "running";
  }
  if (options.showPlanFollowUpPrompt) {
    return options.promptHasText ? "plan:refine" : "plan:implement";
  }
  return `idle:${options.hasSendableContent}:${options.isSendBusy}:${options.isConnecting}:${options.isPreparingWorktree}`;
}
