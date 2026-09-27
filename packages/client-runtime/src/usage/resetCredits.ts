import { Schema } from "effect";
import { CodexResetCreditInput as ResetInputSchema } from "@ryco/contracts";
import type { KVService } from "../platform/index.ts";
import type {
  CodexResetCreditAccount,
  CodexResetCreditInput,
  CodexResetCreditOutcome,
  ProviderInstanceId,
} from "@ryco/contracts";

export interface ResetCreditApi {
  readCodexResetCredits(input: {
    instanceId: ProviderInstanceId;
  }): Promise<CodexResetCreditAccount>;
  consumeCodexResetCredit(
    input: CodexResetCreditInput,
  ): Promise<{ outcome: CodexResetCreditOutcome }>;
  refreshProviders(input: { instanceId: ProviderInstanceId }): Promise<unknown>;
}
export interface ResetCreditState {
  readonly phase:
    | "idle"
    | "loading"
    | "ready"
    | "confirming"
    | "submitting"
    | "refreshing"
    | "uncertain"
    | "settled"
    | "error";
  readonly account?: CodexResetCreditAccount;
  readonly message?: string | undefined;
  readonly attempt?: CodexResetCreditInput;
}
export const resetOutcomeMessage: Record<CodexResetCreditOutcome, string> = {
  reset: "Reset redeemed.",
  alreadyRedeemed: "This reset was already redeemed.",
  noCredit: "No reset credits are available. No credit was consumed.",
  nothingToReset: "There is no eligible limit to reset. No credit was consumed.",
};

/** Platform-neutral state retained independently of UI lifetime/transport sessions.
 * No automatic consumption, no fresh key on an uncertain retry. Callers must pass
 * their current mutation-readiness decision for every operation.
 */
