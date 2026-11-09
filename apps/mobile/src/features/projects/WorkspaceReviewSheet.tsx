import {
  resolveWorkspaceReview,
  WORKSPACE_REVIEW_PREVIEW_FAILED,
  workspaceReviewConfirmLabel,
  workspaceReviewEffectParts,
  workspaceReviewErrorMessage,
  type WorkspaceReviewFailure,
  type WorkspaceReviewPreview,
} from "@ryco/client-runtime/projectSettings/workspaceReview";
import { workspaceActionRequest } from "@ryco/client-runtime/state/lifecycle";
import type { EnvironmentId, WorktreeId } from "@ryco/contracts";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, Switch, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { useEnvironmentApi } from "../../connection/useEnvironmentApi";
import { useThemeColor } from "../../lib/useThemeColor";
import { applyWorkspaceDelete } from "./projectSettingsActions";
import { workspaceReviewConversationCopy } from "./projectSettingsModel";

export interface WorkspaceReviewTarget {
  readonly environmentId: EnvironmentId;
  readonly worktreeId: WorktreeId;
  /** The workspace's name as its row shows it. */
  readonly title: string;
}

type Phase =
  | { readonly kind: "review" }
  | { readonly kind: "applying" }
  | { readonly kind: "failed"; readonly failure: WorkspaceReviewFailure };

/**
 * "Delete workspace", reviewed in a sheet before anything changes. Everything it states comes
 * from the machine's preview, and Delete applies exactly that preview (its fingerprint): a
 * workspace that changed in between is refused, never guessed at. Deleting removes the checkout
 * and its branch; work that exists only there is spelled out and the button says "Delete
 * anyway". The workspace's conversations stay in the archive unless the reader deletes them too.
 * A partial or failed run stays here with what happened and a Retry that inspects again.
 */
export function WorkspaceReviewSheet(props: {
  readonly visible: boolean;
  /** The last workspace opened; it stays on screen while the sheet slides away. */
  readonly target: WorkspaceReviewTarget | null;
  /** Bumps on every open, so the review inside starts fresh. */
  readonly token: number;
  /** Viewers and machines not ready for changes see the review but cannot confirm it. */
  readonly canApply: boolean;
  /** Why the reader may not inspect workspaces on this machine, or null when they may. */
  readonly previewDenied: string | null;
  /** Said under the button when the review cannot be confirmed. */
  readonly accessReason: string | null;
  readonly onClose: () => void;
  /** Something may have changed: lists inspect again. */
  readonly onChanged: () => void;
}) {
  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      {props.target ? (
        <WorkspaceReviewBody
          key={`${props.target.worktreeId}:${props.token}`}
          target={props.target}
          canApply={props.canApply}
          previewDenied={props.previewDenied}
          accessReason={props.accessReason}
          onClose={props.onClose}
          onChanged={props.onChanged}
        />
      ) : (
        <View className="flex-1 bg-screen" />
      )}
    </Modal>
  );
}

