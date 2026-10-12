import { IconGitFork } from "@tabler/icons-react-native";
import {
  defaultThreadForkBaseRef,
  THREAD_FORK_COPY,
  type ThreadForkAttemptController,
  type ThreadForkAttemptNotice,
  type ThreadForkDestinationKind,
} from "@ryco/client-runtime/state/threads";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { OptionRow } from "../../components/OptionRow";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  deriveForkSheetModel,
  type ForkSheetHandle,
  type ForkSheetRequest,
  type ForkSheetSource,
} from "./forkDestinationModel";

/**
 * "Fork from here": where the fork works and how a new worktree starts, driven by the sheet's
 * controller (the shared `createThreadForkAttemptController`). While a request or the opening of
 * the fork it created is in flight the sheet cannot close (Cancel, swipe and Android back do
 * nothing): its outcome decides what happens next. A closed sheet's unsettled attempt is kept per
 * reply, so reopening it continues with the same key, and a fork created while no sheet showed it
 * opens when the sheet reopens (that opening can be cancelled; a fork deleted since starts a new
 * attempt instead). On success the controller opens the fork.
 */
export function ForkDestinationSheet(props: {
  readonly sheet: ForkSheetHandle | null;
  readonly source: ForkSheetSource;
  /** The thread can fork right now (`isThreadForkOffered`); "Fork" waits otherwise. */
  readonly ready: boolean;
  readonly onClose: () => void;
}) {
  const { sheet, onClose } = props;
  const controller = sheet?.controller ?? null;
  const visible = sheet?.visible === true;

  useEffect(() => {
    if (!controller || !visible) return;
    controller.start();
    return () => controller.stop();
  }, [controller, visible]);

  const requestClose = () => {
    if (controller === null || controller.requestClose()) onClose();
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={requestClose}
    >
      {sheet ? (
        // Kept mounted while the sheet slides away; a new opening brings a new controller.
        <ForkSheetContent
          request={sheet.request}
          controller={sheet.controller}
          source={props.source}
          ready={props.ready}
          onCancel={requestClose}
        />
      ) : null}
    </Modal>
  );
}

