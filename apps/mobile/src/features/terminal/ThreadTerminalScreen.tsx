import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { MenuView, type MenuAction, type NativeActionEvent } from "@react-native-menu/menu";
import { useState } from "react";
import { Modal, Pressable, TextInput, View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { EmptyState } from "../../components/EmptyState";
import { useThemeColor } from "../../lib/useThemeColor";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { TerminalAccessoryKeys } from "./TerminalAccessoryKeys";
import { TERMINAL_COLORS } from "./terminalController";
import { TerminalTabs } from "./TerminalTabs";
import { TerminalWebView } from "./TerminalWebView";
import { normalizeTerminalLabel } from "./terminalSessionModel";
import { useTerminalController } from "./useTerminalController";

function TerminalNotice(props: { readonly message: string }) {
  return (
    <View
      pointerEvents="none"
      className="absolute left-3 right-3 top-3 z-10 flex-row items-center gap-2 rounded-xl border border-white/10 bg-[#181b21]/95 px-3 py-2"
    >
      <View className="h-2 w-2 rounded-full bg-amber-300" />
      <Text className="text-xs font-ryco-medium text-white/80">{props.message}</Text>
    </View>
  );
}

function ToolbarButton(props: {
  readonly icon: "arrow.clockwise" | "ellipsis" | "list.clipboard";
  readonly label: string;
  readonly disabled?: boolean;
  readonly color: string;
  readonly onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={`h-10 w-10 items-center justify-center rounded-full active:bg-subtle-strong ${
        props.disabled ? "opacity-35" : ""
      }`}
    >
      <SymbolView name={props.icon} size={19} tintColor={props.color} type="monochrome" />
    </Pressable>
  );
}

/**
 * A thread's terminal: a full PTY on the node, shown through the contained
 * renderer. Sessions keep running when this screen goes away. Viewers, an
 * offline machine and a hosted session that has not caught up can watch the
 * output, never type into it.
 */
export function ThreadTerminalScreen(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string | null;
  readonly worktreePath: string | null;
}) {
  const { appearance } = useAppearancePreferences();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const iconColor = String(useThemeColor("--color-icon"));
  const placeholderColor = String(useThemeColor("--color-placeholder"));
  const { controller, view } = useTerminalController({
    environmentId: props.environmentId,
    threadId: props.threadId,
    cwd: props.cwd,
    worktreePath: props.worktreePath,
    fontSize: appearance.terminalFontSize,
  });
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const activeTab = view.tabs.find((tab) => tab.active) ?? null;
  const busy = view.busyAction !== null;
  const canMutate = view.hasSession && view.mutationReady && !busy;

  const actions: MenuAction[] = [
    { id: "rename", title: "Rename", attributes: { disabled: !view.hasSession } },
    { id: "copy", title: "Copy selection", attributes: { disabled: !view.hasSession } },
    { id: "paste", title: "Paste", attributes: { disabled: !view.writable || view.pasting } },
    { id: "clear", title: "Clear output", attributes: { disabled: !canMutate } },
    { id: "restart", title: "Restart process", attributes: { disabled: !canMutate } },
    {
      id: "close",
      title: "Close session",
      attributes: { disabled: !canMutate, destructive: true },
    },
    {
      id: "delete",
      title: "Close and delete history",
      attributes: { disabled: !canMutate, destructive: true },
    },
  ];

  const confirmClose = (deleteHistory: boolean) => {
    const running = view.activeStatus === "running" || view.activeStatus === "starting";
    if (!deleteHistory && !running) {
      void controller.close(false);
      return;
    }
    showConfirmDialog({
      title: deleteHistory ? "Close and delete terminal history?" : "Close running terminal?",
      message: deleteHistory
        ? "The process stops and the machine deletes this terminal's history."
        : "The process in this terminal stops on the machine.",
      confirmText: deleteHistory ? "Close and Delete" : "Close",
      destructive: true,
      onConfirm: () => void controller.close(deleteHistory),
    });
  };

  const onMenuAction = ({ nativeEvent }: NativeActionEvent) => {
    switch (nativeEvent.event) {
      case "rename":
        setRenameDraft(activeTab?.label ?? "");
        return;
      case "copy":
        controller.copySelection();
        return;
      case "paste":
        void controller.paste();
        return;
      case "clear":
        void controller.clear();
        return;
      case "restart":
        void controller.restart();
        return;
      case "close":
        confirmClose(false);
        return;
      case "delete":
        confirmClose(true);
        return;
    }
  };

  const state = view.screenState;
  const renderBody = () => {
    if (state.kind === "unavailable") {
      return (
        <View className="flex-1 items-center justify-center bg-screen px-5">
          <EmptyState variant="plain" title="Terminal unavailable" detail={state.message} />
        </View>
      );
    }
    if (state.kind === "empty") {
      return (
        <View className="flex-1 items-center justify-center bg-screen px-5">
          <EmptyState
            variant="plain"
            title="Open a terminal"
            detail={
              state.readOnly
                ? "Your access to this machine is read-only, so you cannot start a terminal."
                : "Start a shell in this task's workspace. It keeps running on the machine when you leave."
            }
            {...(state.canStart
              ? { actionLabel: "Start terminal", onAction: controller.startTerminal }
              : {})}
          />
        </View>
      );
    }
    if (state.kind === "renderer-failed") {
      return (
        <View className="flex-1 items-center justify-center bg-screen px-5">
          <EmptyState
            variant="plain"
            title="Terminal view stopped"
            detail="The process may still be running on the machine. Reload the view to reconnect to it without restarting it."
            actionLabel="Reload terminal view"
            onAction={controller.reloadRenderer}
          />
        </View>
      );
    }
    const notice =
      state.kind === "starting"
        ? "Starting terminal…"
        : state.kind === "hydrating"
          ? "Restoring terminal output…"
          : state.kind === "renderer-loading"
            ? "Loading terminal…"
            : state.kind === "waiting"
              ? state.notice
              : state.connectionNotice;
    return (
      <View className="flex-1" style={{ backgroundColor: TERMINAL_COLORS.background }}>
        <TerminalWebView
          key={view.rendererGeneration}
          generation={view.rendererGeneration}
          onSender={controller.attachRenderer}
          onMessage={controller.onRendererMessage}
          onFailure={controller.onRendererFailure}
        />
        {notice ? <TerminalNotice message={notice} /> : null}
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      behavior="padding"
      automaticOffset
      style={{ flex: 1 }}
      className="bg-screen"
    >
      <View className="h-12 flex-row items-center gap-1 border-b border-border bg-screen px-3">
        <View className="min-w-0 flex-1 flex-row items-center gap-2">
          <SymbolView name="terminal" size={17} tintColor={iconColor} type="monochrome" />
          <Text numberOfLines={1} className="text-sm font-ryco-bold text-foreground">
            Terminal
          </Text>
          {state.kind === "terminal" ? (
            <Text className="text-xs text-foreground-muted">{view.activeStatus}</Text>
          ) : null}
        </View>
        <ToolbarButton
          icon="list.clipboard"
          label="Paste"
          color={iconColor}
          disabled={!view.writable || view.pasting}
          onPress={() => void controller.paste()}
        />
        <ToolbarButton
          icon="arrow.clockwise"
          label="Refresh terminal output"
          color={iconColor}
          disabled={!view.hasSession || busy}
          onPress={controller.refresh}
        />
        <MenuView actions={actions} onPressAction={onMenuAction}>
          <ToolbarButton icon="ellipsis" label="Terminal actions" color={iconColor} />
        </MenuView>
      </View>

      {view.error ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${view.error.title}. Dismiss.`}
          onPress={controller.dismissError}
          className="border-b border-danger-border bg-danger px-4 py-2"
        >
          <Text className="text-sm font-ryco-bold text-danger-foreground">{view.error.title}</Text>
          <Text className="mt-0.5 text-xs text-danger-foreground">{view.error.detail}</Text>
        </Pressable>
      ) : null}

      {view.hasSession ? (
        <TerminalTabs
          tabs={view.tabs}
          canAdd={view.canCreateTerminal}
          onSelect={controller.selectTerminal}
          onAdd={() => void controller.createTerminal()}
        />
      ) : null}

      {renderBody()}

      {view.hasSession ? (
        <TerminalAccessoryKeys
          disabled={!view.writable}
          controlArmed={view.controlArmed}
          bottomInset={keyboardVisible ? 0 : insets.bottom}
          onToggleControl={controller.toggleControl}
          onInput={controller.sendKeys}
          onDismissKeyboard={controller.dismissKeyboard}
        />
      ) : null}

      <Modal
        visible={renameDraft !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setRenameDraft(null)}
      >
        <View className="flex-1 items-center justify-center bg-black/40 px-6">
          <View className="w-full max-w-md gap-4 rounded-3xl bg-card p-5">
            <Text className="text-lg font-ryco-bold text-foreground">Rename terminal</Text>
            <TextInput
              autoFocus
              value={renameDraft ?? ""}
              onChangeText={setRenameDraft}
              maxLength={64}
              selectTextOnFocus
              autoCorrect={false}
              autoCapitalize="none"
              placeholder="Terminal name"
              placeholderTextColor={placeholderColor}
              className="min-h-12 rounded-2xl border border-input-border bg-input px-4 font-sans text-base text-foreground"
            />
            <View className="flex-row justify-end gap-2">
              <Pressable
                accessibilityRole="button"
                onPress={() => setRenameDraft(null)}
                className="h-11 items-center justify-center rounded-full bg-subtle px-5"
              >
                <Text className="text-sm font-ryco-bold text-foreground">Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  if (view.activeTerminalId !== null) {
                    controller.renameTerminal(
                      view.activeTerminalId,
                      normalizeTerminalLabel(renameDraft ?? "", activeTab?.label ?? "Terminal"),
                    );
                  }
                  setRenameDraft(null);
                }}
                className="h-11 items-center justify-center rounded-full bg-primary px-5"
              >
                <Text className="text-sm font-ryco-bold text-primary-foreground">Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}
