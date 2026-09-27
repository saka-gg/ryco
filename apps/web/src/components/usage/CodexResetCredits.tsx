import { webKV } from "../../platform/kv";
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { ProviderInstanceId } from "@ryco/contracts";
import {
  getResetCreditController,
  resetCreditDetailLines,
  type ResetCreditApi,
  type ResetCreditController,
} from "@ryco/client-runtime/usage";
import { Button } from "../ui/button";

export function CodexResetCredits({
  environmentId,
  instanceId,
  api,
  allowed,
  controller: supplied,
}: {
  environmentId: string;
  instanceId: ProviderInstanceId;
  api: ResetCreditApi;
  allowed: boolean;
  controller?: ResetCreditController;
}) {
  const controller =
    supplied ??
    getResetCreditController(environmentId, instanceId, () => crypto.randomUUID(), webKV);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const current = useRef({ api, allowed, controller });
  useLayoutEffect(() => {
    current.current = { api, allowed, controller };
    return () => {
      current.current.allowed = false;
    };
  }, [api, allowed, controller]);
  const ready = () => current.current.allowed && current.current.controller === controller;
  useEffect(() => {
    if (allowed)
      void controller.load(
        current.current.api,
        () => current.current.allowed && current.current.controller === controller,
      );
    else controller.disconnect();
  }, [controller, allowed]);
  const busy =
    state.phase === "loading" || state.phase === "submitting" || state.phase === "refreshing";
  const mismatched = Boolean(
    state.attempt && state.account?.accountBinding !== state.attempt.accountBinding,
  );
  return (
    <section
      aria-label="Codex reset credits"
      className="phone:hidden space-y-2 border-t border-border/60 px-4 py-3 text-xs sm:px-5"
    >
      <div className="flex items-center justify-between gap-3">
        <strong>
          Banked resets {state.account?.credits ? `· ${state.account.credits.availableCount}` : ""}
        </strong>
        <Button
          size="xs"
          variant="outline"
          disabled={!allowed || busy}
          onClick={() => void controller.load(current.current.api, ready)}
        >
          Refresh resets
        </Button>
      </div>
      {!allowed ? (
        <p>Reset credits unavailable until this connection permits account changes.</p>
      ) : null}
      {busy ? (
        <p role="status">
          {state.phase === "refreshing"
            ? "Refreshing account limits…"
            : state.phase === "submitting"
              ? "Checking account and redeeming…"
              : "Loading reset credits…"}
        </p>
      ) : null}
      {state.account
        ? resetCreditDetailLines(state.account).map((line) => (
            <p className="text-muted-foreground" key={line}>
              {line}
            </p>
          ))
        : null}
      {state.account?.unavailableReason && state.account.credits ? (
        <p>{state.account.unavailableReason}</p>
      ) : null}
      {state.account?.accountLabel ? <p>Account: {state.account.accountLabel}</p> : null}
      {state.message ? <p role="status">{state.message}</p> : null}
      {state.phase === "confirming" ? (
        <div role="alertdialog" aria-label="Confirm reset credit redemption" className="space-y-2">
          <p>
            Use one banked reset for {state.account?.accountLabel ?? "this Codex account"}? A credit
            is spent only if Codex accepts the reset. This cannot be undone.
          </p>
          <div className="flex gap-2">
            <Button
              size="xs"
              disabled={!allowed}
              onClick={() => void controller.confirm(current.current.api, ready)}
            >
              Confirm redemption
            </Button>
            <Button size="xs" variant="outline" onClick={() => controller.cancel()}>
              Cancel
            </Button>
          </div>
        </div>
      ) : state.attempt ? (
        <Button
          size="xs"
          disabled={!allowed || busy || mismatched}
          onClick={() => void controller.confirm(current.current.api, ready)}
        >
          Retry same reset attempt
        </Button>
      ) : (
        <Button
          size="xs"
          disabled={
            !allowed ||
            busy ||
            !state.account?.accountBinding ||
            !(state.account.credits && state.account.credits.availableCount > 0)
          }
          onClick={() => controller.requestConfirmation(allowed)}
        >
          Use one reset…
        </Button>
      )}
    </section>
  );
}
