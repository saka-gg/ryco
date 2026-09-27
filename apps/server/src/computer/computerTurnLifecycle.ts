import { parseComputerInvocation } from "@ryco/shared/computerInvocation";
import {
  computerForegroundAuthorizationForMessages,
  messageRequestsVisibleUse,
} from "./computerVisibleUse.ts";
import type { ComputerTurnIntent, RuntimeMode } from "@ryco/contracts";

export interface ComputerTurnPlan {
  readonly intent: ComputerTurnIntent;
  readonly text: string;
  readonly runtimeMode: RuntimeMode;
  readonly label: string;
  readonly visibleIntentText?: string;
  readonly foregroundAuthorized?: boolean;
  readonly createdAt?: string;
  readonly previousAssistantText?: string;
}
// Private process-local staging, populated only from the accepted turn event.
// Native authority is separately checked against the desktop generation and the
// registry's exact active turn on every call.
const plans = new Map<string, ComputerTurnPlan>();
const boundTurns = new WeakMap<ComputerTurnPlan, string>();
const retirementListeners = new Set<(threadId: string, turnId: string) => void>();
export function stageComputerTurn(threadId: string, plan: ComputerTurnPlan | undefined): void {
  const prior = plans.get(threadId);
  plans.delete(threadId);
  if (plan) {
    const text = parseComputerInvocation(plan.text)?.prompt ?? plan.text;
    const priorText =
      prior?.intent.generation === plan.intent.generation ? prior.visibleIntentText : undefined;
    const authorized = computerForegroundAuthorizationForMessages([
      ...(priorText
        ? [
            {
              id: "prior",
              role: "user" as const,
              source: "native",
              streaming: false,
              text: priorText,
            },
          ]
        : []),
      ...(prior?.intent.generation === plan.intent.generation && plan.previousAssistantText
        ? [
            {
              id: "question",
              role: "assistant" as const,
              source: "native",
              streaming: false,
              text: plan.previousAssistantText,
            },
          ]
        : []),
      { id: "current", role: "user", source: "native", streaming: false, text },
    ]).userRequestedVisibleUse;
    plans.set(threadId, {
      ...plan,
      foregroundAuthorized: authorized,
      ...(authorized
        ? {
            visibleIntentText: messageRequestsVisibleUse(text)
              ? text
              : (priorText ?? plan.previousAssistantText ?? text),
          }
        : {}),
    });
  }
  while (plans.size > 256) plans.delete(plans.keys().next().value!);
}
export function computerTurnPlan(threadId: string): ComputerTurnPlan | undefined {
  return plans.get(threadId);
}
export function retireComputerTurn(threadId: string, turnId: string): void {
  for (const listener of retirementListeners) listener(threadId, turnId);
}
export function onComputerTurnRetired(
  listener: (threadId: string, turnId: string) => void,
): () => void {
  retirementListeners.add(listener);
  return () => {
    retirementListeners.delete(listener);
  };
}

/** One accepted human request may authorize only the first exact runtime turn bound to it. */
export function bindComputerTurn(threadId: string, turnId: string): void {
  const plan = plans.get(threadId);
  if (plan && !boundTurns.has(plan)) boundTurns.set(plan, turnId);
}
export function computerTurnPlanForAuthority(
  threadId: string,
  turnId: string,
): ComputerTurnPlan | undefined {
  const plan = plans.get(threadId);
  return plan && boundTurns.get(plan) === turnId ? plan : undefined;
}