export function createResetCreditController(
  instanceId: ProviderInstanceId,
  newKey: () => string,
  persistence?: { kv: KVService; key: string },
) {
  let state: ResetCreditState = { phase: "idle" };
  const listeners = new Set<() => void>();
  let generation = 0;
  let busy = false;
  const publish = (next: ResetCreditState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  let hydration: Promise<void> | undefined;
  const hydrate = () =>
    (hydration ??= (async () => {
      if (!persistence) return;
      const stored = await persistence.kv.getItem(persistence.key);
      if (stored === null) return;
      const saved = JSON.parse(stored);
      if (saved.scope !== persistence.key) throw new Error("Stored reset environment mismatch.");
      const attempt = Schema.decodeUnknownSync(ResetInputSchema)(saved.attempt);
      if (attempt.instanceId !== instanceId) throw new Error("Stored reset account mismatch.");
      publish({ ...state, attempt, phase: "uncertain" });
    })().catch((error: unknown) => {
      hydration = undefined;
      throw error;
    }));
  return {
    getSnapshot: () => state,
    canDispose: () =>
      listeners.size === 0 &&
      !busy &&
      !state.attempt &&
      state.phase !== "loading" &&
      state.phase !== "confirming",
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    disconnect() {
      generation++;
      if (busy) return; // In-flight consumption must settle or become uncertain.
      publish({
        ...state,
        phase: state.attempt ? "uncertain" : "idle",
        message: "Reconnect before using reset credits.",
      });
    },
    async load(api: ResetCreditApi, allowed: () => boolean) {
      if (busy || !allowed()) return;
      const current = ++generation;
      publish({ ...state, phase: "loading" });
      try {
        await hydrate();
        if (current !== generation || !allowed()) return;
        const account = await api.readCodexResetCredits({ instanceId });
        if (current !== generation || !allowed()) return;
        publish({
          ...state,
          account,
          phase: state.attempt ? "uncertain" : "ready",
          ...(state.attempt
            ? {
                message:
                  "An earlier result is uncertain. Retry the same attempt for its confirmed account.",
              }
            : { message: undefined }),
        });
      } catch {
        if (current !== generation) return;
        publish({
          ...state,
          phase: state.attempt ? "uncertain" : "error",
          message:
            "Could not load reset credits or the saved attempt. Retry when storage and the provider are available.",
        });
      }
    },
    requestConfirmation(allowed: boolean) {
      if (
        !allowed ||
        busy ||
        (state.phase !== "ready" && state.phase !== "settled") ||
        state.attempt ||
        !state.account?.accountBinding ||
        !(state.account.credits && state.account.credits.availableCount > 0)
      )
        return;
      publish({ ...state, phase: "confirming", message: undefined });
    },
    cancel() {
      if (state.phase === "confirming") publish({ ...state, phase: "ready" });
    },
    async confirm(api: ResetCreditApi, allowed: () => boolean) {
      if (busy || !allowed() || (state.phase !== "confirming" && state.phase !== "uncertain"))
        return;
      const binding = state.attempt?.accountBinding ?? state.account?.accountBinding;
      if (!binding || (state.account?.accountBinding && state.account.accountBinding !== binding))
        return;
      const attempt = state.attempt ?? {
        instanceId,
        accountBinding: binding,
        idempotencyKey: newKey(),
      };
      generation++;
      busy = true;
      publish({ ...state, attempt, phase: "submitting", message: undefined });
      try {
        if (persistence)
          await persistence.kv.setItem(
            persistence.key,
            JSON.stringify({ scope: persistence.key, attempt }),
          );
        const account = await api.readCodexResetCredits({ instanceId });
        if (!allowed() || account.accountBinding !== attempt.accountBinding) {
          publish({
            ...state,
            account,
            phase: "uncertain",
            message:
              "Account or connection changed. Return to the confirmed account before retrying this attempt.",
          });
          return;
        }
        const result = await api.consumeCodexResetCredit(attempt);
        // Clear only after a definite protocol outcome, never after transport errors.
        try {
          if (persistence) await persistence.kv.removeItem(persistence.key);
          publish({
            account,
            phase: "refreshing",
            message: `${resetOutcomeMessage[result.outcome]} Refreshing account limits…`,
          });
        } catch {
          publish({
            account,
            attempt,
            phase: "uncertain",
            message:
              "Reset outcome confirmed, but its completion could not be saved. Retry the same attempt to reconcile it.",
          });
        }
        try {
          await api.refreshProviders({ instanceId });
          const refreshed = await api.readCodexResetCredits({ instanceId });
          publish({
            ...state,
            phase: state.attempt ? "uncertain" : "settled",
            ...(allowed() ? { account: refreshed } : {}),
            message: state.attempt
              ? state.message
              : `${resetOutcomeMessage[result.outcome]} Account limits refreshed.`,
          });
        } catch {
          publish({
            ...state,
            phase: state.attempt ? "uncertain" : "settled",
            message: `${resetOutcomeMessage[result.outcome]} Limits could not be refreshed; refresh usage.`,
          });
        }
      } catch {
        publish({
          ...state,
          attempt,
          phase: "uncertain",
          message: "The reset result is uncertain. Retry the same attempt; its key will be reused.",
        });
      } finally {
        busy = false;
      }
    },
  };
}
export type ResetCreditController = ReturnType<typeof createResetCreditController>;
const controllers = new Map<string, ResetCreditController>();
export function getResetCreditController(
  environmentId: string,
  instanceId: ProviderInstanceId,
  newKey: () => string,
  kv?: KVService,
): ResetCreditController {
  const key = JSON.stringify([environmentId, instanceId]);
  // Never evict an in-flight/uncertain attempt. Settled unmounted controllers
  // are cheap to recreate and should not accumulate as environments are removed.
  if (controllers.size >= 64) {
    for (const [entry, candidate] of controllers) {
      if (entry !== key && candidate.canDispose()) controllers.delete(entry);
      if (controllers.size < 64) break;
    }
  }
  let controller = controllers.get(key);
  if (!controller) {
    controller = createResetCreditController(
      instanceId,
      newKey,
      kv ? { kv, key: `ryco:codex-reset-attempt:${key}` } : undefined,
    );
    controllers.set(key, controller);
  }
  return controller;
}

export function resetCreditDetailLines(account: CodexResetCreditAccount): readonly string[] {
  const summary = account.credits;
  if (!summary) return [account.unavailableReason ?? "Reset credits unavailable."];
  if (summary.credits === undefined)
    return ["Credit details are not available; only the count is known."];
  if (summary.credits.length === 0) return ["No available credit details were returned."];
  return summary.credits.map((credit) => {
    const expiry =
      credit.expiresAt === null
        ? "Does not expire"
        : credit.expiresAt === undefined
          ? "Expiry unknown"
          : `Expires ${new Date(credit.expiresAt * 1000).toLocaleString()}`;
    return `${credit.title || "Earned reset"} · ${credit.status} · Granted ${new Date(credit.grantedAt * 1000).toLocaleString()} · ${expiry}${credit.description ? ` · ${credit.description}` : ""}`;
  });
}
