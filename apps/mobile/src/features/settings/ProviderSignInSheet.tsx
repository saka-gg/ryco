import type {
  EnvironmentId,
  ProviderInstanceId,
  ProviderSignInState,
  ServerProvider,
} from "@ryco/contracts";
import { isUnknownUnionMember } from "@ryco/contracts/base-schemas";
import { providerSignInSettled } from "@ryco/shared/providerSignIn";
import {
  describeProviderSignIn,
  formatProviderSignInCountdown,
  getProviderSignInController,
  isProviderSignInPageUrl,
  isProviderSignInTerminalWaiting,
  providerSignInOutcome,
  type ProviderSignInApi,
  type ProviderSignInController,
} from "@ryco/client-runtime/state/providerSignIn";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  type TextInput,
  View,
} from "react-native";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { readRpcClient, subscribeEnvironmentApis } from "../../connection/environmentApi";
import { mobileHostedConnectionScopes } from "../../connection/hostedConnectionScopes";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { lastHttpsUrl, type ProviderSignInAccess } from "./providerAccountsModel";

export interface ProviderSignInTarget {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly nodeLabel: string;
  readonly displayName: string;
}

/** The sign-in methods of the app's connection to the node, following reconnects. */
function useSignInApi(environmentId: EnvironmentId): ProviderSignInApi | null {
  const read = () => readRpcClient(environmentId)?.providerSignIn ?? null;
  return useSyncExternalStore(subscribeEnvironmentApis, read, read);
}

function SheetButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly primary?: boolean;
  readonly busy?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled === true, busy: props.busy === true }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={`h-12 flex-1 items-center justify-center rounded-full px-5 active:opacity-80 disabled:opacity-40 ${props.primary ? "bg-primary" : "border border-border bg-card"}`}
    >
      <Text
        className={`text-base font-ryco-bold ${props.primary ? "text-primary-foreground" : "text-foreground"}`}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function Note(props: { readonly children: string; readonly busy?: boolean }) {
  return (
    <View className="flex-row items-center gap-2">
      {props.busy ? <ActivityIndicator size="small" /> : null}
      <Text className="flex-1 font-sans text-sm leading-relaxed text-foreground-muted">
        {props.children}
      </Text>
    </View>
  );
}

function Countdown(props: { readonly expiresAt: string | null }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNowMs(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);
  const remaining = formatProviderSignInCountdown(props.expiresAt, nowMs);
  if (remaining === null) return null;
  return (
    <Text className="font-sans text-sm text-foreground-muted">
      Expires in <Text className="font-mono text-sm text-foreground-muted">{remaining}</Text>
    </Text>
  );
}

function DeviceCode(props: { readonly verificationUrl: string; readonly userCode: string }) {
  const [copied, setCopied] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const opensHere = isProviderSignInPageUrl(props.verificationUrl);
  return (
    <View className="gap-3">
      <Text className="font-sans text-base leading-relaxed text-foreground">
        Open{" "}
        <Text selectable className="font-mono text-sm text-foreground">
          {props.verificationUrl}
        </Text>{" "}
        and enter this code:
      </Text>
      <Text
        selectable
        accessibilityLabel="Sign-in code"
        className="self-start rounded-2xl border border-border bg-card px-4 py-3 font-mono text-2xl tracking-widest text-foreground"
      >
        {props.userCode}
      </Text>
      <View className="flex-row gap-2">
        <SheetButton
          label={copied ? "Copied" : "Copy"}
          onPress={() => {
            copyTextWithHaptic(props.userCode, { target: "sign-in code" });
            setCopied(true);
          }}
        />
        {opensHere ? (
          <SheetButton
            primary
            label="Open sign-in page"
            onPress={() => {
              setOpenFailed(false);
              Linking.openURL(props.verificationUrl).catch(() => setOpenFailed(true));
            }}
          />
        ) : null}
      </View>
      {openFailed ? (
        <ErrorBanner message="Could not open the sign-in page. Open the address above in a browser and enter the code." />
      ) : null}
    </View>
  );
}