export function ForkSheetContent(props: {
  readonly request: ForkSheetRequest;
  readonly controller: ThreadForkAttemptController;
  readonly source: ForkSheetSource;
  readonly ready: boolean;
  readonly onCancel: () => void;
}) {
  const { request, controller } = props;
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const model = deriveForkSheetModel({ source: props.source, snapshot, ready: props.ready });
  const locked = !model.editable;

  const iconColor = String(useThemeColor("--color-icon"));
  const placeholderColor = String(useThemeColor("--color-placeholder"));
  const textColor = String(useThemeColor("--color-foreground"));

  const submit = () => {
    if (model.canSubmit) controller.submit(model.selection);
  };

  const destinationIcon = (kind: ThreadForkDestinationKind): ReactNode =>
    kind === "new-worktree" ? (
      <IconGitFork size={22} color={iconColor} />
    ) : (
      <SymbolView
        name={kind === "new-chat" ? "text.bubble" : "folder"}
        size={22}
        tintColor={iconColor}
        type="monochrome"
      />
    );

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      automaticallyAdjustKeyboardInsets
      className="flex-1 bg-screen"
      contentContainerStyle={{ padding: 20, gap: 18, paddingBottom: 44 }}
    >
      <View className="flex-row items-center gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={THREAD_FORK_COPY.cancel}
          accessibilityState={{ disabled: !model.canDismiss }}
          disabled={!model.canDismiss}
          onPress={props.onCancel}
          className="h-11 min-w-11 items-center justify-center rounded-full px-2 active:bg-subtle disabled:opacity-40"
        >
          <Text className="font-ryco-medium text-base text-foreground">
            {THREAD_FORK_COPY.cancel}
          </Text>
        </Pressable>
        <Text className="flex-1 text-center text-lg font-ryco-bold text-foreground">
          {THREAD_FORK_COPY.dialogTitle}
        </Text>
        <View className="h-11 min-w-11" />
      </View>

      <Text className="font-sans text-base leading-normal text-foreground-muted">
        {THREAD_FORK_COPY.dialogDescription}
      </Text>

      <View className="gap-1 rounded-2xl bg-card px-4 py-3">
        {request.sourceTitle ? (
          <Text className="text-sm font-ryco-bold text-foreground" numberOfLines={1}>
            {request.sourceTitle}
          </Text>
        ) : null}
        {request.excerpt ? (
          <Text className="font-sans text-sm text-foreground-muted" numberOfLines={4}>
            {request.excerpt}
          </Text>
        ) : null}
      </View>

      {model.notice ? <ForkSheetNoticeBanner notice={model.notice} /> : null}

      <View className="gap-2">
        <Text className="px-1 text-sm font-ryco-medium text-foreground-muted">
          {THREAD_FORK_COPY.destinationHeading}
        </Text>
        {model.destinations.map((option) => (
          <OptionRow
            key={option.kind}
            icon={destinationIcon(option.kind)}
            label={option.label}
            detail={option.disabledReason ?? option.description}
            detailLines={3}
            selected={model.destination === option.kind}
            disabled={locked || !option.enabled}
            onPress={() => controller.select({ destination: option.kind })}
          />
        ))}
      </View>

      {model.worktreeStarts.length > 0 ? (
        <View className="gap-2">
          <Text className="px-1 text-sm font-ryco-medium text-foreground-muted">
            {THREAD_FORK_COPY.worktreeStartHeading}
          </Text>
          {model.worktreeStarts.map((option) => (
            <OptionRow
              key={option.kind}
              label={option.label}
              detail={option.disabledReason ?? option.description}
              detailLines={3}
              selected={model.worktreeStart === option.kind}
              disabled={locked || !option.enabled}
              onPress={() => controller.select({ worktreeStart: option.kind })}
            />
          ))}
          {model.showBaseRef ? (
            <View className="gap-1.5">
              <TextInput
                accessibilityLabel={THREAD_FORK_COPY.worktreeStarts.baseRef}
                value={model.baseRef}
                onChangeText={(baseRef) => controller.select({ baseRef })}
                editable={!locked}
                placeholder={defaultThreadForkBaseRef(null)}
                placeholderTextColor={placeholderColor}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="done"
                onSubmitEditing={submit}
                className="min-h-14 rounded-2xl border border-border bg-card px-4 py-3 font-mono text-base"
                style={{ color: textColor }}
              />
              {model.selectionError ? (
                <Text className="px-1 text-xs text-danger-foreground">{model.selectionError}</Text>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}

      <Text className="px-1 text-xs leading-normal text-foreground-muted">
        {THREAD_FORK_COPY.providerNote}
      </Text>

      {model.notReady ? (
        <Text className="px-1 text-xs text-warning">{THREAD_FORK_COPY.connectionChanged}</Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !model.canSubmit, busy: model.busy }}
        disabled={!model.canSubmit}
        onPress={submit}
        className="h-12 items-center justify-center rounded-full bg-primary px-5 active:opacity-80 disabled:opacity-40"
      >
        <Text className="text-base font-ryco-bold text-primary-foreground">
          {model.actionLabel}
        </Text>
      </Pressable>
    </ScrollView>
  );
}

/** An outcome that may have created the fork warns; one that did not is an error. */
function ForkSheetNoticeBanner(props: { readonly notice: ThreadForkAttemptNotice }) {
  const { notice } = props;
  const warning = notice.tone === "warning";
  const textClass = warning ? "text-warning" : "text-danger-foreground";
  return (
    <View
      accessibilityRole="alert"
      className={`gap-1 rounded-2xl border px-3.5 py-3 ${
        warning ? "border-warning-border bg-warning-bg" : "border-danger-border bg-danger"
      }`}
    >
      <Text className={`font-ryco-bold text-sm ${textClass}`}>{notice.title}</Text>
      <Text className={`font-ryco-medium text-sm ${textClass}`}>{notice.message}</Text>
      {notice.detail ? <Text className={`text-xs ${textClass}`}>{notice.detail}</Text> : null}
    </View>
  );
}
