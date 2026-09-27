import { mobileKV } from "../../../platform/kv";
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";
import type { EnvironmentId, ProviderInstanceId } from "@ryco/contracts";
import {
  getResetCreditController,
  resetCreditDetailLines,
  type ResetCreditApi,
} from "@ryco/client-runtime/usage";
import { readRpcClient } from "../../../connection/environmentApi";
import { uuidv4 } from "../../../lib/uuid";
import { AppText as Text } from "../../../components/AppText";
import { Note } from "./StatisticsParts";

export function CodexResetCredits({
  environmentId,
  instanceId,
  allowed,
  onRefresh,
}: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  allowed: boolean;
  onRefresh?: (() => void) | undefined;
}) {
  const controller = getResetCreditController(environmentId, instanceId, uuidv4, mobileKV);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const current = useRef({ allowed, controller });
  useLayoutEffect(() => {
    current.current = { allowed, controller };
    return () => {
      current.current.allowed = false;
    };
  }, [allowed, controller]);
  const ready = () => current.current.allowed && current.current.controller === controller;
  const api = useMemo<ResetCreditApi>(() => {
    const server = () => {
      const value = readRpcClient(environmentId)?.server;
      if (!value) throw new Error("Device disconnected.");
      return value;
    };
    return {
      readCodexResetCredits: (input) => server().readCodexResetCredits(input),
      consumeCodexResetCredit: (input) => server().consumeCodexResetCredit(input),
      refreshProviders: async (input) => {
        const result = await server().refreshProviders(input);
        onRefresh?.();
        return result;
      },
    };
  }, [environmentId, onRefresh]);
  const apiRef = useRef(api);
  useLayoutEffect(() => {
    apiRef.current = api;
  }, [api]);
  useEffect(() => {
    if (allowed)
      void controller.load(
        apiRef.current,
        () => current.current.allowed && current.current.controller === controller,
      );
    else controller.disconnect();
  }, [allowed, controller]);
  const busy =
    state.phase === "loading" || state.phase === "submitting" || state.phase === "refreshing";
  const mismatched = Boolean(
    state.attempt && state.account?.accountBinding !== state.attempt.accountBinding,
  );
  return (
    <View className="gap-2">
      <Text className="text-sm font-ryco-bold text-foreground">
        Banked resets{state.account?.credits ? ` · ${state.account.credits.availableCount}` : ""}
      </Text>
      {!allowed ? (
        <Note>Reconnect with account-change permission to use reset credits.</Note>
      ) : null}
      {busy ? (
        <Note>
          {state.phase === "refreshing"
            ? "Refreshing account limits…"
            : state.phase === "submitting"
              ? "Checking account and redeeming…"
              : "Loading reset credits…"}
        </Note>
      ) : null}
      {state.account
        ? resetCreditDetailLines(state.account).map((line) => <Note key={line}>{line}</Note>)
        : null}
      {state.account?.unavailableReason && state.account.credits ? (
        <Note>{state.account.unavailableReason}</Note>
      ) : null}
      {state.account?.accountLabel ? <Note>Account: {state.account.accountLabel}</Note> : null}
      {state.message ? <Note>{state.message}</Note> : null}
      {state.phase === "confirming" ? (
        <View accessibilityRole="alert" className="gap-2">
          <Note>
            Use one banked reset for {state.account?.accountLabel ?? "this Codex account"}? A credit
            is spent only if Codex accepts the reset. This cannot be undone.
          </Note>
          <ResetCreditButton
            label="Confirm redemption"
            disabled={!allowed}
            onPress={() => void controller.confirm(apiRef.current, ready)}
          />
          <ResetCreditButton label="Cancel" disabled={false} onPress={() => controller.cancel()} />
        </View>
      ) : state.attempt ? (
        <ResetCreditButton
          label="Retry same reset attempt"
          disabled={!allowed || busy || mismatched}
          onPress={() => void controller.confirm(apiRef.current, ready)}
        />
      ) : (
        <ResetCreditButton
          label="Use one reset…"
          disabled={
            !allowed ||
            busy ||
            !state.account?.accountBinding ||
            !(state.account.credits && state.account.credits.availableCount > 0)
          }
          onPress={() => controller.requestConfirmation(allowed)}
        />
      )}
      <ResetCreditButton
        label="Refresh resets"
        disabled={!allowed || busy}
        onPress={() => void controller.load(apiRef.current, ready)}
      />
    </View>
  );
}

function ResetCreditButton({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className="min-h-11 justify-center rounded-lg bg-card-alt px-3"
    >
      <Text className={disabled ? "text-foreground-muted" : "text-foreground"}>{label}</Text>
    </Pressable>
  );
}