function WorkspaceReviewBody(props: {
  readonly target: WorkspaceReviewTarget;
  readonly canApply: boolean;
  readonly previewDenied: string | null;
  readonly accessReason: string | null;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}) {
  const { target, onClose, onChanged } = props;
  const { environmentId, worktreeId } = target;
  const api = useEnvironmentApi(environmentId);
  const lifecycle = props.previewDenied === null ? api?.lifecycle : undefined;
  const summarizeChanges = lifecycle?.summarizeChanges;
  const dangerColor = useThemeColor("--color-danger-foreground");
  const [deleteConversations, setDeleteConversations] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "review" });
  const previewKey = `${worktreeId}\u0000${deleteConversations}\u0000${attempt}`;
  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly value: WorkspaceReviewPreview;
  } | null>(null);

  useEffect(() => {
    if (!lifecycle) return;
    let cancelled = false;
    lifecycle
      .previewWorkspace({
        worktreeId,
        ...workspaceActionRequest("delete-workspace", { deleteConversations }),
      })
      .then(
        (preview): WorkspaceReviewPreview => ({ status: "ready", preview }),
        (error: unknown): WorkspaceReviewPreview => ({
          status: "error",
          message: workspaceReviewErrorMessage(error, WORKSPACE_REVIEW_PREVIEW_FAILED),
        }),
      )
      .then((value) => {
        if (!cancelled) setLoaded({ key: previewKey, value });
      });
    return () => {
      cancelled = true;
    };
  }, [deleteConversations, lifecycle, previewKey, worktreeId]);

  const review = resolveWorkspaceReview({
    previewDenied: props.previewDenied,
    lifecycleAvailable: lifecycle !== undefined,
    current: loaded?.key === previewKey ? loaded.value : null,
    last: loaded?.value ?? null,
  });
  const { view, preview, shown, refreshing, blocked, lostWork, losesWork, conversationCount } =
    review;
  const busy = phase.kind === "applying";
  const failure = phase.kind === "failed" ? phase.failure : null;
  const effect = shown ? workspaceReviewEffectParts(shown) : null;
  const branch = shown?.workspace.branch ?? null;

  // What would be lost, described by the machine's model when it can: asked once per open, only
  // when something would be lost. Informational only; the fingerprint never depends on it.
  const [workDescription, setWorkDescription] = useState<{ readonly text: string | null } | null>(
    null,
  );
  const describeRequested = useRef(false);
  const describable = losesWork && summarizeChanges !== undefined;
  useEffect(() => {
    if (!describable || !summarizeChanges || describeRequested.current) return;
    describeRequested.current = true;
    let current = true;
    summarizeChanges({ worktreeId }).then(
      (result) => {
        if (current) setWorkDescription({ text: result.summary?.trim() || null });
      },
      () => {
        if (current) setWorkDescription({ text: null });
      },
    );
    return () => {
      current = false;
    };
  }, [describable, summarizeChanges, worktreeId]);

  const retry = () => {
    setPhase({ kind: "review" });
    setAttempt((value) => value + 1);
  };

  const apply = () => {
    if (!preview) return;
    setPhase({ kind: "applying" });
    void applyWorkspaceDelete(environmentId, preview).then((result) => {
      // Even a refused or partial run may have changed something: lists inspect again.
      onChanged();
      if (result === null) {
        onClose();
        return;
      }
      setPhase({ kind: "failed", failure: result });
    });
  };

  const confirm = () => {
    if (!losesWork) {
      apply();
      return;
    }
    Alert.alert(
      "Delete anyway?",
      "Work that exists only in this workspace will be lost. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete anyway", style: "destructive", onPress: apply },
      ],
    );
  };

  const showRetry = failure !== null || view?.status === "error";
  const canConfirm = !busy && preview !== null && !blocked && props.canApply;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-screen"
      contentContainerStyle={{ padding: 20, gap: 18, paddingBottom: 48 }}
    >
      <View className="flex-row items-center gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={failure ? "Close" : "Cancel"}
          disabled={busy}
          className="h-11 min-w-11 items-center justify-center rounded-full px-2 active:bg-subtle disabled:opacity-40"
          onPress={onClose}
        >
          <Text className="font-ryco-medium text-base text-foreground">
            {failure ? "Close" : "Cancel"}
          </Text>
        </Pressable>
        <Text className="flex-1 text-center text-lg font-ryco-bold text-foreground">
          Delete workspace
        </Text>
        <View className="h-11 min-w-11" />
      </View>

      <View className="gap-1">
        <Text className="text-xl font-ryco-medium text-foreground" numberOfLines={2}>
          {target.title}
        </Text>
        {branch !== null && branch !== target.title ? (
          <Text className="font-mono text-xs text-foreground-muted" numberOfLines={1}>
            {branch}
          </Text>
        ) : null}
      </View>

      {failure ? (
        <View
          accessibilityRole="alert"
          className={`gap-1 rounded-2xl border px-4 py-3 ${
            failure.tone === "warning"
              ? "border-warning-border bg-warning-bg"
              : "border-danger-border bg-danger"
          }`}
        >
          <Text
            className={`text-base font-ryco-bold ${
              failure.tone === "warning" ? "text-warning" : "text-danger-foreground"
            }`}
          >
            {failure.title}
          </Text>
          <Text className="text-sm text-foreground-muted">{failure.message}</Text>
          {failure.detail ? (
            <Text className="text-sm text-foreground-muted">{failure.detail}</Text>
          ) : null}
        </View>
      ) : view?.status === "error" ? (
        <ErrorBanner message={view.message} />
      ) : shown === null ? (
        <View className="flex-row items-center gap-2 py-2" accessibilityLiveRegion="polite">
          <ActivityIndicator />
          <Text className="text-sm text-foreground-muted">Inspecting the workspace…</Text>
        </View>
      ) : (
        <View className={`gap-3 ${refreshing ? "opacity-60" : ""}`}>
          <Text className="text-base leading-normal text-foreground-muted">
            {effect?.action}
            {effect?.deletesBranch != null ? (
              <>
                {" and deletes branch "}
                <Text className="font-mono text-sm text-foreground">{effect.deletesBranch}</Text>
              </>
            ) : null}
            .
          </Text>
          {losesWork ? (
            <View className="gap-2 rounded-2xl border border-danger-border bg-danger px-4 py-3">
              <View className="flex-row items-center gap-2">
                <SymbolView
                  name="exclamationmark.triangle"
                  size={15}
                  tintColor={dangerColor as string}
                  type="monochrome"
                />
                <Text className="min-w-0 flex-1 text-sm font-ryco-bold text-danger-foreground">
                  This work exists only here and will be lost:
                </Text>
              </View>
              {lostWork.length > 0 ? (
                <Text className="text-sm text-foreground">
                  {lostWork.map((fact) => fact.label).join(" · ")}
                </Text>
              ) : null}
              {describable && workDescription === null ? (
                <Text className="text-sm text-foreground-muted">Summarizing…</Text>
              ) : workDescription?.text ? (
                <Text className="text-sm leading-normal text-foreground-muted">
                  {workDescription.text}
                </Text>
              ) : null}
            </View>
          ) : null}
          {shown.blockers.length > 0 ? (
            <View accessibilityRole="alert" className="gap-1 rounded-2xl bg-card px-4 py-3">
              <Text className="text-sm font-ryco-bold text-danger-foreground">
                Nothing will change:
              </Text>
              {shown.blockers.map((blocker) => (
                <Text key={blocker} className="text-sm text-foreground-muted">
                  {blocker}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      )}

      {shown && conversationCount > 0 && !failure && view?.status !== "error" ? (
        <View className="flex-row items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3">
          <View className="min-w-0 flex-1">
            <Text className="text-[17px] text-foreground">
              {workspaceReviewConversationCopy(conversationCount, deleteConversations).label}
            </Text>
            <Text className="mt-0.5 text-xs text-foreground-muted">
              {workspaceReviewConversationCopy(conversationCount, deleteConversations).detail}
            </Text>
          </View>
          <Switch
            accessibilityLabel="Also delete the workspace's conversations"
            value={deleteConversations}
            disabled={busy}
            onValueChange={setDeleteConversations}
          />
        </View>
      ) : null}

      {showRetry ? (
        <Pressable
          accessibilityRole="button"
          onPress={retry}
          className="h-12 items-center justify-center rounded-full bg-card px-5 active:bg-card-alt"
        >
          <Text className="text-base font-ryco-bold text-foreground">Retry</Text>
        </Pressable>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canConfirm, busy }}
          disabled={!canConfirm}
          onPress={confirm}
          className="h-12 flex-row items-center justify-center gap-2 rounded-full border border-danger-border bg-danger px-5 active:opacity-80 disabled:opacity-40"
        >
          {busy ? <ActivityIndicator /> : null}
          <Text className="text-base font-ryco-bold text-danger-foreground">
            {workspaceReviewConfirmLabel(losesWork)}
          </Text>
        </Pressable>
      )}
      {!props.canApply && props.accessReason ? (
        <Text className="text-center text-xs text-foreground-muted">{props.accessReason}</Text>
      ) : null}
    </ScrollView>
  );
}