/**
 * A terminal sign-in as plain text: the node's output without escapes, the page it asks to open,
 * and one line to answer its prompts with, sent with Return.
 */
function TerminalSignIn(props: { readonly controller: ProviderSignInController }) {
  const { controller } = props;
  const transcript = useSyncExternalStore(
    (listener) => controller.onOutput(() => listener()),
    controller.transcriptText,
    controller.transcriptText,
  );
  const link = lastHttpsUrl(transcript);
  const output = useRef<ScrollView>(null);
  const input = useRef<TextInput>(null);
  const line = useRef("");
  const send = () => {
    controller.sendLine(line.current);
    line.current = "";
    input.current?.clear();
  };
  return (
    <View className="gap-3">
      <ScrollView
        ref={output}
        style={{ maxHeight: 320 }}
        className="rounded-2xl border border-border bg-card"
        contentContainerStyle={{ padding: 12 }}
        onContentSizeChange={() => output.current?.scrollToEnd({ animated: false })}
      >
        <Text
          selectable
          accessibilityLabel="Sign-in output"
          className="font-mono text-xs leading-5 text-foreground"
        >
          {transcript.length > 0 ? transcript : "Waiting for the sign-in to print…"}
        </Text>
      </ScrollView>
      {link !== null ? (
        <SheetButton primary label="Open link" onPress={() => void Linking.openURL(link)} />
      ) : null}
      <View className="flex-row items-center gap-2">
        <AppTextInput
          ref={input}
          accessibilityLabel="Reply to the sign-in"
          placeholder="Type a reply, then Return"
          onChangeText={(text) => {
            line.current = text;
          }}
          onSubmitEditing={send}
          submitBehavior="submit"
          returnKeyType="send"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect={false}
          spellCheck={false}
          importantForAutofill="no"
          className="flex-1 font-mono text-sm"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send reply"
          onPress={send}
          className="h-12 items-center justify-center rounded-full border border-border bg-card px-4 active:opacity-80"
        >
          <Text className="text-base font-ryco-bold text-foreground">Send</Text>
        </Pressable>
      </View>
    </View>
  );
}

function idleText(state: ProviderSignInState, displayName: string, nodeLabel: string): string {
  const runs = `Runs ${displayName}’s sign-in on ${nodeLabel}.`;
  return state.method === "terminal"
    ? `${runs} Answer its prompts here.`
    : `${runs} The page opens on this device.`;
}

function WaitingBody(props: {
  readonly state: ProviderSignInState;
  readonly controller: ProviderSignInController;
}) {
  const interaction = props.state.interaction;
  return (
    <View className="gap-3">
      {interaction !== null &&
      !isUnknownUnionMember(interaction) &&
      interaction.type === "deviceCode" ? (
        <DeviceCode
          key={props.state.flowId}
          verificationUrl={interaction.verificationUrl}
          userCode={interaction.userCode}
        />
      ) : isProviderSignInTerminalWaiting(props.state) ? (
        <TerminalSignIn controller={props.controller} />
      ) : (
        <Note>
          This sign-in needs a newer Ryco on this device. Update the app to continue, or cancel the
          sign-in.
        </Note>
      )}
      <Countdown expiresAt={props.state.expiresAt} />
    </View>
  );
}

/**
 * Signs one provider instance in on its node, driven by the shared controller: the node runs the
 * provider's own login and this shows what to do with it, a device code to enter on a page, or a
 * terminal's prompts. The flow is the node's, so closing this, or leaving the app for the
 * browser, does not end it; opening it again shows how it is going.
 */
export function ProviderSignInSheet(props: {
  readonly target: ProviderSignInTarget;
  /** The instance as its node last reported it; absent once it stops reporting it. */
  readonly provider: ServerProvider | undefined;
  readonly instanceEnabled: boolean;
  readonly access: ProviderSignInAccess;
  readonly onClose: () => void;
}) {
  const { environmentId, instanceId, nodeLabel, displayName } = props.target;
  const api = useSignInApi(environmentId);
  const controller = getProviderSignInController(environmentId, instanceId);
  const follows = props.access.allowed && api !== null;

  // Keeps a Hub node's connection while the sheet is open, as any mounted provider surface does.
  useEffect(
    () =>
      mobileHostedConnectionScopes.retain(environmentId, {
        type: "provider-status",
        instanceId,
      }),
    [environmentId, instanceId],
  );
  useEffect(() => {
    if (!follows || api === null) return;
    return controller.attach(api);
  }, [api, controller, follows]);

  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const state = follows ? snapshot.state : null;
  const view = describeProviderSignIn({
    snapshot,
    state,
    nodeLabel,
    blockedReason: props.access.reason,
    connected: api !== null,
    canManage: true,
    instanceEnabled: props.instanceEnabled,
  });
  // Named by its label, never its email: no other screen of the app shows a provider's email.
  const label = props.provider?.auth.label;
  // The node shows a finished sign-in for a while, then idles; the account stays.
  const signedIn =
    state !== null &&
    (state.phase === "succeeded" ||
      (state.phase === "idle" &&
        props.provider !== undefined &&
        // Settled, not only reported: Grok never names its account, so a ready one is signed in.
        providerSignInSettled(props.provider)));

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <View className="flex-1 bg-screen">
          <View className="flex-row items-center gap-3 px-5 pt-5 pb-2">
            <View className="min-w-0 flex-1">
              <Text className="text-lg font-ryco-bold text-foreground">
                Sign in to {displayName}
              </Text>
              <Text className="font-sans text-sm text-foreground-muted">On {nodeLabel}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close sign-in"
              onPress={props.onClose}
              className="h-11 min-w-16 items-center justify-center rounded-full active:bg-subtle"
            >
              <Text className="text-base font-ryco-medium text-foreground">Done</Text>
            </Pressable>
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              paddingHorizontal: 20,
              paddingTop: 8,
              paddingBottom: 32,
              gap: 16,
            }}
          >
            {view.unavailable !== null ? (
              <Note>{view.unavailable}</Note>
            ) : view.followFailed ? null : state === null ? (
              <Note busy>{`Checking sign-in on ${nodeLabel}…`}</Note>
            ) : signedIn ? (
              <Text className="font-sans text-base text-foreground">
                {label ? `Signed in as ${label}.` : "Signed in."}
              </Text>
            ) : state.phase === "idle" ? (
              <Note>
                {state.method === null
                  ? (state.unavailableReason ??
                    "Sign-in from Ryco is not available for this instance.")
                  : `${snapshot.interrupted ? "Sign-in was interrupted. Start again. " : ""}${idleText(state, displayName, nodeLabel)}`}
              </Note>
            ) : state.phase === "starting" ? (
              <Note busy>{`Starting the sign-in on ${nodeLabel}…`}</Note>
            ) : state.phase === "waiting" ? (
              <WaitingBody state={state} controller={controller} />
            ) : state.phase === "verifying" ? (
              <Note busy>Checking the account…</Note>
            ) : (
              <Text className="font-sans text-base text-foreground">
                {providerSignInOutcome(state)}
              </Text>
            )}

            {view.error !== null ? <ErrorBanner message={view.error} /> : null}

            <View className="flex-row gap-2">
              {view.running ? (
                <SheetButton
                  label="Cancel sign-in"
                  disabled={!view.canCancel}
                  busy={view.pending === "cancel"}
                  onPress={() => void controller.cancel()}
                />
              ) : !signedIn ? (
                <SheetButton
                  primary
                  label={view.startLabel}
                  disabled={!view.canStart && !view.canRetryFollow}
                  busy={view.pending === "start"}
                  onPress={() => {
                    if (view.canRetryFollow) controller.retryFollowing();
                    else void controller.start();
                  }}
                />
              ) : null}
            </View>
            {view.running ? (
              <Note>{`The sign-in runs on ${nodeLabel}. Closing this does not stop it.`}</Note>
            ) : null}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
